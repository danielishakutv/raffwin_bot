/**
 * Feature switches and the bot's outbox: queueing, broadcast fan-out and the
 * sender, against the real database with a fake ctx.sendTelegram. The test
 * schema is shared with the other files (which run first), so every check
 * looks at this file's own players and rows, never at global counts.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURE_KEYS, type FeatureKey } from '@raffwin/shared'
import type { SendOptions, SendTelegram } from '../src/context'
import { broadcasts, featureFlagOverrides, notifications, settings, users, type UserRow } from '../src/db/schema'
import { HttpError } from '../src/lib/http-error'
import {
  clearOverride,
  featureSql,
  featuresFor,
  getGlobalFlags,
  isFeatureOn,
  requireFeature,
  setGlobal,
  setOverride,
} from '../src/services/features'
import { lagosHour, nextQuietEnd } from '../src/services/engagement'
import {
  broadcastText,
  classifySendError,
  createBroadcast,
  enqueue,
  fanOutOnce,
  openAppButton,
  OUTBOX_PAUSE_KEY,
  outboxPausedUntil,
  sendPendingOnce,
  type StoredAudience,
} from '../src/services/notify'
import { getAllSettings, putSetting } from '../src/services/settings'
import { startWorkers } from '../src/services/worker'
import { telegramId, testApp, uniqueUsername } from './helpers'

const APP_URL = 'https://raffwintest.example/'
const { ctx, db, clock } = testApp({ PUBLIC_APP_URL: APP_URL })

/* Fixtures ------------------------------------------------------------------ */

async function player(overrides: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  const now = new Date(ctx.now())
  const [row] = await db
    .insert(users)
    .values({
      telegramId: telegramId(),
      username: uniqueUsername('n'),
      tgFirstName: 'Ada',
      referralCode: randomBytes(6).toString('hex').toUpperCase(),
      signedUpAt: now,
      lastSeenAt: now,
      ...overrides,
    })
    .returning()
  if (!row) throw new Error('user insert failed')
  return row
}

interface SentCall {
  chatId: number
  text: string
  opts?: SendOptions
}

/** A fake bot: records each message; `fail` decides per chat whether Telegram refuses it. */
function fakeBot() {
  const calls: SentCall[] = []
  let messageId = 500
  const state = { fail: null as null | ((chatId: number) => unknown) }
  const send: SendTelegram = async (chatId, text, opts) => {
    calls.push({ chatId, text, opts })
    const error = state.fail?.(chatId)
    if (error) throw error
    return { messageId: (messageId += 1) }
  }
  return { calls, send, state }
}

async function rowsFor(userIds: string[]) {
  return db.select().from(notifications).where(inArray(notifications.userId, userIds))
}

async function rowById(id: string) {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id))
  if (!row) throw new Error(`no notification ${id}`)
  return row
}

/** Queues one message and returns its row id. */
async function queue(user: UserRow, kind: (typeof notifications.$inferInsert)['kind'] = 'announcement', notBefore?: Date) {
  const dedupeKey = `t:${randomBytes(6).toString('hex')}`
  expect(await enqueue(db, { userId: user.id, telegramId: user.telegramId, kind, text: `hello ${kind}`, dedupeKey, notBefore })).toBe(
    'queued',
  )
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, user.id), eq(notifications.dedupeKey, dedupeKey)))
  return row!.id
}

const send = (max?: number) => sendPendingOnce(ctx, { max, gapMs: 0 })

/* Isolation: earlier files' leftovers, and this file's own between tests ----- */

const flagsBefore = new Map<FeatureKey, boolean>()
const QUIET_KEYS = ['engagement.quiet_start_hour', 'engagement.quiet_end_hour'] as const
const quietBefore = new Map<(typeof QUIET_KEYS)[number], number>()

/** Quiet hours from `start` to `end` (Lagos); equal = never quiet, as most tests here need whatever the hour. */
async function setQuietHours(start: number, end: number) {
  await putSetting(db, 'engagement.quiet_start_hour', start, null)
  await putSetting(db, 'engagement.quiet_end_hour', end, null)
}

/** No 429 pause left over from a test (each file's clock differs, so one could outlast it). An update, nothing deleted. */
async function clearPause() {
  await db.update(settings).set({ value: { v: 0 } }).where(eq(settings.key, OUTBOX_PAUSE_KEY))
}

/** Nothing left due from another test: closes every open row in this schema (an update; nothing is deleted). */
async function settleOutbox() {
  await db
    .update(notifications)
    .set({ status: 'skipped', error: 'test cleanup', lockedAt: null })
    .where(inArray(notifications.status, ['pending', 'sending']))
}

beforeAll(async () => {
  const flags = await getGlobalFlags(db)
  for (const k of FEATURE_KEYS) flagsBefore.set(k, flags[k])
  const all = await getAllSettings(db)
  for (const k of QUIET_KEYS) quietBefore.set(k, all[k] as number)
  await setQuietHours(0, 0)
  await clearPause()
  // Broadcasts other files left fanning out would otherwise reach this file's players
  await fanOutOnce(ctx, 1000, 1000)
  await settleOutbox()
})

afterEach(async () => {
  ctx.sendTelegram = undefined
  await settleOutbox()
  await clearPause()
})

afterAll(async () => {
  // Later files expect the switches and settings as they found them
  await db.transaction(async (tx) => {
    for (const [k, v] of flagsBefore) await setGlobal(tx, k, v, null)
  })
  for (const [k, v] of quietBefore) await putSetting(db, k, v, null)
})

/* Features -------------------------------------------------------------------- */

describe('feature switches', () => {
  it('global switch, per-player override, clear, and the same answer from featureSql', async () => {
    const a = await player()
    const b = await player()
    await db.transaction((tx) => setGlobal(tx, 'raffs_transfer', false, null))
    expect((await getGlobalFlags(db)).raffs_transfer).toBe(false)
    expect(await isFeatureOn(db, 'raffs_transfer', null)).toBe(false)

    const override = await db.transaction((tx) => setOverride(tx, 'raffs_transfer', a.id, true, 'beta tester', null))
    expect((await featuresFor(db, a.id)).raffs_transfer).toBe(true)
    expect((await featuresFor(db, b.id)).raffs_transfer).toBe(false)
    expect(await isFeatureOn(db, 'raffs_transfer', a.id)).toBe(true)
    expect(await isFeatureOn(db, 'raffs_transfer', null)).toBe(false)

    // In a bulk select FROM users, same rule
    const viaSql = await db
      .select({ id: users.id, on: sql<boolean>`${featureSql('raffs_transfer')}` })
      .from(users)
      .where(inArray(users.id, [a.id, b.id]))
    expect(Object.fromEntries(viaSql.map((r) => [r.id, r.on]))).toEqual({ [a.id]: true, [b.id]: false })

    // A second override replaces the first; the first stays as history
    const second = await db.transaction((tx) => setOverride(tx, 'raffs_transfer', a.id, false, 'paused', null))
    const all = await db.select().from(featureFlagOverrides).where(eq(featureFlagOverrides.userId, a.id))
    expect(all).toHaveLength(2)
    expect(all.find((o) => o.id === override.id)?.clearedAt).not.toBeNull()
    expect((await featuresFor(db, a.id)).raffs_transfer).toBe(false)

    // Global on: b follows it, a's live "off" override still wins
    await db.transaction((tx) => setGlobal(tx, 'raffs_transfer', true, null))
    expect((await featuresFor(db, b.id)).raffs_transfer).toBe(true)
    expect((await featuresFor(db, a.id)).raffs_transfer).toBe(false)

    expect(await db.transaction((tx) => clearOverride(tx, second.id, null))).not.toBeNull()
    expect((await featuresFor(db, a.id)).raffs_transfer).toBe(true)
    expect(await db.transaction((tx) => clearOverride(tx, second.id, null))).toBeNull()
  })

  it('featureSql falls back to the registry default when nobody has touched the switch', async () => {
    const a = await player()
    const [row] = await db
      .select({ on: sql<boolean>`${featureSql('reminders')}` })
      .from(users)
      .where(eq(users.id, a.id))
    expect(row?.on).toBe((await getGlobalFlags(db)).reminders)
  })

  it('requireFeature refuses with FEATURE_OFF (403) naming the feature', async () => {
    const a = await player()
    await db.transaction((tx) => setGlobal(tx, 'daily_streak', false, null))
    const error = await requireFeature(db, 'daily_streak', a.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ code: 'FEATURE_OFF', status: 403, message: 'Daily streak is not available right now.' })
    await db.transaction((tx) => setOverride(tx, 'daily_streak', a.id, true, 'tester', null))
    await expect(requireFeature(db, 'daily_streak', a.id)).resolves.toBeUndefined()
  })
})

/* Queueing -------------------------------------------------------------------- */

describe('enqueue', () => {
  it('is idempotent per player and dedupe key', async () => {
    const a = await player()
    const b = await player()
    const base = { kind: 'transfer' as const, text: 'x', dedupeKey: 'transfer:1' }
    expect(await enqueue(db, { ...base, userId: a.id, telegramId: a.telegramId })).toBe('queued')
    expect(await enqueue(db, { ...base, userId: a.id, telegramId: a.telegramId })).toBe('duplicate')
    expect(await enqueue(db, { ...base, userId: b.id, telegramId: b.telegramId })).toBe('queued')
    // No key: every call queues
    expect(await enqueue(db, { userId: a.id, telegramId: a.telegramId, kind: 'system', text: 'y' })).toBe('queued')
    expect(await enqueue(db, { userId: a.id, telegramId: a.telegramId, kind: 'system', text: 'y' })).toBe('queued')
    expect(await rowsFor([a.id])).toHaveLength(3)
  })

  it('builds the open button from PUBLIC_APP_URL, or none without it', () => {
    expect(openAppButton(ctx)).toEqual({ text: 'Open Raffle Win', webApp: APP_URL })
    expect(openAppButton(ctx, 'Wallet', '/wallet')).toEqual({ text: 'Wallet', webApp: `${APP_URL}#/wallet` })
    expect(openAppButton({ config: { ...ctx.config, PUBLIC_APP_URL: undefined } })).toBeNull()
  })

  it('escapes broadcast text and bolds the title', () => {
    expect(broadcastText({ title: 'Tom & Jerry', text: 'a <b>b</b> "c"' })).toBe(
      '<b>Tom &amp; Jerry</b>\n\na &lt;b&gt;b&lt;/b&gt; &quot;c&quot;',
    )
    expect(broadcastText({ title: '', text: '1 < 2' })).toBe('1 &lt; 2')
  })
})

/* Fan-out --------------------------------------------------------------------- */

describe('fanOutOnce', () => {
  async function cast(audience: StoredAudience, kind: (typeof broadcasts.$inferInsert)['kind'] = 'announcement') {
    return createBroadcast(db, { kind, title: 'Notice', text: 'Hello <all>', openButton: true, audience })
  }
  async function broadcastRow(id: string) {
    const [row] = await db.select().from(broadcasts).where(eq(broadcasts.id, id))
    return row!
  }
  async function reached(broadcastId: string, mine: UserRow[]) {
    const rows = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(and(eq(notifications.broadcastId, broadcastId), inArray(notifications.userId, mine.map((u) => u.id))))
    const ids = new Set(rows.map((r) => r.userId))
    return mine.filter((u) => ids.has(u.id))
  }

  let withPhone: UserRow, noPhone: UserRow, away: UserRow, blocked: UserRow, suspended: UserRow, mine: UserRow[]
  beforeAll(async () => {
    const now = ctx.now()
    withPhone = await player({ phone: `+234803${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, phoneVerifiedAt: new Date(now) })
    noPhone = await player()
    away = await player({ lastSeenAt: new Date(now - 10 * 86_400_000) })
    blocked = await player({ botBlockedAt: new Date(now) })
    suspended = await player({ status: 'suspended' })
    mine = [withPhone, noPhone, away, blocked, suspended]
  })

  it("audience 'all': every active player who has not blocked the bot, once", async () => {
    const b = await cast({ type: 'all' })
    await fanOutOnce(ctx)
    expect(await reached(b.id, mine)).toEqual([withPhone, noPhone, away])
    const row = await broadcastRow(b.id)
    expect(row.status).toBe('sending')
    expect(row.total).toBeGreaterThanOrEqual(3)

    const [n] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.broadcastId, b.id), eq(notifications.userId, withPhone.id)))
    expect(n).toMatchObject({
      kind: 'announcement',
      status: 'pending',
      dedupeKey: `b:${b.id}`,
      telegramId: withPhone.telegramId,
      text: '<b>Notice</b>\n\nHello &lt;all&gt;',
      buttons: [[{ text: 'Open Raffle Win', webApp: APP_URL }]],
    })

    // A second pass queues nothing more for it
    const total = row.total
    await fanOutOnce(ctx)
    expect((await broadcastRow(b.id)).total).toBe(total)
    expect(await db.select().from(notifications).where(eq(notifications.broadcastId, b.id))).toHaveLength(total)
  })

  it("audience 'no_phone' and 'inactive'", async () => {
    const np = await cast({ type: 'no_phone' })
    const ia = await cast({ type: 'inactive', days: 3 })
    await fanOutOnce(ctx)
    expect(await reached(np.id, mine)).toEqual([noPhone, away])
    expect(await reached(ia.id, mine)).toEqual([away])
  })

  it("audience 'users': only the listed players, still never blocked or suspended ones", async () => {
    const b = await cast({ type: 'users', userIds: [withPhone.id, blocked.id, suspended.id] })
    await fanOutOnce(ctx)
    expect(await reached(b.id, mine)).toEqual([withPhone])
    expect(await broadcastRow(b.id)).toMatchObject({ total: 1, status: 'sending' })
  })

  it('an empty audience is done in the same pass', async () => {
    const b = await cast({ type: 'users', userIds: [] })
    const result = await fanOutOnce(ctx)
    expect(result.finished).toBeGreaterThanOrEqual(1)
    const row = await broadcastRow(b.id)
    expect(row).toMatchObject({ status: 'done', total: 0 })
    expect(row.finishedAt).not.toBeNull()
  })

  it('works in batches from the cursor, a few per pass', async () => {
    const b = await cast({ type: 'users', userIds: [withPhone.id, noPhone.id, away.id] })
    await fanOutOnce(ctx, 2, 1)
    expect(await broadcastRow(b.id)).toMatchObject({ status: 'fanning_out', total: 2 })
    await fanOutOnce(ctx, 2, 1)
    expect(await broadcastRow(b.id)).toMatchObject({ status: 'fanning_out', total: 3 })
    await fanOutOnce(ctx, 2, 1)
    expect(await broadcastRow(b.id)).toMatchObject({ status: 'sending', total: 3 })
    expect(await reached(b.id, mine)).toEqual([withPhone, noPhone, away])
  })

  it('new raffle alerts skip players for whom new_raffle_alerts is off', async () => {
    await db.transaction((tx) => setGlobal(tx, 'new_raffle_alerts', true, null))
    await db.transaction((tx) => setOverride(tx, 'new_raffle_alerts', noPhone.id, false, 'asked for no alerts', null))
    const on = await cast({ type: 'users', userIds: [withPhone.id, noPhone.id] }, 'raffle_new')
    await fanOutOnce(ctx)
    expect(await reached(on.id, mine)).toEqual([withPhone])
    const [n] = await db.select().from(notifications).where(eq(notifications.broadcastId, on.id))
    expect(n?.kind).toBe('raffle_new')

    // Globally off, one player switched on: only that player
    await db.transaction((tx) => setGlobal(tx, 'new_raffle_alerts', false, null))
    await db.transaction((tx) => setOverride(tx, 'new_raffle_alerts', away.id, true, 'wants alerts', null))
    const off = await cast({ type: 'users', userIds: [withPhone.id, noPhone.id, away.id] }, 'raffle_new')
    await fanOutOnce(ctx)
    expect(await reached(off.id, mine)).toEqual([away])

    // Announcements ignore that switch
    const notice = await cast({ type: 'users', userIds: [withPhone.id, noPhone.id] })
    await fanOutOnce(ctx)
    expect(await reached(notice.id, mine)).toEqual([withPhone, noPhone])
    await db.transaction((tx) => setGlobal(tx, 'new_raffle_alerts', true, null))
  })

  it('reminders opt-out does not block announcements', async () => {
    const quiet = await player({ remindersOptOutAt: new Date(ctx.now()) })
    const b = await cast({ type: 'users', userIds: [quiet.id] })
    await fanOutOnce(ctx)
    const bot = fakeBot()
    ctx.sendTelegram = bot.send
    await send()
    const [n] = await rowsFor([quiet.id])
    expect(n?.status).toBe('sent')
    expect(bot.calls.map((c) => c.chatId)).toEqual([quiet.telegramId])
    expect((await fanOutOnce(ctx)).finished).toBeGreaterThanOrEqual(1)
    expect((await broadcastRow(b.id)).status).toBe('done')
  })

  it('a cancelled broadcast is never fanned out', async () => {
    const b = await cast({ type: 'users', userIds: [withPhone.id] })
    await db.update(broadcasts).set({ status: 'cancelled' }).where(eq(broadcasts.id, b.id))
    await fanOutOnce(ctx)
    expect(await reached(b.id, mine)).toEqual([])
    expect((await broadcastRow(b.id)).status).toBe('cancelled')
  })

  it('becomes done once nothing of it is pending (sent, failed and skipped all count)', async () => {
    const extra = await player()
    const b = await cast({ type: 'users', userIds: [withPhone.id, extra.id] })
    await fanOutOnce(ctx)
    const bot = fakeBot()
    bot.state.fail = (chatId) => (chatId === extra.telegramId ? { error_code: 403, description: 'Forbidden: bot was blocked by the user' } : null)
    ctx.sendTelegram = bot.send
    expect((await broadcastRow(b.id)).status).toBe('sending')
    await send()
    await fanOutOnce(ctx)
    const row = await broadcastRow(b.id)
    expect(row.status).toBe('done')
    expect(row.finishedAt).not.toBeNull()
  })

  it('a broadcast that fails never holds up newer ones or the done step', async () => {
    const broken = await cast({ type: 'nobody_knows' } as never)
    const error = vi.spyOn(ctx.log, 'error')
    try {
      const b = await cast({ type: 'users', userIds: [withPhone.id] })
      await expect(fanOutOnce(ctx)).resolves.toMatchObject({ queued: expect.any(Number) })
      expect(await reached(b.id, mine)).toEqual([withPhone])
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ broadcastId: broken.id }), expect.stringContaining('fan-out failed'))
      expect((await broadcastRow(broken.id)).status).toBe('fanning_out')

      ctx.sendTelegram = fakeBot().send
      await send()
      await fanOutOnce(ctx)
      expect((await broadcastRow(b.id)).status).toBe('done')
    } finally {
      error.mockRestore()
      // Not left for later passes (other files) to trip over
      await db.update(broadcasts).set({ status: 'cancelled' }).where(eq(broadcasts.id, broken.id))
    }
  })

  it("a 'users' audience longer than the 65535 bind parameters Postgres takes", async () => {
    const strangers = Array.from({ length: 70_000 }, () => randomUUID())
    const b = await cast({ type: 'users', userIds: [...strangers, noPhone.id, withPhone.id] })
    await fanOutOnce(ctx)
    expect(await reached(b.id, mine)).toEqual([withPhone, noPhone])
    expect(await broadcastRow(b.id)).toMatchObject({ status: 'sending', total: 2 })
  })
})

/* Sending --------------------------------------------------------------------- */

describe('sendPendingOnce', () => {
  it('sends due messages as HTML with their buttons and records the message id', async () => {
    const a = await player()
    const button = openAppButton(ctx)!
    await enqueue(db, { userId: a.id, telegramId: a.telegramId, kind: 'system', text: '<b>hi</b>', buttons: [[button]] })
    const bot = fakeBot()
    ctx.sendTelegram = bot.send
    const counts = await send()
    expect(counts.sent).toBe(1)
    expect(bot.calls).toEqual([{ chatId: a.telegramId, text: '<b>hi</b>', opts: { html: true, buttons: [[button]] } }])
    const [row] = await rowsFor([a.id])
    expect(row).toMatchObject({ status: 'sent', attempts: 1, lockedAt: null, error: null, telegramMessageId: 501 })
    expect(row?.sentAt).not.toBeNull()
  })

  it('waits for not_before', async () => {
    const a = await player()
    const id = await queue(a, 'reminder', new Date(ctx.now() + 3_600_000))
    ctx.sendTelegram = fakeBot().send
    await send()
    expect((await rowById(id)).status).toBe('pending')
    clock.advance(3_601)
    await send()
    expect((await rowById(id)).status).toBe('sent')
  })

  it('429: back to pending after retry_after, not counted as an attempt, and the rest of the pass waits too', async () => {
    const a = await player()
    const b = await player()
    const first = await queue(a)
    const second = await queue(b)
    const bot = fakeBot()
    bot.state.fail = () => ({ error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } })
    ctx.sendTelegram = bot.send
    const counts = await send()
    expect(counts).toMatchObject({ sent: 0, retried: 2 })
    expect(bot.calls).toHaveLength(1)
    for (const id of [first, second]) {
      const row = await rowById(id)
      expect(row).toMatchObject({ status: 'pending', attempts: 0, lockedAt: null })
      expect(row.notBefore.getTime()).toBeGreaterThanOrEqual(ctx.now() + 6_000)
      expect(row.error).toContain('429')
    }
    await send()
    expect(bot.calls).toHaveLength(1)

    bot.state.fail = null
    clock.advance(8)
    await send()
    expect((await rowById(first)).status).toBe('sent')
    expect((await rowById(second)).status).toBe('sent')
  })

  it('429 pauses every sender: rows it never claimed and rows queued after it wait out retry_after too', async () => {
    const a = await player()
    const claimedRow = await queue(a)
    const unclaimed = await queue(a)
    const bot = fakeBot()
    bot.state.fail = () => ({ error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } })
    ctx.sendTelegram = bot.send
    expect(await send(1)).toMatchObject({ sent: 0, retried: 1 })
    const until = await outboxPausedUntil(db)
    expect(until).toBeGreaterThanOrEqual(ctx.now() + 6_000)
    expect(until).toBeLessThanOrEqual(ctx.now() + 7_000)
    // Due, but not claimed in that pass: moved past the pause as well
    const waiting = await rowById(unclaimed)
    expect(waiting).toMatchObject({ status: 'pending', attempts: 0 })
    expect(waiting.notBefore.getTime()).toBe(until)

    // Queued after the 429, so due now: still nothing goes out while the pause lasts (any sender, any process)
    bot.state.fail = null
    const late = await queue(a)
    expect(await send()).toEqual({ sent: 0, failed: 0, retried: 0, skipped: 0 })
    expect(bot.calls).toHaveLength(1)
    expect((await rowById(late)).status).toBe('pending')

    clock.advance(8)
    expect((await send()).sent).toBe(3)
    for (const id of [claimedRow, unclaimed, late]) expect((await rowById(id)).status).toBe('sent')
  })

  it('claims personal messages first: transfers, then reminders and offers, then broadcasts; oldest first within each', async () => {
    const a = await player()
    const minuteAgo = new Date(ctx.now() - 60_000)
    const ids = {
      announcement: await queue(a, 'announcement', new Date(ctx.now() - 120_000)),
      raffle: await queue(a, 'raffle_new', minuteAgo),
      reminder: await queue(a, 'reminder', minuteAgo),
      comeback: await queue(a, 'comeback', new Date(ctx.now() - 90_000)),
      transfer: await queue(a, 'transfer'),
    }
    const bot = fakeBot()
    ctx.sendTelegram = bot.send
    // One per pass: the claim order
    expect((await send(1)).sent).toBe(1)
    expect((await rowById(ids.transfer)).status).toBe('sent')
    expect((await send(1)).sent).toBe(1)
    expect((await rowById(ids.comeback)).status).toBe('sent')
    expect((await send(1)).sent).toBe(1)
    expect((await rowById(ids.reminder)).status).toBe('sent')
    expect((await rowById(ids.announcement)).status).toBe('pending')
    // The rest in one pass: broadcasts, oldest first
    expect((await send()).sent).toBe(2)
    expect(bot.calls.map((c) => c.text)).toEqual(['hello transfer', 'hello comeback', 'hello reminder', 'hello announcement', 'hello raffle_new'])

    // And within one pass the claimed rows go out in the same order
    const t = await queue(a, 'announcement', new Date(ctx.now() - 60_000))
    const r = await queue(a, 'reminder')
    const x = await queue(a, 'transfer')
    expect((await send()).sent).toBe(3)
    expect(bot.calls.slice(-3).map((c) => c.text)).toEqual(['hello transfer', 'hello reminder', 'hello announcement'])
    for (const id of [t, r, x]) expect((await rowById(id)).status).toBe('sent')
  })

  it('a reminder or offer that reaches the sender in quiet hours waits for the morning; other kinds still go', async () => {
    const a = await player()
    const hour = lagosHour(ctx.now())
    const end = (hour + 1) % 24
    await setQuietHours(hour, end)
    try {
      const reminder = await queue(a, 'reminder')
      const comeback = await queue(a, 'comeback')
      const announcement = await queue(a, 'announcement')
      const bot = fakeBot()
      ctx.sendTelegram = bot.send
      expect(await send()).toMatchObject({ sent: 1, retried: 2 })
      expect(bot.calls.map((c) => c.text)).toEqual(['hello announcement'])
      expect((await rowById(announcement)).status).toBe('sent')
      const quietEnd = nextQuietEnd(ctx.now(), end)
      for (const id of [reminder, comeback]) {
        const row = await rowById(id)
        // Not an attempt: the claim's count is given back
        expect(row).toMatchObject({ status: 'pending', attempts: 0, lockedAt: null })
        expect(row.notBefore.getTime()).toBeGreaterThanOrEqual(quietEnd)
        expect(row.notBefore.getTime()).toBeLessThanOrEqual(quietEnd + 90 * 60_000)
      }
      // After the morning spread, out they go
      clock.advance((quietEnd + 90 * 60_000 - ctx.now()) / 1000 + 1)
      expect((await send()).sent).toBe(2)
    } finally {
      await setQuietHours(0, 0)
    }
  })

  it('403 or a gone chat: failed, and the player is marked as having blocked the bot', async () => {
    const a = await player()
    const c = await player()
    const forbidden = await queue(a)
    const gone = await queue(c)
    const bot = fakeBot()
    bot.state.fail = (chatId) =>
      chatId === a.telegramId
        ? { error_code: 403, description: 'Forbidden: bot was blocked by the user' }
        : { error_code: 400, description: 'Bad Request: chat not found' }
    ctx.sendTelegram = bot.send
    expect(await send()).toMatchObject({ failed: 2, sent: 0 })
    for (const [id, user] of [
      [forbidden, a],
      [gone, c],
    ] as const) {
      expect((await rowById(id)).status).toBe('failed')
      const [u] = await db.select({ botBlockedAt: users.botBlockedAt }).from(users).where(eq(users.id, user.id))
      expect(u?.botBlockedAt).not.toBeNull()
    }
    // The next message to a blocked player is skipped without calling Telegram
    const later = await queue(a)
    expect(await send()).toMatchObject({ skipped: 1 })
    expect(await rowById(later)).toMatchObject({ status: 'skipped', error: 'blocked' })
    expect(bot.calls).toHaveLength(2)
  })

  it('other errors back off 1, 5, 30, 30 minutes and fail on the 5th attempt, keeping the error', async () => {
    const a = await player()
    const id = await queue(a)
    const bot = fakeBot()
    bot.state.fail = () => new Error('connect ETIMEDOUT')
    ctx.sendTelegram = bot.send
    const waits = [1, 5, 30, 30]
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await send()).toMatchObject({ retried: 1 })
      const row = await rowById(id)
      expect(row).toMatchObject({ status: 'pending', attempts: attempt, error: 'connect ETIMEDOUT' })
      const wait = row.notBefore.getTime() - ctx.now()
      expect(wait).toBeGreaterThan(waits[attempt - 1]! * 60_000 - 5_000)
      expect(wait).toBeLessThanOrEqual(waits[attempt - 1]! * 60_000)
      // Not due yet
      await send()
      expect(bot.calls).toHaveLength(attempt)
      clock.advance(waits[attempt - 1]! * 60 + 1)
    }
    expect(await send()).toMatchObject({ failed: 1 })
    expect(await rowById(id)).toMatchObject({ status: 'failed', attempts: 5, error: 'connect ETIMEDOUT' })
    expect(bot.calls).toHaveLength(5)
  })

  it('keeps at most 500 characters of an error, and treats other 400s as transient', async () => {
    const a = await player()
    const id = await queue(a)
    const bot = fakeBot()
    bot.state.fail = () => new Error('x'.repeat(2_000))
    ctx.sendTelegram = bot.send
    await send()
    expect((await rowById(id)).error).toHaveLength(500)
    expect(classifySendError({ error_code: 400, description: 'Bad Request: message is too long' }).kind).toBe('transient')
    expect(classifySendError({ error_code: 400, description: 'Bad Request: user is deactivated' }).kind).toBe('blocked')
    expect(classifySendError({ error_code: 429, description: 'slow', parameters: {} })).toMatchObject({
      kind: 'rate_limited',
      retryAfterSeconds: 5,
    })
  })

  it("takes back a claim stuck in 'sending' for over 5 minutes, and leaves a fresh one alone", async () => {
    const a = await player()
    const stale = await queue(a)
    const fresh = await queue(a)
    await db.update(notifications).set({ status: 'sending', lockedAt: new Date(ctx.now() - 6 * 60_000), attempts: 1 }).where(eq(notifications.id, stale))
    await db.update(notifications).set({ status: 'sending', lockedAt: new Date(ctx.now() - 60_000), attempts: 1 }).where(eq(notifications.id, fresh))
    ctx.sendTelegram = fakeBot().send
    await send()
    expect(await rowById(stale)).toMatchObject({ status: 'sent', attempts: 2 })
    expect(await rowById(fresh)).toMatchObject({ status: 'sending', attempts: 1 })
  })

  it('skips suspended players, and opted-out players for reminders and offers only', async () => {
    const banned = await player()
    const quiet = await player({ remindersOptOutAt: new Date(ctx.now()) })
    const s1 = await queue(banned, 'announcement')
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, banned.id))
    const r = await queue(quiet, 'reminder')
    const c = await queue(quiet, 'comeback')
    const t = await queue(quiet, 'transfer')
    const bot = fakeBot()
    ctx.sendTelegram = bot.send
    expect(await send()).toMatchObject({ skipped: 3, sent: 1 })
    expect(await rowById(s1)).toMatchObject({ status: 'skipped', error: 'suspended' })
    expect(await rowById(r)).toMatchObject({ status: 'skipped', error: 'opted out' })
    expect(await rowById(c)).toMatchObject({ status: 'skipped', error: 'opted out' })
    expect((await rowById(t)).status).toBe('sent')
    expect(bot.calls.map((x) => x.chatId)).toEqual([quiet.telegramId])
  })

  it('claims at most `max` per pass', async () => {
    const a = await player()
    const ids = [await queue(a), await queue(a), await queue(a)]
    const bot = fakeBot()
    ctx.sendTelegram = bot.send
    expect((await send(2)).sent).toBe(2)
    expect((await send(2)).sent).toBe(1)
    for (const id of ids) expect((await rowById(id)).status).toBe('sent')
  })

  it('without a bot leaves messages pending and says so in the log', async () => {
    const a = await player()
    const id = await queue(a)
    ctx.sendTelegram = undefined
    const warn = vi.spyOn(ctx.log, 'warn')
    expect(await send()).toEqual({ sent: 0, failed: 0, retried: 0, skipped: 0 })
    expect(await rowById(id)).toMatchObject({ status: 'pending', attempts: 0 })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ due: expect.any(Number) }), expect.stringContaining('cannot send'))
    warn.mockRestore()
  })
})

/* Workers ---------------------------------------------------------------------- */

describe('startWorkers', () => {
  it('two processes running the loops send a message once, and stop cleanly', async () => {
    const a = await player()
    const id = await queue(a)
    const bot = fakeBot()
    ctx.sendTelegram = bot.send
    // Two "processes" sharing the database: the advisory lock lets one sender work per tick
    const stops = [startWorkers(ctx), startWorkers(ctx)]
    try {
      const deadline = Date.now() + 8_000
      while ((await rowById(id)).status !== 'sent' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      expect((await rowById(id)).status).toBe('sent')
    } finally {
      await Promise.all(stops.map((stop) => stop()))
    }
    expect(bot.calls.filter((c) => c.chatId === a.telegramId)).toHaveLength(1)
  })
})
