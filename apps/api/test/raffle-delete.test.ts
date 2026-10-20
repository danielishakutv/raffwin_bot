/**
 * 20 Oct: admins can delete old raffles. Delete hides a raffle from the admin
 * list and the app and keeps every record: an open raffle is refunded first,
 * entrants keep it in their history, and it can be restored.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Entry, Raffle } from '@raffwin/shared'
import type { AdminRaffle } from '@raffwin/shared/admin-types'
import { hashPassword, issueTicket } from '../src/admin/session'
import { adminUsers, auditLog, broadcasts, ledger, raffles, users, type AdminRole } from '../src/db/schema'
import { newDrawSeed, settleRaffle } from '../src/services/draw'
import { forgetRaffles } from '../src/lib/shared-cache'
import { createRaffle, credit, member as open } from './fixtures'
import { contactProof, initData, nigerianPhone, telegramId, testApp } from './helpers'

const { http, db, ctx } = testApp()

async function signIn(role: AdminRole) {
  const tg = telegramId()
  const [a] = await db
    .insert(adminUsers)
    .values({ name: `Delete ${role}`, username: `del_${tg}`, telegramUsername: `del${tg}`, telegramId: tg, role, passwordHash: await hashPassword('x'.repeat(16)) })
    .returning({ id: adminUsers.id })
  const ticket = await issueTicket(ctx, a!.id, tg)
  const res = await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: tg }) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { authorization: `Bearer ${res.body.token as string}` }
}

async function player() {
  const m = await open(http)
  const res = await m.put('/v1/phone', { contactProof: contactProof(m.telegramId, nigerianPhone().slice(1)) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return m
}

async function buy(m: Awaited<ReturnType<typeof player>>, raffleId: string, qty: number) {
  await credit(db, m.userId, qty * 10)
  const res = await m.post('/v1/entries', { raffleId, qty, idempotencyKey: randomUUID() })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
}

const balanceOf = async (userId: string) => (await db.select({ b: users.balanceCache }).from(users).where(eq(users.id, userId)))[0]?.b ?? 0
const adminList = async (auth: { authorization: string }, query = '') =>
  (await http.get(`/admin/v1/raffles${query}`).set(auth)).body as AdminRaffle[]
const playerList = async (m: Awaited<ReturnType<typeof player>>) => ((await m.get('/v1/raffles')).body as Raffle[]).map((r) => r.id)

describe('deleting a raffle', () => {
  it('a draft goes at once for a raffle manager, moves to Deleted, and the row can never really be removed', async () => {
    const manager = await signIn('raffle_manager')
    const draft = await createRaffle(db, { status: 'draft', openedAt: null })
    const res = await http.post(`/admin/v1/raffles/${draft.id}/delete`).set(manager).send({ reason: 'Old test draft' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ id: draft.id, status: 'draft', deletedBy: 'Delete raffle_manager' })

    expect((await adminList(manager)).some((r) => r.id === draft.id)).toBe(false)
    expect((await adminList(manager, '?status=deleted')).find((r) => r.id === draft.id)?.deletedAt).toBeTruthy()
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, draft.id), eq(auditLog.action, 'raffle.delete')))
    expect(audit?.after).toMatchObject({ reason: 'Old test draft' })

    // Deleted means hidden: nothing can publish or edit it until it is restored
    const publish = await http.post(`/admin/v1/raffles/${draft.id}/open`).set(manager).send({})
    expect(publish.status).toBe(400)
    expect(publish.body.error.message).toContain('Restore it first')
    // The trigger fires before any foreign key is checked, so this is the trigger refusing, not the prizes pointing at it
    await expect(db.execute(sql`delete from raffles where id = ${draft.id}`)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/raffles is append-only: DELETE refused/) }) })
  })

  it('an open raffle is refunded in full first, the entrants told, and their history keeps it', async () => {
    const boss = await signIn('super_admin')
    const raffle = await createRaffle(db, { entryPriceRaffs: 10 })
    const a = await player()
    const b = await player()
    await buy(a, raffle.id, 3)
    await buy(b, raffle.id, 1)
    expect(await balanceOf(a.userId)).toBe(0)

    const res = await http.post(`/admin/v1/raffles/${raffle.id}/delete`).set(boss).send({ reason: 'Supplier cannot deliver' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ action: 'raffle_delete', status: 'approved' })
    expect(res.body.result).toMatchObject({ statusBefore: 'open', entriesRefunded: 2, raffsRefunded: 40, direct: true })

    expect(await balanceOf(a.userId)).toBe(30)
    expect(await balanceOf(b.userId)).toBe(10)
    const refunds = await db.select().from(ledger).where(and(eq(ledger.userId, a.userId), eq(ledger.type, 'refund')))
    expect(refunds.map((r) => r.raffs)).toEqual([30])
    const [row] = await db.select().from(raffles).where(eq(raffles.id, raffle.id))
    expect(row).toMatchObject({ status: 'cancelled' })
    expect(row?.deletedAt).toBeTruthy()
    const told = await db.select().from(broadcasts).where(and(eq(broadcasts.refId, raffle.id), eq(broadcasts.kind, 'raffle_cancelled')))
    expect(told).toHaveLength(1)

    // Gone from the app, still in the player's entries, marked refunded
    expect(await playerList(a)).not.toContain(raffle.id)
    const mine = ((await a.get('/v1/entries')).body as Entry[]).filter((e) => e.raffleId === raffle.id)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.raffle).toMatchObject({ prizeName: 'Tecno Spark 20', kind: 'phone', refunded: true })

    // Deleting twice is refused; restoring brings it back as cancelled and charges nobody
    expect((await http.post(`/admin/v1/raffles/${raffle.id}/delete`).set(boss).send({ reason: 'Again please' })).status).toBe(400)
    const back = await http.post(`/admin/v1/raffles/${raffle.id}/restore`).set(boss).send({ reason: 'Deleted by mistake' })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(back.body).toMatchObject({ status: 'cancelled', deletedAt: null })
    expect(await balanceOf(a.userId)).toBe(30)
  })

  it('anyone but a super admin only asks; a second admin approving does the refund and delete', async () => {
    const manager = await signIn('raffle_manager')
    const approver = await signIn('super_admin')
    const raffle = await createRaffle(db, { entryPriceRaffs: 10 })
    const a = await player()
    await buy(a, raffle.id, 2)

    const asked = await http.post(`/admin/v1/raffles/${raffle.id}/delete`).set(manager).send({ reason: 'Wrong prize photo' })
    expect(asked.status, JSON.stringify(asked.body)).toBe(202)
    expect(asked.body.summary).toBe('Delete "Tecno Spark 20" and refund 2 entries')
    expect(await playerList(a)).toContain(raffle.id)
    expect(await balanceOf(a.userId)).toBe(0)

    const ok = await http.post(`/admin/v1/approvals/${asked.body.id}/approve`).set(approver).send({})
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await balanceOf(a.userId)).toBe(20)
    forgetRaffles(ctx.cache)
    expect(await playerList(a)).not.toContain(raffle.id)
  })

  it('a drawn raffle leaves the app for everyone except the players who entered it', async () => {
    const boss = await signIn('super_admin')
    const { seed, commitment } = newDrawSeed()
    const raffle = await createRaffle(db, { entryPriceRaffs: 10, drawSeed: seed, seedCommitment: commitment })
    const entrant = await player()
    const outsider = await player()
    await buy(entrant, raffle.id, 5)
    await db.update(raffles).set({ deadline: new Date(Date.now() - 1000) }).where(eq(raffles.id, raffle.id))
    expect(await settleRaffle(ctx, raffle.id)).toBe('drawn')

    const res = await http.post(`/admin/v1/raffles/${raffle.id}/delete`).set(boss).send({ reason: 'Clearing old raffles' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.result).toMatchObject({ statusBefore: 'drawn', entriesRefunded: 0 })
    expect(await balanceOf(entrant.userId)).toBeGreaterThan(0) // the Raffs prizes it won stay

    forgetRaffles(ctx.cache)
    expect(await playerList(outsider)).not.toContain(raffle.id)
    expect((await outsider.get(`/v1/raffles/${raffle.id}`)).status).toBe(404)
    // The entrant still has it, winners and all, so My entries and My wins are unchanged
    expect(await playerList(entrant)).toContain(raffle.id)
    const detail = await entrant.get(`/v1/raffles/${raffle.id}`)
    expect(detail.status).toBe(200)
    expect((detail.body as Raffle).winners.every((w) => w.username === entrant.username)).toBe(true)
    const mine = ((await entrant.get('/v1/entries')).body as Entry[]).find((e) => e.raffleId === raffle.id)
    expect(mine?.raffle?.refunded).toBe(false)

    const back = await http.post(`/admin/v1/raffles/${raffle.id}/restore`).set(boss).send({ reason: 'Show it again' })
    expect(back.status).toBe(200)
    forgetRaffles(ctx.cache)
    expect(await playerList(outsider)).toContain(raffle.id)
  })

  it('is refused while the draw owns an open raffle, and for a viewer', async () => {
    const boss = await signIn('super_admin')
    const viewer = await signIn('viewer')
    const due = await createRaffle(db, { deadline: new Date(Date.now() - 1000) })
    const res = await http.post(`/admin/v1/raffles/${due.id}/delete`).set(boss).send({ reason: 'Too late now' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('draw is running')
    const fresh = await createRaffle(db)
    expect((await http.post(`/admin/v1/raffles/${fresh.id}/delete`).set(viewer).send({ reason: 'Not allowed' })).status).toBe(403)
  })
})
