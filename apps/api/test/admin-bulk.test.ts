/**
 * 20 Oct: a balance adjustment for many players at once (one approval, all or
 * none), and making an existing player an admin from the Players screen.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { hashPassword, issueTicket } from '../src/admin/session'
import { adminUsers, auditLog, ledger, notifications, users, type AdminRole } from '../src/db/schema'
import { credit, member as open } from './fixtures'
import { initData, telegramId, testApp } from './helpers'

const { http, db, ctx } = testApp()

async function signIn(role: AdminRole) {
  const tg = telegramId()
  const [a] = await db
    .insert(adminUsers)
    .values({ name: `Bulk ${role}`, username: `bulk_${tg}`, telegramUsername: `bulk${tg}`, telegramId: tg, role, passwordHash: await hashPassword('x'.repeat(16)) })
    .returning({ id: adminUsers.id })
  const ticket = await issueTicket(ctx, a!.id, tg)
  const res = await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: tg }) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { authorization: `Bearer ${res.body.token as string}` }
}

const balances = async (ids: string[]) =>
  Object.fromEntries((await db.select({ id: users.id, b: users.balanceCache }).from(users).where(inArray(users.id, ids))).map((r) => [r.id, r.b]))

describe('bulk balance adjustment', () => {
  it('a super admin credits every selected player at once, and the bot tells each of them', async () => {
    const boss = await signIn('super_admin')
    const players = [await open(http), await open(http), await open(http)]
    const ids = players.map((p) => p.userId)
    const res = await http.post('/admin/v1/users/bulk-adjust').set(boss).send({ userIds: ids, raffs: 250, reason: 'Launch goodwill' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.action).toBe('balance_adjustment_bulk')
    expect(res.body.result).toMatchObject({ players: 3, raffsEach: 250, raffsTotal: 750, playersTold: 3 })
    expect(res.body.summary).toMatch(/^Credit 250 Raffs each to 3 players \(750 Raffs in all\): @/)
    expect(await balances(ids)).toEqual(Object.fromEntries(ids.map((id) => [id, 250])))
    const msgs = await db.select().from(notifications).where(and(inArray(notifications.userId, ids), eq(notifications.kind, 'credit')))
    expect(msgs).toHaveLength(3)
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, 'direct.balance_adjustment_bulk'), eq(auditLog.targetId, res.body.id)))
    expect(audit).toBeDefined()
  })

  it('from another role it waits for a second admin, then applies to all', async () => {
    const finance = await signIn('finance')
    const approver = await signIn('super_admin')
    const players = [await open(http), await open(http)]
    const ids = players.map((p) => p.userId)
    const asked = await http.post('/admin/v1/users/bulk-adjust').set(finance).send({ userIds: ids, raffs: 40, reason: 'Missed promo' })
    expect(asked.status, JSON.stringify(asked.body)).toBe(202)
    expect(await balances(ids)).toEqual(Object.fromEntries(ids.map((id) => [id, 0])))
    const ok = await http.post(`/admin/v1/approvals/${asked.body.id}/approve`).set(approver).send({})
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await balances(ids)).toEqual(Object.fromEntries(ids.map((id) => [id, 40])))
  })

  it('a debit that would take anyone below zero changes nobody and names who is short', async () => {
    const boss = await signIn('super_admin')
    const rich = await open(http)
    const poor = await open(http)
    await credit(db, rich.userId, 500)
    await credit(db, poor.userId, 30)
    const res = await http.post('/admin/v1/users/bulk-adjust').set(boss).send({ userIds: [rich.userId, poor.userId], raffs: -100, reason: 'Clawback' })
    expect(res.status).toBe(409)
    expect(res.body.error.message).toContain(`@${poor.username} (30)`)
    expect(await balances([rich.userId, poor.userId])).toEqual({ [rich.userId]: 500, [poor.userId]: 30 })
    const rows = await db.select().from(ledger).where(and(inArray(ledger.userId, [rich.userId, poor.userId]), eq(ledger.raffs, -100)))
    expect(rows).toHaveLength(0)

    const fine = await http.post('/admin/v1/users/bulk-adjust').set(boss).send({ userIds: [rich.userId], raffs: -100, reason: 'Clawback' })
    expect(fine.status, JSON.stringify(fine.body)).toBe(200)
    expect(fine.body.result.playersTold).toBe(0)
  })

  it('refuses unknown players, duplicates, a typo-sized total and roles without the permission', async () => {
    const boss = await signIn('super_admin')
    const p = await open(http)
    expect((await http.post('/admin/v1/users/bulk-adjust').set(boss).send({ userIds: [p.userId, randomUUID()], raffs: 5, reason: 'x test' })).status).toBe(404)
    expect((await http.post('/admin/v1/users/bulk-adjust').set(boss).send({ userIds: [p.userId, p.userId], raffs: 5, reason: 'x test' })).status).toBe(400)
    const many = Array.from({ length: 20 }, () => randomUUID())
    const big = await http.post('/admin/v1/users/bulk-adjust').set(boss).send({ userIds: many, raffs: 1_000_000, reason: 'typo' })
    expect(big.status).toBe(400)
    const support = await signIn('support')
    expect((await http.post('/admin/v1/users/bulk-adjust').set(support).send({ userIds: [p.userId], raffs: 5, reason: 'x test' })).status).toBe(403)
  })
})

describe('make a player an admin', () => {
  it('binds the new admin to the player Telegram id at once and shows it on the player', async () => {
    const boss = await signIn('super_admin')
    const player = await open(http)
    const res = await http.post(`/admin/v1/users/${player.userId}/make-admin`).set(boss).send({ name: 'Ada Obi', username: `ada_${player.telegramId}`, role: 'support' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.password).toMatch(/^[a-zA-Z0-9]{16}$/)
    expect(res.body.admin).toMatchObject({ name: 'Ada Obi', role: 'support', telegramBound: true, telegramUsername: player.username.toLowerCase() })
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, res.body.admin.id))
    expect(row?.telegramId).toBe(player.telegramId)

    const detail = await http.get(`/admin/v1/users/${player.userId}`).set(boss)
    expect(detail.body.admin).toEqual({ name: 'Ada Obi', role: 'support', status: 'active' })

    const again = await http.post(`/admin/v1/users/${player.userId}/make-admin`).set(boss).send({ name: 'Ada Again', username: `ada2_${player.telegramId}`, role: 'viewer' })
    expect(again.status).toBe(400)
    expect(again.body.error.message).toContain('already the admin Ada Obi')
  })

  it('is for super admins only', async () => {
    const finance = await signIn('finance')
    const player = await open(http)
    const res = await http.post(`/admin/v1/users/${player.userId}/make-admin`).set(finance).send({ name: 'Nope', username: `nope_${player.telegramId}`, role: 'viewer' })
    expect(res.status).toBe(403)
  })
})
