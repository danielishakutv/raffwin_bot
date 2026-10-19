import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Bootstrap, Entry, LiveSnapshot, Page, RateQuote, ReferralEarning, ReferralSummary, ReferredPerson } from '@raffwin/shared'
import { entries, ledger, raffles, rateQuotes, users } from '../src/db/schema'
import { currentQuote } from '../src/services/rates'
import { putSetting } from '../src/services/settings'
import { createRaffle, credit, member as open } from './fixtures'
import { contactProof, nigerianPhone, testApp } from './helpers'

const { http, db } = testApp()

/**
 * A player who has shared their phone (the onboarding step): entering a raffle
 * needs one while require_phone_for_entry is on, its default.
 */
async function member(opts?: Parameters<typeof open>[1]) {
  const m = await open(http, opts)
  const res = await m.put('/v1/phone', { contactProof: contactProof(m.telegramId, nigerianPhone().slice(1)) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return m
}

const enter = (m: Awaited<ReturnType<typeof member>>, raffleId: string, qty: number, key = randomUUID()) =>
  m.post('/v1/entries', { raffleId, qty, idempotencyKey: key })

async function balanceOf(userId: string) {
  const [row] = await db
    .select({
      cache: users.balanceCache,
      sum: sql<number>`(select coalesce(sum(l.raffs), 0)::int from ${ledger} l where l.user_id = "users"."id")`,
    })
    .from(users)
    .where(eq(users.id, userId))
  // The cache and the ledger must always agree
  expect(row?.cache).toBe(row?.sum)
  return row?.cache
}

describe('GET /v1/rate', () => {
  it('returns one quote per hour, 3% to 15% from the base', async () => {
    const m = await member()
    const a = (await m.get('/v1/rate')).body as RateQuote
    const b = (await m.get('/v1/rate')).body as RateQuote
    expect(a.id).toBe(b.id)
    expect(a.source).toBe('live')
    expect(a.expiresAt - a.issuedAt).toBe(3_600_000)
    expect(a.expiresAt).toBeGreaterThan(Date.now())
    const [row] = await db.select().from(rateQuotes).where(eq(rateQuotes.id, a.id))
    const move = Math.abs((row?.moveMicro ?? 0) / 1_000_000)
    expect(move).toBeGreaterThanOrEqual(0.03)
    expect(move).toBeLessThanOrEqual(0.15)
    // Whole kobo, moved from the naira base
    expect(Math.abs(a.nairaPerRaff * 100 - (row?.baseNairaPerRaffKobo ?? 0) * (1 + (row?.moveMicro ?? 0) / 1_000_000))).toBeLessThanOrEqual(0.5)
    expect(row?.starsPerRaffMicro).toBeNull()
  })

  it('agrees on one row when many requests issue the same hour at once', async () => {
    const future = Date.now() + 50 * 3_600_000 // an hour no other test touches
    const rows = await Promise.all(Array.from({ length: 12 }, () => currentQuote(db, future)))
    expect(new Set(rows.map((r) => r.id)).size).toBe(1)
  })

  it('uses the base and the movement range from settings', async () => {
    await putSetting(db, 'rate.base_naira_per_raff_kobo', 2_000, null)
    try {
      const row = await currentQuote(db, Date.now() + 60 * 3_600_000)
      expect(row.baseNairaPerRaffKobo).toBe(2_000)
      expect(row.nairaPerRaffKobo).toBeGreaterThanOrEqual(1_700)
      expect(row.nairaPerRaffKobo).toBeLessThanOrEqual(2_300)
      // 0..0 = a fixed price
      await putSetting(db, 'rate.move_min_pct', 0, null)
      await putSetting(db, 'rate.move_max_pct', 0, null)
      const fixed = await currentQuote(db, Date.now() + 61 * 3_600_000)
      expect(fixed.nairaPerRaffKobo).toBe(2_000)
    } finally {
      await putSetting(db, 'rate.base_naira_per_raff_kobo', 1_000, null)
      await putSetting(db, 'rate.move_min_pct', 3, null)
      await putSetting(db, 'rate.move_max_pct', 15, null)
    }
  })
})

describe('GET /v1/raffles', () => {
  it('shows open raffles, never drafts or cancelled ones', async () => {
    const open = await createRaffle(db)
    const draft = await createRaffle(db, { status: 'draft' })
    const cancelled = await createRaffle(db, { status: 'cancelled' })
    const m = await member()
    const list = (await m.get('/v1/raffles')).body as { id: string; entryPriceRaffs: number; winners: unknown[] }[]
    const ids = list.map((r) => r.id)
    expect(ids).toContain(open.id)
    expect(ids).not.toContain(draft.id)
    expect(ids).not.toContain(cancelled.id)
    const shown = list.find((r) => r.id === open.id)
    expect(shown?.entryPriceRaffs).toBe(50)
    expect(shown?.winners).toHaveLength(3)
    expect((await m.get(`/v1/raffles/${draft.id}`)).status).toBe(404)
    expect((await m.get('/v1/raffles/not-a-uuid')).status).toBe(404)
  })
})

describe('POST /v1/entries', () => {
  it('refuses an entry at a price that has changed since the player saw it', async () => {
    const raffle = await createRaffle(db, { entryPriceRaffs: 40 })
    const m = await member()
    await credit(db, m.userId, 1000)
    await db.update(raffles).set({ entryPriceRaffs: 60 }).where(eq(raffles.id, raffle.id))
    const stale = await m.post('/v1/entries', { raffleId: raffle.id, qty: 1, idempotencyKey: randomUUID(), priceRaffs: 40 })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: 'PRICE_CHANGED' })
    expect(stale.body.error.message).toMatch(/now 60 Raffs/)
    expect(await balanceOf(m.userId)).toBe(1000)
    const fresh = await m.post('/v1/entries', { raffleId: raffle.id, qty: 1, idempotencyKey: randomUUID(), priceRaffs: 60 })
    expect(fresh.status).toBe(201)
  })

  it('charges the fixed Raffs price and assigns contiguous tickets', async () => {
    const raffle = await createRaffle(db, { entryPriceRaffs: 40 })
    const m = await member()
    await credit(db, m.userId, 1000)

    const first = await enter(m, raffle.id, 3)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    expect(first.body.entry).toMatchObject({ qty: 3, raffsSpent: 120, ticketFrom: 1, ticketTo: 3 })
    expect(first.body.balance).toBe(880)
    expect(first.body.transaction).toMatchObject({ type: 'entry', raffs: -120 })
    expect(first.body.raffle.entriesCount).toBe(3)
    expect(first.body.raffle.entrants).toContain(m.username)

    const second = await enter(m, raffle.id, 2)
    expect(second.body.entry).toMatchObject({ ticketFrom: 4, ticketTo: 5 })
    expect(await balanceOf(m.userId)).toBe(800)
  })

  it('returns the same entry for a retried tap, charging once', async () => {
    const raffle = await createRaffle(db)
    const m = await member()
    await credit(db, m.userId, 500)
    const key = randomUUID()
    const results = await Promise.all([enter(m, raffle.id, 2, key), enter(m, raffle.id, 2, key), enter(m, raffle.id, 2, key)])
    const ids = new Set(results.map((r) => (r.body.entry as Entry | undefined)?.id))
    expect(results.every((r) => r.status === 201)).toBe(true)
    expect(ids.size).toBe(1)
    expect(await balanceOf(m.userId)).toBe(400)
  })

  it('never oversells under concurrent entries', async () => {
    const raffle = await createRaffle(db, { entriesTarget: 10, entryPriceRaffs: 10 })
    const players = await Promise.all(Array.from({ length: 15 }, () => member()))
    await Promise.all(players.map((p) => credit(db, p.userId, 100)))

    const results = await Promise.all(players.map((p) => enter(p, raffle.id, 1)))
    const ok = results.filter((r) => r.status === 201)
    const refused = results.filter((r) => r.status !== 201)
    expect(ok).toHaveLength(10)
    expect(refused.every((r) => r.body.error.code === 'RAFFLE_CLOSED')).toBe(true)

    const tickets = (await db.select().from(entries).where(eq(entries.raffleId, raffle.id))).map((e) => e.ticketFrom).sort((a, b) => a - b)
    expect(tickets).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const [after] = await db.select().from(raffles).where(eq(raffles.id, raffle.id))
    expect(after?.entriesCount).toBe(10)
  })

  it('refuses with a clear reason when it cannot sell', async () => {
    const m = await member()
    await credit(db, m.userId, 60)
    const raffle = await createRaffle(db, { entriesTarget: 5 })

    const broke = await enter(m, raffle.id, 2)
    expect(broke.status).toBe(409)
    expect(broke.body.error).toMatchObject({ code: 'INSUFFICIENT_FUNDS', message: 'You need 40 more Raffs for this entry.' })

    const tooMany = await enter(m, raffle.id, 6)
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.error.message).toBe('Only 5 entries are left.')

    const past = await createRaffle(db, { deadline: new Date(Date.now() - 1000) })
    expect((await enter(m, past.id, 1)).body.error.code).toBe('RAFFLE_CLOSED')

    const draft = await createRaffle(db, { status: 'draft' })
    expect((await enter(m, draft.id, 1)).status).toBe(404)

    expect((await m.post('/v1/entries', { raffleId: raffle.id, qty: 51, idempotencyKey: randomUUID() })).status).toBe(400)
    expect(await balanceOf(m.userId)).toBe(60)
  })

  it('enforces the per-raffle cap from settings', async () => {
    await putSetting(db, 'limits.max_entries_per_user_per_raffle', 3, null)
    try {
      const m = await member()
      await credit(db, m.userId, 10_000)
      const raffle = await createRaffle(db)
      expect((await enter(m, raffle.id, 2)).status).toBe(201)
      const over = await enter(m, raffle.id, 2)
      expect(over.status).toBe(400)
      expect(over.body.error.message).toBe('You can hold at most 3 entries in one raffle; you have 2.')
    } finally {
      await putSetting(db, 'limits.max_entries_per_user_per_raffle', null, null)
    }
  })

  it('shows up in bootstrap', async () => {
    const m = await member()
    await credit(db, m.userId, 100)
    const raffle = await createRaffle(db)
    await enter(m, raffle.id, 1)
    const boot = (await m.get('/v1/bootstrap')).body as Bootstrap
    expect(boot.balance).toBe(50)
    expect(boot.entries[0]).toMatchObject({ raffleId: raffle.id, ticketFrom: 1 })
    expect(boot.transactions.map((t) => t.type)).toEqual(['entry', 'adjustment'])
    expect(boot.raffles.some((r) => r.id === raffle.id)).toBe(true)
  })
})

describe('referral earnings', () => {
  it('pays the referrer 10% of every entry, floored, and shows it in the tracker', async () => {
    const referrer = await member()
    const friend = await member({ startParam: `ref_${referrer.referralCode}` })
    await credit(db, friend.userId, 1000)
    const raffle = await createRaffle(db, { entryPriceRaffs: 45 })

    await enter(friend, raffle.id, 3) // 135 -> 13
    await enter(friend, raffle.id, 1) // 45 -> 4
    expect(await balanceOf(referrer.userId)).toBe(17)
    expect(await balanceOf(friend.userId)).toBe(820)

    const summary = (await referrer.get('/v1/referrals/summary')).body as ReferralSummary
    expect(summary).toMatchObject({
      code: referrer.referralCode,
      link: `https://t.me/raffwin_test_bot?start=ref_${referrer.referralCode}`,
      peopleReferred: 1,
      activeThisMonth: 1,
      lifetimeRaffs: 17,
      monthRaffs: 17,
    })

    const people = (await referrer.get('/v1/referrals/people')).body as Page<ReferredPerson>
    expect(people.items).toEqual([expect.objectContaining({ username: friend.username, entries: 2, raffsEarned: 17 })])

    const earned = (await referrer.get('/v1/referrals/earnings')).body as Page<ReferralEarning>
    expect(earned.items.map((e) => [e.entryRaffs, e.earnedRaffs])).toEqual([
      [45, 4],
      [135, 13],
    ])

    const tx = (await referrer.get('/v1/transactions')).body as { type: string; raffs: number }[]
    expect(tx.filter((t) => t.type === 'referral').map((t) => t.raffs).sort()).toEqual([13, 4].sort())
  })

  it('pages through earnings without repeating or skipping', async () => {
    const referrer = await member()
    const friend = await member({ startParam: `ref_${referrer.referralCode}` })
    await credit(db, friend.userId, 10_000)
    const raffle = await createRaffle(db, { entryPriceRaffs: 100 })
    for (let i = 0; i < 7; i += 1) await enter(friend, raffle.id, 1)

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const path: string = `/v1/referrals/earnings?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = (await referrer.get(path)).body as Page<ReferralEarning>
      seen.push(...page.items.map((e) => e.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    expect((await referrer.get('/v1/referrals/earnings?cursor=garbage')).status).toBe(400)
  })

  it('pays nothing on entries too small to earn a whole Raff', async () => {
    const referrer = await member()
    const friend = await member({ startParam: `ref_${referrer.referralCode}` })
    await credit(db, friend.userId, 100)
    const raffle = await createRaffle(db, { entryPriceRaffs: 9 })
    await enter(friend, raffle.id, 1)
    expect(await balanceOf(referrer.userId)).toBe(0)
  })
})

describe('GET /v1/live', () => {
  it("shows another player's entry and my own balance change on the next poll", async () => {
    const raffle = await createRaffle(db, { entryPriceRaffs: 20 })
    const watcher = await member()
    const buyer = await member()
    await credit(db, buyer.userId, 100)

    const before = (await watcher.get('/v1/live')).body as LiveSnapshot
    expect(before.raffles.find((r) => r.id === raffle.id)?.entriesCount).toBe(0)

    await enter(buyer, raffle.id, 3)
    const after = (await watcher.get('/v1/live')).body as LiveSnapshot
    expect(after.raffles.find((r) => r.id === raffle.id)).toMatchObject({ entriesCount: 3, status: 'open' })
    expect(after.serverTime).toBeGreaterThanOrEqual(before.serverTime)

    const mine = await buyer.get('/v1/live')
    expect(mine.headers['cache-control']).toBe('no-store')
    expect(mine.body.balance).toBe(40)
  })

  it('changes a raffle version when an admin edits it, never when entries sell', async () => {
    const raffle = await createRaffle(db, { entryPriceRaffs: 20 })
    const watcher = await member()
    const buyer = await member()
    await credit(db, buyer.userId, 100)
    const versionOf = async () => ((await watcher.get('/v1/live')).body as LiveSnapshot).raffles.find((r) => r.id === raffle.id)?.version
    const v1 = await versionOf()
    expect(v1).toMatch(/^[0-9a-f]{32}$/)
    await enter(buyer, raffle.id, 2)
    expect(await versionOf()).toBe(v1)
    await db.update(raffles).set({ entryPriceRaffs: 25 }).where(eq(raffles.id, raffle.id))
    const v2 = await versionOf()
    expect(v2).not.toBe(v1)
    await db.update(raffles).set({ description: 'Now with a case' }).where(eq(raffles.id, raffle.id))
    expect(await versionOf()).not.toBe(v2)
  })

  it('never lists drafts or cancelled raffles', async () => {
    const draft = await createRaffle(db, { status: 'draft' })
    const m = await member()
    const ids = ((await m.get('/v1/live')).body as LiveSnapshot).raffles.map((r) => r.id)
    expect(ids).not.toContain(draft.id)
  })
})

describe('the ledger', () => {
  it('cannot be edited or deleted, even directly in SQL', async () => {
    const m = await member()
    await credit(db, m.userId, 10)
    // drizzle wraps the database error; the trigger's own message is on `cause`
    const appendOnly = { cause: expect.objectContaining({ message: expect.stringMatching(/ledger is append-only/) }) }
    await expect(db.execute(sql`update ledger set raffs = 1000000 where user_id = ${m.userId}`)).rejects.toMatchObject(appendOnly)
    await expect(db.execute(sql`delete from ledger where user_id = ${m.userId}`)).rejects.toMatchObject(appendOnly)
    expect(await balanceOf(m.userId)).toBe(10)
  })
})
