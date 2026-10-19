/**
 * 19 Oct, second round: an admin credit is announced to the player by the bot,
 * and "Run again" copies any raffle into a new draft without touching it.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { AdminRaffle } from '@raffwin/shared/admin-types'
import { hashPassword, issueTicket } from '../src/admin/session'
import { adminUsers, auditLog, notifications, rafflePrizes, raffles, type AdminRole } from '../src/db/schema'
import { newDrawSeed, settleRaffle } from '../src/services/draw'
import { createRaffle, credit, member as open } from './fixtures'
import { contactProof, initData, nigerianPhone, telegramId, testApp } from './helpers'

const { http, db, ctx } = testApp({ PUBLIC_APP_URL: 'https://raffwintest.example/' })

async function signIn(role: AdminRole) {
  const tg = telegramId()
  const [a] = await db
    .insert(adminUsers)
    .values({ name: `Reuse ${role}`, username: `reuse_${tg}`, telegramUsername: `reuse${tg}`, telegramId: tg, role, passwordHash: await hashPassword('x'.repeat(16)) })
    .returning({ id: adminUsers.id })
  const ticket = await issueTicket(ctx, a!.id, tg)
  const res = await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: tg }) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { authorization: `Bearer ${res.body.token as string}` }
}

const creditsFor = (userId: string) => db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, 'credit')))

describe('a credit from an admin', () => {
  it('a super admin credit lands at once and the bot tells the player; a debit says nothing', async () => {
    const boss = await signIn('super_admin')
    const player = await open(http)
    const res = await http.post(`/admin/v1/users/${player.userId}/adjust`).set(boss).send({ raffs: 1500, reason: 'Prize top-up' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.result).toMatchObject({ playerTold: true, balanceAfter: 1500 })
    const [msg] = await creditsFor(player.userId)
    expect(msg?.text).toBe('<b>You received 1,500 Raffs from Raffle Win</b>\n\nThey are already in your balance, which is now 1,500 Raffs. Use them to enter a raffle.')
    expect(msg?.buttons).toEqual([[{ text: 'Open my wallet', webApp: 'https://raffwintest.example/#/wallet' }]])
    expect(msg?.telegramId).toBe(player.telegramId)
    // The reason is for the admins, never sent to the player
    expect(msg?.text).not.toContain('Prize top-up')

    const debit = await http.post(`/admin/v1/users/${player.userId}/adjust`).set(boss).send({ raffs: -200, reason: 'Correction' })
    expect(debit.status).toBe(200)
    expect(debit.body.result.playerTold).toBe(false)
    expect(await creditsFor(player.userId)).toHaveLength(1)
  })

  it('a requested credit tells the player only once a second admin approves it', async () => {
    const finance = await signIn('finance')
    const approver = await signIn('super_admin')
    const player = await open(http)
    const asked = await http.post(`/admin/v1/users/${player.userId}/adjust`).set(finance).send({ raffs: 1, reason: 'Goodwill' })
    expect(asked.status).toBe(202)
    expect(await creditsFor(player.userId)).toHaveLength(0)
    const ok = await http.post(`/admin/v1/approvals/${asked.body.id}/approve`).set(approver).send({})
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const [msg] = await creditsFor(player.userId)
    expect(msg?.text).toMatch(/^<b>You received 1 Raff from Raffle Win<\/b>/)
  })
})

describe('run a raffle again', () => {
  it('copies a drawn raffle into a new draft; the original keeps its winners and status', async () => {
    const admin = await signIn('raffle_manager')
    const { seed, commitment } = newDrawSeed()
    const src = await createRaffle(db, { entryPriceRaffs: 10, drawSeed: seed, seedCommitment: commitment, imageUrl: '/v1/media/abc', description: 'Brand new', rules: ['One per person'] })
    await db.update(rafflePrizes).set({ costNaira: 120_000 }).where(and(eq(rafflePrizes.raffleId, src.id), eq(rafflePrizes.position, 1)))
    // Six tickets, then the draw
    for (let i = 0; i < 2; i++) {
      const m = await open(http)
      expect((await m.put('/v1/phone', { contactProof: contactProof(m.telegramId, nigerianPhone().slice(1)) })).status).toBe(200)
      await credit(db, m.userId, 30)
      expect((await m.post('/v1/entries', { raffleId: src.id, qty: 3, idempotencyKey: randomUUID() })).status).toBe(201)
    }
    await db.update(raffles).set({ deadline: new Date(Date.now() - 1000) }).where(eq(raffles.id, src.id))
    expect(await settleRaffle(ctx, src.id)).toBe('drawn')
    const before = (await http.get(`/admin/v1/raffles/${src.id}`).set(admin)).body as AdminRaffle

    const res = await http.post(`/admin/v1/raffles/${src.id}/copy`).set(admin)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const copy = res.body as AdminRaffle
    expect(copy.id).not.toBe(src.id)
    expect(copy).toMatchObject({
      status: 'draft',
      prizeName: src.prizeName,
      model: src.model,
      imageUrl: '/v1/media/abc',
      entryPriceRaffs: 10,
      entriesTarget: src.entriesTarget,
      entriesCount: 0,
      description: 'Brand new',
      rules: ['One per person'],
      seedCommitment: null,
      drawnAt: null,
      copiedFrom: { id: src.id, prizeName: src.prizeName },
    })
    expect(copy.slug).not.toBe(src.slug)
    expect(copy.prizes.map((p) => [p.position, p.prizeItem, p.prizeType, p.raffsValue, p.costNaira, p.winnerUsername, p.winnerTicket])).toEqual(
      before.prizes.map((p) => [p.position, p.prizeItem, p.prizeType, p.raffsValue, p.costNaira, null, null]),
    )
    const deadline = Date.parse(copy.deadline)
    expect(deadline).toBeGreaterThan(Date.now() + 23 * 3_600_000)
    expect(deadline % 3_600_000).toBe(0)

    // The original is exactly as it was
    const after = (await http.get(`/admin/v1/raffles/${src.id}`).set(admin)).body as AdminRaffle
    expect(after).toEqual(before)

    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, 'raffle.copy'), eq(auditLog.targetId, copy.id)))
    expect(audit?.after).toMatchObject({ copiedFrom: src.id, sourceStatus: 'drawn' })

    // The copy publishes like any draft, with its own seed
    const opened = await http.post(`/admin/v1/raffles/${copy.id}/open`).set(admin)
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    const [row] = await db.select({ seed: raffles.drawSeed, src: raffles.copiedFromRaffleId }).from(raffles).where(eq(raffles.id, copy.id))
    expect(row?.seed).not.toBe(seed)
    expect(row?.src).toBe(src.id)
  })

  it('works from a cancelled raffle too, and needs raffles.write', async () => {
    const src = await createRaffle(db, { status: 'cancelled', cancelledAt: new Date() })
    const viewer = await signIn('viewer')
    expect((await http.post(`/admin/v1/raffles/${src.id}/copy`).set(viewer)).status).toBe(403)
    const boss = await signIn('super_admin')
    const res = await http.post(`/admin/v1/raffles/${src.id}/copy`).set(boss)
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('draft')
    expect((await http.post(`/admin/v1/raffles/${randomUUID()}/copy`).set(boss)).status).toBe(404)
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(raffles).where(eq(raffles.copiedFromRaffleId, src.id))
    expect(n?.n).toBe(1)
  })
})
