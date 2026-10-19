/**
 * The draw (19 Oct): at the deadline a raffle with at least 5 tickets sold
 * (and at least as many as it has prizes) is drawn from its committed seed;
 * below that it is cancelled and every entry refunded. Each test settles its
 * own raffles (settleRaffle) instead of sweeping every raffle that is due,
 * because the schema is shared with the other test files.
 */
import { createHash, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { MIN_DRAW_ENTRIES, minEntriesToDraw, type Raffle } from '@raffwin/shared'
import { hashPassword, issueTicket } from '../src/admin/session'
import { adminUsers, auditLog, broadcasts, ledger, notifications, rafflePrizes, raffles, users } from '../src/db/schema'
import { ensureSeedCommitments, newDrawSeed, pickWinningTickets, publicName, settleRaffle } from '../src/services/draw'
import { createRaffle, credit, member as open } from './fixtures'
import { contactProof, initData, nigerianPhone, telegramId, testApp } from './helpers'

const { http, db, ctx } = testApp()

async function member() {
  const m = await open(http)
  const res = await m.put('/v1/phone', { contactProof: contactProof(m.telegramId, nigerianPhone().slice(1)) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return m
}

/** A raffle with the fixture's three prizes and a seed, as opening it would leave it */
async function seededRaffle(overrides: Parameters<typeof createRaffle>[1] = {}) {
  const { seed, commitment } = newDrawSeed()
  return createRaffle(db, { entryPriceRaffs: 10, drawSeed: seed, seedCommitment: commitment, ...overrides })
}

async function buy(m: Awaited<ReturnType<typeof member>>, raffleId: string, qty: number) {
  await credit(db, m.userId, qty * 10)
  const res = await m.post('/v1/entries', { raffleId, qty, idempotencyKey: randomUUID() })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
}

/** Moves the deadline into the past, as if it had just passed */
const closeNow = (id: string) => db.update(raffles).set({ deadline: new Date(Date.now() - 1000) }).where(eq(raffles.id, id))

async function balanceOf(userId: string) {
  const [u] = await db.select({ b: users.balanceCache }).from(users).where(eq(users.id, userId))
  return u?.b ?? 0
}

describe('picking winning tickets', () => {
  it('is deterministic, distinct and inside 1..sold, and follows the published method', () => {
    const seed = 'ab'.repeat(32)
    const id = randomUUID()
    const a = pickWinningTickets(seed, id, 7, 3)
    expect(pickWinningTickets(seed, id, 7, 3)).toEqual(a)
    expect(new Set(a).size).toBe(3)
    for (const t of a) expect(t).toBeGreaterThanOrEqual(1), expect(t).toBeLessThanOrEqual(7)
    const first = Number(BigInt(`0x${createHash('sha256').update(`${seed}:${id}:7:1:0`).digest('hex')}`) % 7n) + 1
    expect(a[0]).toBe(first)
    // Every ticket is drawn when places = sold
    expect(pickWinningTickets(seed, id, 5, 5).sort()).toEqual([1, 2, 3, 4, 5])
    expect(() => pickWinningTickets(seed, id, 2, 3)).toThrow()
  })

  it('needs 5 entries, or as many as there are prizes', () => {
    expect(MIN_DRAW_ENTRIES).toBe(5)
    expect(minEntriesToDraw(1)).toBe(5)
    expect(minEntriesToDraw(3)).toBe(5)
    expect(minEntriesToDraw(8)).toBe(8)
  })

  it('names a winner by username, else by first name only', () => {
    expect(publicName({ username: 'ada_obi', fullName: 'Ada Obi', tgFirstName: 'Ada' })).toBe('@ada_obi')
    expect(publicName({ username: null, fullName: 'Chidi Okeke', tgFirstName: 'C' })).toBe('Chidi')
    expect(publicName({ username: null, fullName: null, tgFirstName: null })).toBe('A player')
  })
})

describe('the draw at the deadline', () => {
  it('draws a raffle with enough entries: winners, Raffs prizes, seed published, players told', async () => {
    const [a, b, c] = [await member(), await member(), await member()]
    const raffle = await seededRaffle()
    await buy(a, raffle.id, 2)
    await buy(b, raffle.id, 3)
    await buy(c, raffle.id, 1)
    const before = new Map(await Promise.all([a, b, c].map(async (m) => [m.userId, await balanceOf(m.userId)] as const)))

    // Not before the deadline
    expect(await settleRaffle(ctx, raffle.id)).toBe('skipped')
    await closeNow(raffle.id)
    expect(await settleRaffle(ctx, raffle.id)).toBe('drawn')
    expect(await settleRaffle(ctx, raffle.id)).toBe('skipped')

    const [row] = await db.select().from(raffles).where(eq(raffles.id, raffle.id))
    expect(row).toMatchObject({ status: 'drawn', drawSeed: raffle.drawSeed, seedCommitment: raffle.seedCommitment })
    expect(row?.drawnAt).toBeInstanceOf(Date)
    expect(createHash('sha256').update(row!.drawSeed!).digest('hex')).toBe(row?.seedCommitment)

    const tickets = pickWinningTickets(raffle.drawSeed!, raffle.id, 6, 3)
    const prizes = await db.select().from(rafflePrizes).where(eq(rafflePrizes.raffleId, raffle.id)).orderBy(rafflePrizes.position)
    expect(prizes.map((p) => p.winnerTicket)).toEqual(tickets)
    // Tickets 1-2 are a's, 3-5 b's, 6 c's
    const ownerOf = (t: number) => (t <= 2 ? a : t <= 5 ? b : c).userId
    expect(prizes.map((p) => p.winnerUserId)).toEqual(tickets.map(ownerOf))
    expect(prizes.map((p) => p.fulfilmentStatus)).toEqual(['pending', 'delivered', 'delivered'])

    // Raffs prizes credited to their winners (2nd 5,000, 3rd 1,000)
    const won = new Map<string, number>()
    won.set(ownerOf(tickets[1]!), (won.get(ownerOf(tickets[1]!)) ?? 0) + 5000)
    won.set(ownerOf(tickets[2]!), (won.get(ownerOf(tickets[2]!)) ?? 0) + 1000)
    for (const m of [a, b, c]) expect(await balanceOf(m.userId)).toBe((before.get(m.userId) ?? 0) + (won.get(m.userId) ?? 0))
    const prizeRows = await db.select().from(ledger).where(and(eq(ledger.type, 'prize'), sql`${ledger.referenceId} in (select id from raffle_prizes where raffle_id = ${raffle.id})`))
    expect(prizeRows.map((r) => r.raffs).sort((x, y) => x - y)).toEqual([1000, 5000])

    // Players see the winners, their tickets and the seed
    const seen = (await a.get(`/v1/raffles/${raffle.id}`)).body as Raffle
    expect(seen.drawnAt).not.toBeNull()
    expect(seen.drawSeed).toBe(raffle.drawSeed)
    expect(seen.winners.map((w) => w.ticket)).toEqual(tickets)
    const names = new Map([a, b, c].map((m) => [m.userId, `@${m.username}`]))
    expect(seen.winners.map((w) => w.name)).toEqual(tickets.map((t) => names.get(ownerOf(t))))

    // The board to everyone (entrants always), and each winner's own message
    const [board] = await db.select().from(broadcasts).where(and(eq(broadcasts.kind, 'raffle_drawn'), eq(broadcasts.refId, raffle.id)))
    expect(board).toMatchObject({ title: 'Winners: Tecno Spark 20', audience: { type: 'all' }, openButton: true })
    expect(board?.text).toContain(`1st: ${names.get(ownerOf(tickets[0]!))} (ticket ${tickets[0]}) wins Tecno Spark 20`)
    const mine = await db.select().from(notifications).where(and(eq(notifications.kind, 'raffle_won'), sql`${notifications.dedupeKey} like ${`won:${raffle.id}:%`}`))
    expect(mine).toHaveLength(3)
    expect(mine.find((n) => n.dedupeKey === `won:${raffle.id}:1`)?.text).toMatch(/^<b>You won!<\/b> Tecno Spark 20 .*motor park/s)

    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, 'raffle.drawn'), eq(auditLog.targetId, raffle.id)))
    expect(audit?.adminId).toBeNull()
  })

  it('does not draw under 5 entries: cancelled, every Raff refunded, entrants told why', async () => {
    const [a, b] = [await member(), await member()]
    const raffle = await seededRaffle()
    await buy(a, raffle.id, 3)
    await buy(b, raffle.id, 1)
    const balances = [await balanceOf(a.userId), await balanceOf(b.userId)]
    await closeNow(raffle.id)
    expect(await settleRaffle(ctx, raffle.id)).toBe('cancelled')

    const [row] = await db.select().from(raffles).where(eq(raffles.id, raffle.id))
    expect(row?.status).toBe('cancelled')
    expect(await balanceOf(a.userId)).toBe(balances[0]! + 30)
    expect(await balanceOf(b.userId)).toBe(balances[1]! + 10)
    const refunds = await db.select().from(ledger).where(and(eq(ledger.userId, a.userId), eq(ledger.type, 'refund')))
    expect(refunds.map((r) => r.note)).toContain('Refund: Tecno Spark 20 did not reach 5 entries')
    expect(await db.select().from(rafflePrizes).where(and(eq(rafflePrizes.raffleId, raffle.id), sql`winner_user_id is not null`))).toHaveLength(0)

    const [msg] = await db.select().from(broadcasts).where(and(eq(broadcasts.kind, 'raffle_cancelled'), eq(broadcasts.refId, raffle.id)))
    expect(msg?.title).toBe('Not drawn: Tecno Spark 20')
    expect(msg?.text).toMatch(/^The Tecno Spark 20 raffle closed with 4 entries\. A draw needs at least 5, so it was not drawn\./)
    expect((msg?.audience as { userIds: string[] }).userIds.sort()).toEqual([a.userId, b.userId].sort())
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, 'raffle.not_drawn'), eq(auditLog.targetId, raffle.id)))
    expect(audit?.after).toMatchObject({ reason: 'too_few_entries', sold: 4, need: 5 })
  })

  it('a raffle nobody entered is cancelled quietly', async () => {
    const raffle = await seededRaffle()
    await closeNow(raffle.id)
    expect(await settleRaffle(ctx, raffle.id)).toBe('cancelled')
    expect(await db.select().from(broadcasts).where(eq(broadcasts.refId, raffle.id))).toHaveLength(0)
  })

  it('more prizes than 5 need that many entries', async () => {
    const players = [await member(), await member()]
    const raffle = await seededRaffle()
    await db.insert(rafflePrizes).values([4, 5, 6].map((position) => ({ raffleId: raffle.id, position, prizeItem: `Prize ${position}`, prizeType: 'physical' as const })))
    await buy(players[0]!, raffle.id, 3)
    await buy(players[1]!, raffle.id, 2)
    await closeNow(raffle.id)
    // 5 sold, 6 prizes: not drawable
    expect(await settleRaffle(ctx, raffle.id)).toBe('cancelled')
  })

  it('a raffle opened before seeds existed gets one at once, and it is not shown until the draw', async () => {
    const raffle = await createRaffle(db, { seedCommitment: null, drawSeed: null })
    await ensureSeedCommitments(ctx)
    const [row] = await db.select().from(raffles).where(eq(raffles.id, raffle.id))
    expect(row?.drawSeed).toMatch(/^[0-9a-f]{64}$/)
    expect(createHash('sha256').update(row!.drawSeed!).digest('hex')).toBe(row?.seedCommitment)
    const m = await member()
    const seen = (await m.get(`/v1/raffles/${raffle.id}`)).body as Raffle
    expect(seen.seedCommitment).toBe(row?.seedCommitment)
    expect(seen.drawSeed).toBeNull()
    expect(seen.winners.every((w) => w.name === null && w.ticket === null)).toBe(true)
  })
})

describe('admin and the draw', () => {
  async function superAdmin() {
    const tg = telegramId()
    const [a] = await db
      .insert(adminUsers)
      .values({ name: 'Draw Admin', username: `draw_${tg}`, telegramUsername: `draw${tg}`, telegramId: tg, role: 'super_admin', passwordHash: await hashPassword('x'.repeat(16)) })
      .returning({ id: adminUsers.id })
    const ticket = await issueTicket(ctx, a!.id, tg)
    const res = await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: tg }) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return { authorization: `Bearer ${res.body.token as string}` }
  }

  it('opening a raffle fixes its seed and publishes the commitment', async () => {
    const auth = await superAdmin()
    const raffle = await createRaffle(db, { status: 'draft', openedAt: null, deadline: new Date(Date.now() + 3 * 86_400_000) })
    const res = await http.post(`/admin/v1/raffles/${raffle.id}/open`).set(auth)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const [row] = await db.select().from(raffles).where(eq(raffles.id, raffle.id))
    expect(createHash('sha256').update(row!.drawSeed!).digest('hex')).toBe(row?.seedCommitment)
  })

  it('an open raffle past its deadline can no longer be edited', async () => {
    const auth = await superAdmin()
    const raffle = await seededRaffle()
    const detail = (await http.get(`/admin/v1/raffles/${raffle.id}`).set(auth)).body
    await closeNow(raffle.id)
    const res = await http
      .put(`/admin/v1/raffles/${raffle.id}`)
      .set(auth)
      .send({
        prizeName: detail.prizeName,
        model: detail.model,
        category: detail.category,
        kind: detail.kind,
        marketPriceNaira: detail.marketPriceNaira,
        entryPriceRaffs: detail.entryPriceRaffs,
        entriesTarget: detail.entriesTarget,
        deadline: new Date(Date.now() + 86_400_000).toISOString(),
        prizes: detail.prizes.map((p: Record<string, unknown>) => ({ position: p.position, prizeItem: p.prizeItem, prizeType: p.prizeType, raffsValue: p.raffsValue })),
      })
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error.message).toMatch(/draw is running/)
  })
})
