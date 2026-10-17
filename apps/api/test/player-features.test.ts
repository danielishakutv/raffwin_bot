/**
 * The player side of the engagement work: the phone step, reminders switch,
 * bootstrap/live feature switches and come-back credit, the phone rule on
 * entries, the daily streak and Send Raffs. The schema is shared with the
 * other test files, so feature switches are set per player (overrides) where
 * possible, and the global switches this file touches are put back afterwards.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, gte, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Bootstrap, FeatureKey, LiveSnapshot, Profile, StreakClaimResult, StreakState, TransferLimits } from '@raffwin/shared'
import {
  comebackOffers,
  dailyCheckins,
  ledger,
  notifications,
  raffsTransfers,
  securityEvents,
  users,
} from '../src/db/schema'
import { getGlobalFlags, setGlobal, setOverride } from '../src/services/features'
import { saveVerifiedPhone } from '../src/services/phone'
import { putSetting } from '../src/services/settings'
import { createRaffle, credit, member, type Member } from './fixtures'
import { contactProof, nigerianPhone, testApp } from './helpers'

const APP_URL = 'https://raffwintest.example/'
const { http, db, ctx, clock } = testApp({ PUBLIC_APP_URL: APP_URL })

/* Shared state: global switches and the clock -------------------------------- */

const TOUCHED: FeatureKey[] = ['daily_streak', 'raffs_transfer', 'require_phone_for_entry']
let globalsBefore: Record<string, boolean> = {}

beforeAll(async () => {
  const flags = await getGlobalFlags(db)
  globalsBefore = Object.fromEntries(TOUCHED.map((k) => [k, flags[k]]))
  // The defaults, whatever other files left behind
  await setGlobal(db, 'daily_streak', false, null)
  await setGlobal(db, 'raffs_transfer', false, null)
  await setGlobal(db, 'require_phone_for_entry', true, null)
})

afterAll(async () => {
  for (const key of TOUCHED) await setGlobal(db, key, globalsBefore[key] as boolean, null)
})

// Tests move time forward by whole days; signing in and phone shares need real time, so it always goes back
let travelled = 0
function travelDays(days: number) {
  clock.advance(days * 86_400)
  travelled += days * 86_400
}
afterEach(() => {
  clock.advance(-travelled)
  travelled = 0
})

/* Helpers -------------------------------------------------------------------- */

const share = (m: Member, phone = nigerianPhone().slice(1)) => m.put('/v1/phone', { contactProof: contactProof(m.telegramId, phone) })

async function withPhone(opts: Parameters<typeof member>[1] = {}): Promise<Member> {
  const m = await member(http, opts)
  const res = await share(m)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return m
}

const turnOn = (key: FeatureKey, m: Member, enabled = true) => setOverride(db, key, m.userId, enabled, 'test', null)

async function userRow(userId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, userId))
  if (!row) throw new Error('no user')
  return row
}

/** The cache and the ledger must always agree. */
async function balanceOf(userId: string) {
  const [row] = await db
    .select({
      cache: users.balanceCache,
      sum: sql<number>`(select coalesce(sum(l.raffs), 0)::int from ${ledger} l where l.user_id = "users"."id")`,
    })
    .from(users)
    .where(eq(users.id, userId))
  expect(row?.cache).toBe(row?.sum)
  return row?.cache
}

/* Phone ----------------------------------------------------------------------- */

describe('PUT /v1/phone', () => {
  it('saves the Telegram-verified phone alone, without completing KYC', async () => {
    const m = await member(http)
    const res = await share(m)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const p = res.body as Profile
    expect(p).toMatchObject({ phoneVerified: true, kycComplete: false, delivery: null })
    expect(p.phone).toMatch(/^\+234803\d{7}$/)
    const row = await userRow(m.userId)
    expect(row.phoneVerifiedAt).not.toBeNull()
    expect(row.kycCompletedAt).toBeNull()
  })

  it("refuses somebody else's contact and a number outside Nigeria", async () => {
    const since = new Date(Date.now() - 1000)
    const m = await member(http)
    const other = await m.put('/v1/phone', { contactProof: contactProof(m.telegramId + 1, nigerianPhone().slice(1)) })
    expect(other.status).toBe(422)
    expect(other.body.error.code).toBe('PHONE_NOT_VERIFIED')
    const [event] = await db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.kind, 'contact_other_account'), eq(securityEvents.userId, m.userId), gte(securityEvents.occurredAt, since)))
    expect(event).toMatchObject({ category: 'fraud', severity: 'high' })

    const abroad = await m.put('/v1/phone', { contactProof: contactProof(m.telegramId, '447700900123') })
    expect(abroad.status).toBe(400)
    expect(abroad.body.error.fields.phone).toEqual(expect.any(String))
    expect((await m.put('/v1/phone', {})).status).toBe(400)
  })

  it('keeps one account per phone, and records a friend using the referrer\'s number', async () => {
    const since = new Date(Date.now() - 1000)
    const phone = nigerianPhone().slice(1)
    const r = await member(http)
    expect((await share(r, phone)).status).toBe(200)
    const friend = await member(http, { startParam: `ref_${r.referralCode}` })
    const res = await share(friend, phone)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('PHONE_IN_USE')
    const [event] = await db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.kind, 'referral_self_same_phone'), eq(securityEvents.userId, friend.userId), gte(securityEvents.occurredAt, since)))
    expect(event).toMatchObject({ severity: 'high', category: 'fraud' })
  })

  it('is what the bot contact handler saves through, with the same rule', async () => {
    const a = await member(http)
    const b = await member(http)
    const phone = nigerianPhone()
    const saved = await saveVerifiedPhone(ctx, await userRow(a.userId), phone, 'bot')
    expect(saved).toMatchObject({ phone, id: a.userId })
    expect(saved.phoneVerifiedAt).not.toBeNull()
    await expect(saveVerifiedPhone(ctx, await userRow(b.userId), phone, 'bot')).rejects.toMatchObject({ code: 'PHONE_IN_USE' })
    expect((await profileOf(a)).phone).toBe(phone)
  })
})

async function profileOf(m: Member): Promise<Profile> {
  return (await m.get('/v1/profile')).body as Profile
}

/* Reminders switch ------------------------------------------------------------ */

describe('PUT /v1/profile/reminders', () => {
  it('turns bot reminders off and on again, shown as Profile.remindersOn', async () => {
    const m = await member(http)
    expect((await profileOf(m)).remindersOn).toBe(true)
    const off = await m.put('/v1/profile/reminders', { on: false })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(off.body.remindersOn).toBe(false)
    expect((await userRow(m.userId)).remindersOptOutAt).not.toBeNull()
    const on = await m.put('/v1/profile/reminders', { on: true })
    expect(on.body.remindersOn).toBe(true)
    expect((await m.put('/v1/profile/reminders', { on: 'yes' })).status).toBe(400)
  })
})

/* Bootstrap and live ----------------------------------------------------------- */

describe('feature switches reach the app', () => {
  it('bootstrap and /v1/live carry the effective switches for this player', async () => {
    const m = await member(http)
    const boot = (await m.get('/v1/bootstrap')).body as Bootstrap
    expect(boot.features).toMatchObject({ daily_streak: false, raffs_transfer: false, require_phone_for_entry: true })
    expect(boot.welcomeBack).toBeNull()

    await turnOn('daily_streak', m)
    expect(((await m.get('/v1/live')).body as LiveSnapshot).features.daily_streak).toBe(true)
    expect(((await m.get('/v1/bootstrap')).body as Bootstrap).features.daily_streak).toBe(true)
    // Another player is not affected
    const other = await member(http)
    expect(((await other.get('/v1/live')).body as LiveSnapshot).features.daily_streak).toBe(false)
  })

  it('credits a waiting come-back offer on open, once, with the balance already including it', async () => {
    const m = await member(http)
    const row = await userRow(m.userId)
    await db.insert(comebackOffers).values({
      userId: m.userId,
      raffs: 1,
      spellStartedAt: row.lastSeenAt ?? new Date(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    })
    const first = (await m.get('/v1/bootstrap')).body as Bootstrap
    expect(first.welcomeBack).toEqual({ raffs: 1 })
    expect(first.balance).toBe(1)
    const again = (await m.get('/v1/bootstrap')).body as Bootstrap
    expect(again.welcomeBack).toBeNull()
    expect(again.balance).toBe(1)
    expect(await balanceOf(m.userId)).toBe(1)
  })

  it('every one of several opens at once shows the balance with the come-back credit', async () => {
    const m = await member(http)
    const row = await userRow(m.userId)
    await db.insert(comebackOffers).values({
      userId: m.userId,
      raffs: 1,
      spellStartedAt: row.lastSeenAt ?? new Date(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    })
    const boots = (await Promise.all(Array.from({ length: 4 }, () => m.get('/v1/bootstrap')))).map((r) => r.body as Bootstrap)
    expect(boots.filter((b) => b.welcomeBack !== null)).toEqual([expect.objectContaining({ welcomeBack: { raffs: 1 } })])
    expect(boots.map((b) => b.balance)).toEqual([1, 1, 1, 1])
    expect(await balanceOf(m.userId)).toBe(1)
  })
})

/* Entries need a phone ---------------------------------------------------------- */

describe('entering a raffle needs a phone (require_phone_for_entry)', () => {
  it('refuses before any money moves, then accepts once the phone is shared', async () => {
    const raffle = await createRaffle(db, { entryPriceRaffs: 10 })
    const m = await member(http)
    await credit(db, m.userId, 100)
    const refused = await m.post('/v1/entries', { raffleId: raffle.id, qty: 1, idempotencyKey: randomUUID() })
    expect(refused.status).toBe(422)
    expect(refused.body.error).toMatchObject({
      code: 'PHONE_REQUIRED',
      message: 'Share your phone number first, so we can reach you if you win.',
    })
    expect(await balanceOf(m.userId)).toBe(100)

    expect((await share(m)).status).toBe(200)
    const ok = await m.post('/v1/entries', { raffleId: raffle.id, qty: 1, idempotencyKey: randomUUID() })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(await balanceOf(m.userId)).toBe(90)
  })

  it('lets a player without a phone enter when the switch is off for them', async () => {
    const raffle = await createRaffle(db, { entryPriceRaffs: 10 })
    const m = await member(http)
    await credit(db, m.userId, 100)
    await turnOn('require_phone_for_entry', m, false)
    const ok = await m.post('/v1/entries', { raffleId: raffle.id, qty: 2, idempotencyKey: randomUUID() })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
  })
})

/* Daily streak ----------------------------------------------------------------- */

describe('daily streak', () => {
  it('is refused while the feature is off, and works for a player switched on while it is off globally', async () => {
    const m = await member(http)
    const off = await m.get('/v1/streak')
    expect(off.status).toBe(403)
    expect(off.body.error).toMatchObject({ code: 'FEATURE_OFF', message: 'Daily streak is not available right now.' })
    expect((await m.post('/v1/streak/claim')).body.error.code).toBe('FEATURE_OFF')

    await turnOn('daily_streak', m)
    const state = (await m.get('/v1/streak')).body as StreakState
    expect(state).toEqual({ current: 0, claimedToday: false, nextReward: 1, rewards: [1, 1, 2, 2, 3, 3, 5], lastClaimedDay: null, best: 0 })
  })

  it('pays once a day, grows on consecutive days and starts again after a missed day', async () => {
    const m = await member(http)
    await turnOn('daily_streak', m)

    const day1 = await m.post('/v1/streak/claim')
    expect(day1.status, JSON.stringify(day1.body)).toBe(200)
    expect(day1.body as StreakClaimResult).toMatchObject({ raffs: 1, balance: 1, state: { current: 1, claimedToday: true, nextReward: 1, best: 1 } })

    const twice = await m.post('/v1/streak/claim')
    expect(twice.status).toBe(409)
    expect(twice.body.error).toMatchObject({ code: 'ALREADY_CLAIMED', message: 'You have already claimed today. Come back tomorrow.' })

    travelDays(1)
    // Not yet claimed today: the streak is still alive
    expect((await m.get('/v1/streak')).body).toMatchObject({ current: 1, claimedToday: false, nextReward: 1 })
    expect((await m.post('/v1/streak/claim')).body).toMatchObject({ raffs: 1, state: { current: 2 } })
    travelDays(1)
    expect((await m.post('/v1/streak/claim')).body).toMatchObject({ raffs: 2, balance: 4, state: { current: 3, nextReward: 2 } })

    travelDays(2) // a day missed
    expect((await m.get('/v1/streak')).body).toMatchObject({ current: 0, claimedToday: false, nextReward: 1, best: 3 })
    const restart = (await m.post('/v1/streak/claim')).body as StreakClaimResult
    expect(restart).toMatchObject({ raffs: 1, state: { current: 1, best: 3 } })

    const rows = await db.select().from(ledger).where(and(eq(ledger.userId, m.userId), eq(ledger.type, 'bonus')))
    expect(rows.map((r) => r.note).sort()).toEqual(['Daily streak day 1', 'Daily streak day 1', 'Daily streak day 2', 'Daily streak day 3'])
    expect(rows.every((r) => r.referenceType === 'daily_streak')).toBe(true)
    expect(await balanceOf(m.userId)).toBe(5)
  })

  it('repeats the last reward past the end of the list, and writes no ledger row for a zero reward', async () => {
    const m = await member(http)
    await turnOn('daily_streak', m)
    await putSetting(db, 'streak.rewards', [0, 3], null)
    try {
      expect((await m.post('/v1/streak/claim')).body).toMatchObject({ raffs: 0, balance: 0, state: { nextReward: 3 } })
      travelDays(1)
      expect((await m.post('/v1/streak/claim')).body).toMatchObject({ raffs: 3 })
      travelDays(1)
      expect((await m.post('/v1/streak/claim')).body).toMatchObject({ raffs: 3, balance: 6, state: { current: 3 } })
      const checkins = await db.select().from(dailyCheckins).where(eq(dailyCheckins.userId, m.userId))
      expect(checkins).toHaveLength(3)
      expect(checkins.find((c) => c.streak === 1)?.ledgerId).toBeNull()
      expect(await balanceOf(m.userId)).toBe(6)
    } finally {
      await putSetting(db, 'streak.rewards', [1, 1, 2, 2, 3, 3, 5], null)
    }
  })

  it('pays one claim when several taps arrive at once', async () => {
    const m = await member(http)
    await turnOn('daily_streak', m)
    const results = await Promise.all(Array.from({ length: 4 }, () => m.post('/v1/streak/claim')))
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'ALREADY_CLAIMED')).toBe(true)
    expect(await balanceOf(m.userId)).toBe(1)
  })
})

/* Send Raffs -------------------------------------------------------------------- */

describe('Send Raffs', () => {
  const send = (m: Member, to: string, raffs: number, key = randomUUID(), note?: string) =>
    m.post('/v1/transfers', { to, raffs, idempotencyKey: key, ...(note ? { note } : {}) })

  async function sender(raffs = 500): Promise<Member> {
    const m = await withPhone()
    await turnOn('raffs_transfer', m)
    if (raffs > 0) await credit(db, m.userId, raffs)
    return m
  }

  it('is refused while the feature is off, and works for a player switched on while it is off globally', async () => {
    const m = await withPhone()
    const to = await member(http)
    await credit(db, m.userId, 50)
    for (const res of [await m.get('/v1/transfers/limits'), await m.get(`/v1/transfers/recipient?username=${to.username}`), await send(m, to.username, 5)]) {
      expect(res.status).toBe(403)
      expect(res.body.error).toMatchObject({ code: 'FEATURE_OFF', message: 'Send Raffs is not available right now.' })
    }
    await turnOn('raffs_transfer', m)
    expect((await send(m, to.username, 5)).status).toBe(201)
  })

  it('looks up the recipient by username, refusing unknown names, yourself and suspended players', async () => {
    const m = await sender(0)
    const to = await member(http)
    const found = await m.get(`/v1/transfers/recipient?username=${encodeURIComponent(`@${to.username.toUpperCase()}`)}`)
    expect(found.status, JSON.stringify(found.body)).toBe(200)
    expect(found.body).toEqual({ username: to.username, displayName: 'Ada' })

    const unknown = await m.get('/v1/transfers/recipient?username=nobody_here_zz')
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.message).toBe('No Raffle Win player with that username.')
    expect((await m.get(`/v1/transfers/recipient?username=${m.username}`)).body.error.code).toBe('INVALID_INPUT')

    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, to.userId))
    expect((await m.get(`/v1/transfers/recipient?username=${to.username}`)).body.error.code).toBe('INVALID_INPUT')
    expect((await m.get('/v1/transfers/recipient')).status).toBe(400)
  })

  it('moves the Raffs through the ledger, records the transfer and messages the recipient', async () => {
    const from = await sender(100)
    const to = await member(http)
    const res = await send(from, `@${to.username}`, 30, randomUUID(), 'For your entry <3')
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body).toMatchObject({ toUsername: to.username, raffs: 30, balance: 70 })

    expect(await balanceOf(from.userId)).toBe(70)
    expect(await balanceOf(to.userId)).toBe(30)
    const [out] = await db.select().from(ledger).where(and(eq(ledger.userId, from.userId), eq(ledger.type, 'transfer_out')))
    const [inn] = await db.select().from(ledger).where(and(eq(ledger.userId, to.userId), eq(ledger.type, 'transfer_in')))
    expect(out).toMatchObject({ raffs: -30, note: `Sent to @${to.username}`, referenceType: 'raffs_transfer', referenceId: res.body.id })
    expect(inn).toMatchObject({ raffs: 30, note: `From @${from.username}`, referenceId: res.body.id })
    const [row] = await db.select().from(raffsTransfers).where(eq(raffsTransfers.id, res.body.id))
    expect(row).toMatchObject({ fromUserId: from.userId, toUserId: to.userId, raffs: 30, note: 'For your entry <3', outLedgerId: out?.id, inLedgerId: inn?.id })

    const [note] = await db.select().from(notifications).where(and(eq(notifications.userId, to.userId), eq(notifications.kind, 'transfer')))
    expect(note).toMatchObject({ status: 'pending', dedupeKey: `transfer:${res.body.id}`, telegramId: to.telegramId })
    expect(note?.text).toContain(`@${from.username} sent you 30 Raffs`)
    expect(note?.text).toContain('For your entry &lt;3')
    expect(note?.buttons).toEqual([[{ text: 'Open my wallet', webApp: `${APP_URL}#/wallet` }]])

    const history = (await to.get('/v1/transactions')).body as { type: string; raffs: number }[]
    expect(history[0]).toMatchObject({ type: 'transfer_in', raffs: 30 })
    const limits = (await from.get('/v1/transfers/limits')).body as TransferLimits
    expect(limits).toEqual({ minRaffs: 1, dailyMaxRaffs: 1000, sentToday: 30 })
  })

  it('refuses with a clear reason: no phone, too small, over the daily cap, not enough Raffs', async () => {
    const noPhone = await member(http)
    await turnOn('raffs_transfer', noPhone)
    await credit(db, noPhone.userId, 100)
    const to = await member(http)
    const phoneless = await send(noPhone, to.username, 5)
    expect(phoneless.status).toBe(422)
    expect(phoneless.body.error.code).toBe('PHONE_REQUIRED')
    expect(await balanceOf(noPhone.userId)).toBe(100)

    const from = await sender(1000)
    await putSetting(db, 'transfers.min_raffs', 5, null)
    await putSetting(db, 'transfers.daily_max_raffs', 100, null)
    try {
      const small = await send(from, to.username, 4)
      expect(small.status).toBe(400)
      expect(small.body.error.message).toBe('The smallest transfer is 5 Raffs.')

      expect((await send(from, to.username, 60)).status).toBe(201)
      const over = await send(from, to.username, 50)
      expect(over.status).toBe(409)
      expect(over.body.error).toMatchObject({ code: 'LIMIT_REACHED', message: 'You can send up to 100 Raffs a day; 40 left today.' })
      expect((await send(from, to.username, 40)).status).toBe(201)
      expect((await send(from, to.username, 5)).body.error.message).toBe('You have sent the most allowed today (100 Raffs). Try again tomorrow.')
    } finally {
      await putSetting(db, 'transfers.min_raffs', 1, null)
      await putSetting(db, 'transfers.daily_max_raffs', 1000, null)
    }

    const poor = await sender(10)
    const broke = await send(poor, to.username, 25)
    expect(broke.status).toBe(409)
    expect(broke.body.error).toMatchObject({ code: 'INSUFFICIENT_FUNDS', message: 'You have 10 Raffs; you need 15 more to send this.' })
    expect((await send(poor, poor.username, 1)).body.error.code).toBe('INVALID_INPUT')
    expect((await send(poor, 'nobody_here_zz', 1)).status).toBe(404)
    expect(await balanceOf(poor.userId)).toBe(10)
  })

  it('returns the same transfer for a retried tap, sending once', async () => {
    const from = await sender(100)
    const to = await member(http)
    const key = randomUUID()
    const results = await Promise.all([send(from, to.username, 20, key), send(from, to.username, 20, key), send(from, to.username, 20, key)])
    expect(results.every((r) => r.status === 201)).toBe(true)
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1)
    expect(await balanceOf(from.userId)).toBe(80)
    expect(await balanceOf(to.userId)).toBe(20)
    const sent = await db.select().from(notifications).where(and(eq(notifications.userId, to.userId), eq(notifications.kind, 'transfer')))
    expect(sent).toHaveLength(1)
  })

  it('returns the original for a retry after the Raffs and the daily cap are spent, never a refusal', async () => {
    const from = await sender(20)
    const to = await member(http)
    const key = randomUUID()
    const first = await send(from, to.username, 20, key)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    expect(first.body).toMatchObject({ raffs: 20, balance: 0 })
    const retry = await send(from, to.username, 20, key)
    expect(retry.status, JSON.stringify(retry.body)).toBe(201)
    expect(retry.body).toEqual(first.body)

    await credit(db, from.userId, 50)
    await putSetting(db, 'transfers.daily_max_raffs', 20, null)
    try {
      expect((await send(from, to.username, 20, key)).body.id).toBe(first.body.id)
      expect((await send(from, to.username, 5)).body.error.code).toBe('LIMIT_REACHED')
    } finally {
      await putSetting(db, 'transfers.daily_max_raffs', 1000, null)
    }
    expect(await balanceOf(from.userId)).toBe(50)
    expect(await balanceOf(to.userId)).toBe(20)
  })

  it('returns the original to duplicates that arrive together and would each spend the whole balance', async () => {
    const from = await sender(20)
    const to = await member(http)
    const key = randomUUID()
    // The duplicates queue on the sender's lock behind the first; once it commits the balance is 0
    const results = await Promise.all(Array.from({ length: 4 }, () => send(from, to.username, 20, key)))
    expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body))).toEqual([201, 201, 201, 201])
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1)
    expect(await balanceOf(from.userId)).toBe(0)
    expect(await balanceOf(to.userId)).toBe(20)
    expect(await db.select().from(raffsTransfers).where(eq(raffsTransfers.fromUserId, from.userId))).toHaveLength(1)
    const sent = await db.select().from(notifications).where(and(eq(notifications.userId, to.userId), eq(notifications.kind, 'transfer')))
    expect(sent).toHaveLength(1)
  })

  it('never overdraws when transfers race, even between the same two players both ways', async () => {
    const a = await sender(100)
    const b = await sender(100)
    const c = await member(http)
    // a can reach at most 130 (100 + 30 from b): never enough for both of its 70s
    const results = await Promise.all([send(a, c.username, 70), send(a, b.username, 70), send(b, a.username, 30), send(b, c.username, 50)])
    const okFromA = results.slice(0, 2).filter((r) => r.status === 201)
    expect(okFromA).toHaveLength(1)
    expect(results.slice(0, 2).find((r) => r.status !== 201)?.body.error.code).toBe('INSUFFICIENT_FUNDS')
    const balances = [await balanceOf(a.userId), await balanceOf(b.userId), await balanceOf(c.userId)]
    expect(balances.every((v) => (v ?? -1) >= 0)).toBe(true)
    expect(balances.reduce<number>((s, v) => s + (v ?? 0), 0)).toBe(200)
  })
})
