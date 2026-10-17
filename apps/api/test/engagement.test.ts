/**
 * Engagement: the activity clock, inactivity reminders (timing, quiet hours,
 * no repeats, the per-spell cap, opt-out), come-back offers and their claim,
 * and the bot's side (phone sharing, the reminders button, blocked flag).
 *
 * The test schema is shared with the other files, and a scheduler pass looks
 * at every player in it, so every check here looks only at this file's own
 * players and rows. Time moves with the injected Clock (Lagos hours matter).
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import type { Transformer } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FEATURE_KEYS, type FeatureKey } from '@raffwin/shared'
import { createBot } from '../src/bot/bot'
import { comebackOffers, ledger, notifications, securityEvents, users, type UserRow } from '../src/db/schema'
import {
  chooseReminderKey,
  claimComeback,
  inQuietHours,
  lagosHour,
  nextQuietEnd,
  runEngagementOnce,
  setReminders,
  touchActivity,
} from '../src/services/engagement'
import { REMINDER_TEXTS, renderReminder } from '../src/services/engagement-messages'
import { getGlobalFlags, setGlobal, setOverride } from '../src/services/features'
import { getAllSettings, putSetting, type SettingKey } from '../src/services/settings'
import { BOT_TOKEN, initData, nigerianPhone, telegramId, testApp, uniqueUsername } from './helpers'

const APP_URL = 'https://raffwintest.example/'
const { ctx, db, clock, http } = testApp({ PUBLIC_APP_URL: APP_URL })

const HOUR = 3_600_000
const DAY = 24 * HOUR

/* Fixtures ------------------------------------------------------------------- */

async function player(overrides: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  const now = new Date(ctx.now())
  const [row] = await db
    .insert(users)
    .values({
      telegramId: telegramId(),
      username: uniqueUsername('e'),
      tgFirstName: 'Ada',
      fullName: 'Ada Obi',
      referralCode: randomBytes(6).toString('hex').toUpperCase(),
      signedUpAt: now,
      lastSeenAt: now,
      ...overrides,
    })
    .returning()
  if (!row) throw new Error('user insert failed')
  return row
}

async function reload(id: string): Promise<UserRow> {
  const [row] = await db.select().from(users).where(eq(users.id, id))
  if (!row) throw new Error(`no user ${id}`)
  return row
}

async function outbox(userId: string) {
  return db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(notifications.notBefore)
}

/** Moves the clock forward to the next hour:minute on a Lagos clock. */
function moveToLagos(hour: number, minute = 30) {
  const now = clock.now()
  const target = nextQuietEnd(now, hour) + minute * 60_000
  clock.advance((target - now) / 1000)
}

/** What the sender would do with this player's queued messages: mark them sent now. */
async function deliver(userId: string) {
  await db
    .update(notifications)
    .set({ status: 'sent', sentAt: new Date(ctx.now()) })
    .where(and(eq(notifications.userId, userId), eq(notifications.status, 'pending')))
}

/* Isolation ------------------------------------------------------------------ */

const ENGAGEMENT_DEFAULTS = {
  'engagement.reminder_min_hours': 6,
  'engagement.reminder_max_hours': 10,
  'engagement.max_reminders_per_spell': 8,
  'engagement.quiet_start_hour': 22,
  'engagement.quiet_end_hour': 7,
  'engagement.comeback_after_hours': 48,
  'engagement.comeback_raffs': 1,
  'engagement.comeback_cooldown_days': 7,
} as const
type EngagementKey = keyof typeof ENGAGEMENT_DEFAULTS
const settingsBefore = new Map<EngagementKey, unknown>()
const flagsBefore = new Map<FeatureKey, boolean>()
let startedAt = new Date()

beforeAll(async () => {
  startedAt = new Date()
  // Known settings and switches whatever an earlier file left; put back afterwards
  const all = await getAllSettings(db)
  for (const [key, value] of Object.entries(ENGAGEMENT_DEFAULTS) as [EngagementKey, number][]) {
    settingsBefore.set(key, all[key as SettingKey])
    await putSetting(db, key, value, null)
  }
  const flags = await getGlobalFlags(db)
  for (const k of FEATURE_KEYS) flagsBefore.set(k, flags[k])
  await db.transaction(async (tx) => {
    await setGlobal(tx, 'reminders', true, null)
    await setGlobal(tx, 'comeback_offer', true, null)
  })
})

afterAll(async () => {
  for (const [key, value] of settingsBefore) await putSetting(db, key, value as never, null)
  await db.transaction(async (tx) => {
    for (const [k, v] of flagsBefore) await setGlobal(tx, k, v, null)
  })
  // This file's passes queued reminders and offers for every player in the schema; later files should not inherit them
  await db
    .update(notifications)
    .set({ status: 'skipped', error: 'test cleanup', lockedAt: null })
    .where(
      and(
        inArray(notifications.kind, ['reminder', 'comeback']),
        inArray(notifications.status, ['pending', 'sending']),
        gte(notifications.createdAt, startedAt),
      ),
    )
})

/* The pool ------------------------------------------------------------------- */

describe('reminder texts', () => {
  it('has at least 16 distinct texts with keys r01.., all safe Telegram HTML once the name is filled in', () => {
    expect(REMINDER_TEXTS.length).toBeGreaterThanOrEqual(16)
    expect(new Set(REMINDER_TEXTS.map((t) => t.key)).size).toBe(REMINDER_TEXTS.length)
    expect(new Set(REMINDER_TEXTS.map((t) => t.text)).size).toBe(REMINDER_TEXTS.length)
    REMINDER_TEXTS.forEach((t, i) => expect(t.key).toBe(`r${String(i + 1).padStart(2, '0')}`))
    for (const t of REMINDER_TEXTS) {
      expect(t.text).toContain('{name}')
      expect(t.text).not.toMatch(/[<>&]/)
      expect(t.text.length).toBeLessThanOrEqual(200)
      // Honest: no pressure words, no promise of winning
      expect(t.text).not.toMatch(/hurry|last chance|guarantee|don't miss|only \d+ left|you have won|you won/i)
      expect(t.text).not.toMatch(/tap below/i)
    }
    expect(renderReminder('r01', 'Ada <b>&')).toContain('Ada &lt;b&gt;&amp;')
  })

  it('never picks a text used in the last 48 h and prefers the one used longest ago', () => {
    const now = Date.now()
    const recent = new Map(REMINDER_TEXTS.map((t) => [t.key, now - HOUR]))
    expect(chooseReminderKey(recent, now)).toBeNull()

    recent.set('r07', now - 49 * HOUR)
    expect(chooseReminderKey(recent, now)).toBe('r07')

    recent.set('r03', now - 72 * HOUR)
    expect(chooseReminderKey(recent, now)).toBe('r03')

    // Never sent beats sent long ago
    const someUsed = new Map([['r01', now - 10 * DAY]])
    const picked = chooseReminderKey(someUsed, now)
    expect(picked).not.toBe('r01')
    expect(picked).not.toBeNull()
  })

  it('quiet hours wrap midnight on a Lagos clock', () => {
    // 2026-10-17 21:30 UTC = 22:30 Lagos
    const late = Date.UTC(2026, 9, 17, 21, 30)
    expect(lagosHour(late)).toBe(22)
    expect(inQuietHours(late, 22, 7)).toBe(true)
    expect(inQuietHours(Date.UTC(2026, 9, 17, 5, 59), 22, 7)).toBe(true) // 06:59 Lagos
    expect(inQuietHours(Date.UTC(2026, 9, 17, 6, 0), 22, 7)).toBe(false) // 07:00 Lagos
    expect(inQuietHours(late, 7, 7)).toBe(false)
    expect(inQuietHours(Date.UTC(2026, 9, 17, 1, 0), 1, 5)).toBe(true) // 02:00 Lagos, no wrap
    // Next 07:00 Lagos after 22:30 Lagos is 06:00 UTC the next day
    expect(nextQuietEnd(late, 7)).toBe(Date.UTC(2026, 9, 18, 6, 0))
  })
})

/* Activity ------------------------------------------------------------------- */

describe('activity', () => {
  it('an app open schedules the next reminder 6-10 h out and starts a new spell', async () => {
    const id = telegramId()
    const open = () =>
      http.post('/v1/auth/telegram').send({ initData: initData({ id, username: uniqueUsername('o') }, { authDate: Math.floor(ctx.now() / 1000) }) })
    const first = await open()
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const [created] = await db.select().from(users).where(eq(users.telegramId, id))
    const now = ctx.now()
    expect(created!.lastSeenAt!.getTime()).toBeGreaterThan(now - 5_000)
    expect(created!.nextReminderAt!.getTime()).toBeGreaterThanOrEqual(now + 6 * HOUR - 5_000)
    expect(created!.nextReminderAt!.getTime()).toBeLessThanOrEqual(now + 10 * HOUR + 5_000)
    expect(created!.remindersSinceOpen).toBe(0)

    await db.update(users).set({ remindersSinceOpen: 5, nextReminderAt: null }).where(eq(users.id, created!.id))
    clock.advance(3600)
    expect((await open()).status).toBe(200)
    const again = await reload(created!.id)
    expect(again.remindersSinceOpen).toBe(0)
    expect(again.nextReminderAt!.getTime()).toBeGreaterThanOrEqual(ctx.now() + 6 * HOUR - 5_000)
    expect(again.lastSeenAt!.getTime()).toBeGreaterThan(created!.lastSeenAt!.getTime())
  })

  it('using the app counts after 5 quiet minutes, with one update, and not more often', async () => {
    const id = telegramId()
    const auth = await http
      .post('/v1/auth/telegram')
      .send({ initData: initData({ id, username: uniqueUsername('a') }, { authDate: Math.floor(ctx.now() / 1000) }) })
    expect(auth.status, JSON.stringify(auth.body)).toBe(200)
    const token = auth.body.accessToken as string
    const [u] = await db.select().from(users).where(eq(users.telegramId, id))
    const get = () => http.get('/v1/rate').set('authorization', `Bearer ${token}`)

    // 2 minutes after the open: nothing changes
    const twoMinAgo = new Date(ctx.now() - 2 * 60_000)
    await db.update(users).set({ lastSeenAt: twoMinAgo, remindersSinceOpen: 2 }).where(eq(users.id, u!.id))
    expect((await get()).status).toBe(200)
    expect((await reload(u!.id)).remindersSinceOpen).toBe(2)

    // 10 minutes: seen now, schedule reset
    await db
      .update(users)
      .set({ lastSeenAt: new Date(ctx.now() - 10 * 60_000), nextReminderAt: new Date(ctx.now()) })
      .where(eq(users.id, u!.id))
    expect((await get()).status).toBe(200)
    const after = await reload(u!.id)
    expect(after.lastSeenAt!.getTime()).toBeGreaterThan(ctx.now() - 5_000)
    expect(after.remindersSinceOpen).toBe(0)
    expect(after.nextReminderAt!.getTime()).toBeGreaterThanOrEqual(ctx.now() + 6 * HOUR - 5_000)
  })
})

/* Reminders ------------------------------------------------------------------ */

describe('reminders', () => {
  it('a due player gets one reminder with the open and opt-out buttons; the next comes 6-10 h later', async () => {
    moveToLagos(12)
    const p = await player({ tgFirstName: 'Chidi', nextReminderAt: new Date(ctx.now() - 60_000) })
    await runEngagementOnce(ctx)

    const rows = await outbox(p.id)
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.kind).toBe('reminder')
    expect(r.status).toBe('pending')
    expect(REMINDER_TEXTS.map((t) => t.key)).toContain(r.templateKey)
    expect(r.text).toBe(renderReminder(r.templateKey!, 'Chidi'))
    expect(r.buttons).toEqual([[{ text: 'Open Raffle Win', webApp: APP_URL }], [{ text: 'Turn off reminders', callbackData: 'reminders:off' }]])
    expect(r.dedupeKey).toBe(`reminder:${p.id}:1:${p.lastSeenAt!.getTime()}`)

    const after = await reload(p.id)
    expect(after.remindersSinceOpen).toBe(1)
    expect(Math.abs(after.lastReminderAt!.getTime() - ctx.now())).toBeLessThan(5_000)
    expect(after.nextReminderAt!.getTime()).toBeGreaterThanOrEqual(ctx.now() + 6 * HOUR - 5_000)
    expect(after.nextReminderAt!.getTime()).toBeLessThanOrEqual(ctx.now() + 10 * HOUR + 5_000)

    // A second pass in the same minute sends nothing more
    await runEngagementOnce(ctx)
    expect(await outbox(p.id)).toHaveLength(1)
  })

  it('in quiet hours nothing is sent; the reminder moves to 07:00-08:30 Lagos', async () => {
    moveToLagos(23)
    const p = await player({ nextReminderAt: new Date(ctx.now() - 60_000) })
    await runEngagementOnce(ctx)
    expect(await outbox(p.id)).toHaveLength(0)
    const after = await reload(p.id)
    const quietEnd = nextQuietEnd(ctx.now(), 7)
    expect(after.nextReminderAt!.getTime()).toBeGreaterThanOrEqual(quietEnd)
    expect(after.nextReminderAt!.getTime()).toBeLessThanOrEqual(quietEnd + 90 * 60_000)
    expect(after.remindersSinceOpen).toBe(0)

    // At 07:00-ish it goes out
    clock.advance((after.nextReminderAt!.getTime() - ctx.now()) / 1000 + 60)
    await runEngagementOnce(ctx)
    expect(await outbox(p.id)).toHaveLength(1)
  })

  it('over many passes: never the same text within 48 h, never in quiet hours, at most 8 per spell', async () => {
    moveToLagos(9)
    const p = await player({ nextReminderAt: new Date(ctx.now() + 60_000) })
    // Only reminders in this test: no come-back offer moving the schedule
    await db.transaction((tx) => setOverride(tx, 'comeback_offer', p.id, false, 'test', null))

    const sent: { key: string; at: number }[] = []
    const runSpell = async () => {
      for (let i = 0; i < 40; i++) {
        const u = await reload(p.id)
        if (!u.nextReminderAt) return
        clock.advance((u.nextReminderAt.getTime() - ctx.now()) / 1000 + 60)
        const before = (await outbox(p.id)).length
        await runEngagementOnce(ctx)
        const rows = await outbox(p.id)
        if (rows.length > before) {
          const r = rows[rows.length - 1]!
          sent.push({ key: r.templateKey!, at: r.notBefore.getTime() })
          await deliver(p.id)
        }
      }
      throw new Error('the spell never ended')
    }

    await runSpell()
    expect(sent).toHaveLength(8)
    expect((await reload(p.id)).remindersSinceOpen).toBe(8)

    // The player comes back, goes quiet again: a second spell of 8
    await touchActivity(ctx, p.id)
    await runSpell()
    expect(sent).toHaveLength(16)

    for (const s of sent) expect(inQuietHours(s.at, 22, 7), new Date(s.at).toISOString()).toBe(false)
    for (let i = 0; i < sent.length; i++) {
      for (let j = i + 1; j < sent.length; j++) {
        if (sent[i]!.key === sent[j]!.key) expect(sent[j]!.at - sent[i]!.at).toBeGreaterThanOrEqual(48 * HOUR)
      }
    }
    // Each spell alone uses 8 different texts
    expect(new Set(sent.slice(0, 8).map((s) => s.key)).size).toBe(8)
    expect(new Set(sent.slice(8).map((s) => s.key)).size).toBe(8)
  })

  it('opted-out players, blocked players and players with reminders switched off get none', async () => {
    moveToLagos(14)
    const due = new Date(ctx.now() - 60_000)
    const optedOut = await player({ nextReminderAt: due, remindersOptOutAt: new Date(ctx.now()) })
    const blocked = await player({ nextReminderAt: due, botBlockedAt: new Date(ctx.now()) })
    const switchedOff = await player({ nextReminderAt: due })
    await db.transaction((tx) => setOverride(tx, 'reminders', switchedOff.id, false, 'test', null))
    const suspended = await player({ nextReminderAt: due, status: 'suspended' })
    await runEngagementOnce(ctx)
    for (const p of [optedOut, blocked, switchedOff, suspended]) expect(await outbox(p.id)).toHaveLength(0)

    // Turning back on: the next one is 6-10 h away, not immediately
    await setReminders(ctx, optedOut.id, true)
    const back = await reload(optedOut.id)
    expect(back.remindersOptOutAt).toBeNull()
    expect(back.nextReminderAt!.getTime()).toBeGreaterThanOrEqual(ctx.now() + 6 * HOUR - 5_000)

    await setReminders(ctx, optedOut.id, false)
    const first = (await reload(optedOut.id)).remindersOptOutAt!
    clock.advance(60)
    await setReminders(ctx, optedOut.id, false)
    expect((await reload(optedOut.id)).remindersOptOutAt!.getTime()).toBe(first.getTime())
  })

  it('an app open between the read and the update wins: the reminder is not sent', async () => {
    moveToLagos(15)
    const p = await player({ nextReminderAt: new Date(ctx.now() - 60_000) })
    // Same row, but the schedule was reset (as touchActivity would) at the same moment
    await touchActivity(ctx, p.id)
    await runEngagementOnce(ctx)
    expect(await outbox(p.id)).toHaveLength(0)
  })
})

/* Come-back offers ------------------------------------------------------------ */

describe('come-back offers', () => {
  it('one offer per spell away, no reminder in the same pass, claimed once for exactly 1 Raff', async () => {
    moveToLagos(11)
    const away = new Date(ctx.now() - 49 * HOUR)
    const p = await player({ tgFirstName: 'Ngozi', lastSeenAt: away, nextReminderAt: new Date(ctx.now() - 60_000) })
    await runEngagementOnce(ctx)

    const offers = await db.select().from(comebackOffers).where(eq(comebackOffers.userId, p.id))
    expect(offers).toHaveLength(1)
    expect(offers[0]!.raffs).toBe(1)
    expect(offers[0]!.spellStartedAt.getTime()).toBe(away.getTime())
    const rows = await outbox(p.id)
    expect(rows.map((r) => r.kind)).toEqual(['comeback'])
    expect(rows[0]!.text).toBe('We miss you, Ngozi! Open Raffle Win in the next 7 days and we will add 1 free Raff to your balance.')
    expect(rows[0]!.dedupeKey).toBe(`comeback:${offers[0]!.id}`)
    expect(offers[0]!.expiresAt.getTime() - rows[0]!.notBefore.getTime()).toBe(7 * DAY)
    // The reminder that was due moved 6-10 h past the offer
    expect((await reload(p.id)).nextReminderAt!.getTime()).toBeGreaterThanOrEqual(ctx.now() + 6 * HOUR - 5_000)

    // Same spell: no second offer, ever
    clock.advance(3 * 3600)
    await runEngagementOnce(ctx)
    expect(await db.select().from(comebackOffers).where(eq(comebackOffers.userId, p.id))).toHaveLength(1)

    // The player opens the app: credited once, even with two opens at the same moment
    await touchActivity(ctx, p.id)
    const balanceBefore = (await reload(p.id)).balanceCache
    const claims = await Promise.all([claimComeback(ctx, p.id), claimComeback(ctx, p.id)])
    expect(claims.filter((c) => c !== null)).toEqual([{ raffs: 1 }])
    expect(await claimComeback(ctx, p.id)).toBeNull()
    expect((await reload(p.id)).balanceCache).toBe(balanceBefore + 1)
    const credits = await db.select().from(ledger).where(and(eq(ledger.userId, p.id), eq(ledger.referenceType, 'comeback_offer')))
    expect(credits).toHaveLength(1)
    expect(credits[0]).toMatchObject({ type: 'bonus', raffs: 1, note: 'Welcome back: 1 free Raff', referenceId: offers[0]!.id })
    const [claimed] = await db.select().from(comebackOffers).where(eq(comebackOffers.id, offers[0]!.id))
    expect(claimed!.ledgerId).toBe(credits[0]!.id)

    // Away again within the 7-day cooldown: no new offer
    await db.update(users).set({ lastSeenAt: new Date(ctx.now() - 50 * HOUR) }).where(eq(users.id, p.id))
    await runEngagementOnce(ctx)
    expect(await db.select().from(comebackOffers).where(eq(comebackOffers.userId, p.id))).toHaveLength(1)

    // After the cooldown, a new spell away earns a new offer
    clock.advance(8 * 86_400)
    moveToLagos(11)
    await db.update(users).set({ lastSeenAt: new Date(ctx.now() - 50 * HOUR) }).where(eq(users.id, p.id))
    await runEngagementOnce(ctx)
    expect(await db.select().from(comebackOffers).where(eq(comebackOffers.userId, p.id))).toHaveLength(2)
  })

  it('in quiet hours the offer waits for the morning, and a claim before then drops the message', async () => {
    moveToLagos(2)
    const p = await player({ lastSeenAt: new Date(ctx.now() - 60 * HOUR) })
    await runEngagementOnce(ctx)
    const [row] = await outbox(p.id)
    expect(row?.kind).toBe('comeback')
    const quietEnd = nextQuietEnd(ctx.now(), 7)
    expect(row!.notBefore.getTime()).toBeGreaterThanOrEqual(quietEnd)
    expect(row!.notBefore.getTime()).toBeLessThanOrEqual(quietEnd + 90 * 60_000)

    await touchActivity(ctx, p.id)
    expect(await claimComeback(ctx, p.id)).toEqual({ raffs: 1 })
    const [after] = await outbox(p.id)
    expect(after).toMatchObject({ status: 'skipped', error: 'already claimed' })
  })

  it('no offer when switched off, opted out, set to 0 Raffs, or not away long enough; expired offers are not credited', async () => {
    moveToLagos(16)
    const away = () => new Date(ctx.now() - 49 * HOUR)
    const off = await player({ lastSeenAt: away() })
    await db.transaction((tx) => setOverride(tx, 'comeback_offer', off.id, false, 'test', null))
    const optedOut = await player({ lastSeenAt: away(), remindersOptOutAt: new Date(ctx.now()) })
    const recent = await player({ lastSeenAt: new Date(ctx.now() - 47 * HOUR) })
    await runEngagementOnce(ctx)
    for (const p of [off, optedOut, recent]) {
      expect(await db.select().from(comebackOffers).where(eq(comebackOffers.userId, p.id))).toHaveLength(0)
    }

    await putSetting(db, 'engagement.comeback_raffs', 0, null)
    const zero = await player({ lastSeenAt: away() })
    await runEngagementOnce(ctx)
    expect(await db.select().from(comebackOffers).where(eq(comebackOffers.userId, zero.id))).toHaveLength(0)
    await putSetting(db, 'engagement.comeback_raffs', 1, null)

    // An offer left unclaimed past its 7 days
    const late = await player({ lastSeenAt: away() })
    await runEngagementOnce(ctx)
    expect(await db.select().from(comebackOffers).where(eq(comebackOffers.userId, late.id))).toHaveLength(1)
    clock.advance(8 * 86_400)
    expect(await claimComeback(ctx, late.id)).toBeNull()
    expect((await reload(late.id)).balanceCache).toBe(0)
  })

  it('an offer made before it was switched off pays nothing and its waiting message is dropped', async () => {
    moveToLagos(2)
    const zero = await player({ lastSeenAt: new Date(ctx.now() - 60 * HOUR) })
    const off = await player({ lastSeenAt: new Date(ctx.now() - 60 * HOUR) })
    await runEngagementOnce(ctx)
    for (const p of [zero, off]) expect((await outbox(p.id)).map((r) => [r.kind, r.status])).toEqual([['comeback', 'pending']])

    await db.transaction((tx) => setOverride(tx, 'comeback_offer', off.id, false, 'test', null))
    await touchActivity(ctx, off.id)
    expect(await claimComeback(ctx, off.id)).toBeNull()

    await putSetting(db, 'engagement.comeback_raffs', 0, null)
    try {
      await touchActivity(ctx, zero.id)
      expect(await claimComeback(ctx, zero.id)).toBeNull()
    } finally {
      await putSetting(db, 'engagement.comeback_raffs', 1, null)
    }

    for (const p of [zero, off]) {
      expect((await reload(p.id)).balanceCache).toBe(0)
      expect(await db.select().from(ledger).where(and(eq(ledger.userId, p.id), eq(ledger.referenceType, 'comeback_offer')))).toHaveLength(0)
      const [row] = await outbox(p.id)
      expect(row).toMatchObject({ kind: 'comeback', status: 'skipped', error: 'offer withdrawn' })
      const [offer] = await db.select().from(comebackOffers).where(eq(comebackOffers.userId, p.id))
      expect(offer!.claimedAt).toBeNull()
    }
  })
})

/* The bot -------------------------------------------------------------------- */

interface Call {
  method: string
  payload: Record<string, unknown>
}

const BOT_USER: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Raffle Win',
  username: 'raffwin_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: true,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

/** A bot wired to the test database whose Telegram API calls are recorded, never sent. */
function harness() {
  const calls: Call[] = []
  let nextId = 1000
  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    const result =
      method === 'sendMessage'
        ? { message_id: (nextId += 1), date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' }, text: '' }
        : true
    return { ok: true, result } as never
  }
  const bot = createBot({
    token: BOT_TOKEN,
    appUrl: APP_URL,
    envLabel: 'test',
    log: pino({ level: 'silent' }),
    app: ctx,
    testing: { botInfo: BOT_USER, transformer },
  })
  let updateId = 1
  let messageId = 1
  const chat = (id: number) => ({ id, type: 'private' as const, first_name: 'Ada' })
  const from = (id: number) => ({ id, is_bot: false, first_name: 'Ada' })
  const message = (id: number, extra: Record<string, unknown>) =>
    bot.handleUpdate({
      update_id: (updateId += 1),
      message: { message_id: (messageId += 1), date: Math.floor(Date.now() / 1000), chat: chat(id), from: from(id), ...extra },
    } as never)
  return {
    calls,
    text: (id: number, text: string) =>
      message(id, {
        text,
        ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}),
      }),
    contact: (id: number, contact: { user_id?: number; phone_number: string }) =>
      message(id, { contact: { first_name: 'Ada', ...contact } }),
    chatMember: (id: number, status: 'kicked' | 'member') =>
      bot.handleUpdate({
        update_id: (updateId += 1),
        my_chat_member: {
          chat: chat(id),
          from: from(id),
          date: Math.floor(Date.now() / 1000),
          old_chat_member: { user: BOT_USER, status: status === 'kicked' ? 'member' : 'kicked', ...(status === 'member' ? { until_date: 0 } : {}) },
          new_chat_member: { user: BOT_USER, status, ...(status === 'kicked' ? { until_date: 0 } : {}) },
        },
      } as never),
    /** A service message, e.g. write_access_allowed (no text) */
    service: (id: number, extra: Record<string, unknown>) => message(id, extra),
    callback: (id: number, data: string, keyboard: unknown[][]) =>
      bot.handleUpdate({
        update_id: (updateId += 1),
        callback_query: {
          id: `cb${updateId}`,
          from: from(id),
          chat_instance: 'ci',
          data,
          message: { message_id: 77, date: Math.floor(Date.now() / 1000), chat: chat(id), text: 'reminder', reply_markup: { inline_keyboard: keyboard } },
        },
      } as never),
    replies: () => calls.filter((c) => c.method === 'sendMessage'),
    lastReply: () => calls.filter((c) => c.method === 'sendMessage').at(-1)!,
  }
}

describe('bot: phone, reminders button, blocked flag', () => {
  it('/phone and /start phone ask with the share-contact keyboard and say why', async () => {
    const h = harness()
    const p = await player()
    await h.text(p.telegramId, '/phone')
    const ask = h.lastReply()
    expect(String(ask.payload.text)).toContain('courier calls this number')
    expect(ask.payload.reply_markup).toMatchObject({
      keyboard: [[{ text: 'Share my phone number', request_contact: true }]],
      one_time_keyboard: true,
      resize_keyboard: true,
    })

    await h.text(p.telegramId, '/start phone')
    expect(h.replies()).toHaveLength(2)
    expect(h.lastReply().payload.reply_markup).toMatchObject({ keyboard: [[{ request_contact: true }]] })

    // No account yet: open the app first
    await h.text(telegramId(), '/phone')
    expect(String(h.lastReply().payload.text)).toContain('Open Raffle Win once first')

    // /help lists it
    await h.text(p.telegramId, '/help')
    expect(String(h.lastReply().payload.text)).toContain('/phone')
  })

  it('saves the player’s own Nigerian number, removes the keyboard and offers the app', async () => {
    const h = harness()
    const p = await player()
    const phone = nigerianPhone()
    await h.contact(p.telegramId, { user_id: p.telegramId, phone_number: phone.slice(1) })
    const after = await reload(p.id)
    expect(after.phone).toBe(phone)
    expect(after.phoneVerifiedAt).not.toBeNull()
    const [thanks, open] = h.replies().slice(-2)
    expect(String(thanks!.payload.text)).toContain('is saved')
    expect(thanks!.payload.reply_markup).toEqual({ remove_keyboard: true })
    expect(open!.payload.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Open Raffle Win', web_app: { url: APP_URL } }]] })
  })

  it('refuses someone else’s contact (recorded as fraud), a foreign number, a number in use, and no account', async () => {
    const h = harness()
    const p = await player()
    const since = new Date(Date.now() - 1000)
    await h.contact(p.telegramId, { user_id: p.telegramId + 1, phone_number: nigerianPhone() })
    expect((await reload(p.id)).phone).toBeNull()
    expect(String(h.lastReply().payload.text)).toContain('not the number on your own Telegram account')
    const events = await db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.kind, 'bot_contact_other_account'), eq(securityEvents.userId, p.id), gte(securityEvents.occurredAt, since)))
    expect(events).toHaveLength(1)
    expect(events[0]!.category).toBe('fraud')

    // A contact with no user_id (a phone-book card) is not the player's own either
    await h.contact(p.telegramId, { phone_number: nigerianPhone() })
    expect((await reload(p.id)).phone).toBeNull()

    await h.contact(p.telegramId, { user_id: p.telegramId, phone_number: '+447700900123' })
    expect((await reload(p.id)).phone).toBeNull()
    expect(String(h.lastReply().payload.text)).toContain('Nigeria only')

    const taken = nigerianPhone()
    await player({ phone: taken, phoneVerifiedAt: new Date() })
    await h.contact(p.telegramId, { user_id: p.telegramId, phone_number: taken })
    expect((await reload(p.id)).phone).toBeNull()
    expect(String(h.lastReply().payload.text)).toContain('already on another Raffle Win account')

    const stranger = telegramId()
    await h.contact(stranger, { user_id: stranger, phone_number: nigerianPhone() })
    expect(String(h.lastReply().payload.text)).toContain('Open Raffle Win once first')
  })

  it('the reminders button turns reminders off and on, and flips itself', async () => {
    const h = harness()
    const p = await player()
    const keyboard = [[{ text: 'Open Raffle Win', web_app: { url: APP_URL } }], [{ text: 'Turn off reminders', callback_data: 'reminders:off' }]]
    await h.callback(p.telegramId, 'reminders:off', keyboard)
    expect((await reload(p.id)).remindersOptOutAt).not.toBeNull()
    const answer = h.calls.find((c) => c.method === 'answerCallbackQuery')
    expect(String(answer?.payload.text)).toContain('no more reminders')
    const edit = h.calls.find((c) => c.method === 'editMessageReplyMarkup')
    expect(edit?.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Open Raffle Win', web_app: { url: APP_URL } }], [{ text: 'Turn reminders back on', callback_data: 'reminders:on' }]],
    })

    await h.callback(p.telegramId, 'reminders:on', (edit!.payload.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard)
    const back = await reload(p.id)
    expect(back.remindersOptOutAt).toBeNull()
    expect(back.nextReminderAt!.getTime()).toBeGreaterThan(ctx.now())
    const edits = h.calls.filter((c) => c.method === 'editMessageReplyMarkup')
    expect(edits.at(-1)?.payload.reply_markup).toMatchObject({ inline_keyboard: [[{}], [{ callback_data: 'reminders:off' }]] })
  })

  it('blocking the bot marks the player; unblocking or /start clears it', async () => {
    const h = harness()
    const p = await player()
    await h.chatMember(p.telegramId, 'kicked')
    expect((await reload(p.id)).botBlockedAt).not.toBeNull()
    await h.chatMember(p.telegramId, 'member')
    expect((await reload(p.id)).botBlockedAt).toBeNull()

    await db.update(users).set({ botBlockedAt: sql`now()` }).where(eq(users.id, p.id))
    await h.text(p.telegramId, '/start')
    expect((await reload(p.id)).botBlockedAt).toBeNull()
    expect(String(h.lastReply().payload.text)).toContain('Welcome to Raffle Win')
  })

  it('allowing the bot to write (opened the Mini App without Start, so the first message got a 403) clears the mark, silently', async () => {
    const h = harness()
    const p = await player({ botBlockedAt: new Date(ctx.now()) })
    await h.service(p.telegramId, { write_access_allowed: { from_request: true } })
    expect((await reload(p.id)).botBlockedAt).toBeNull()
    // No reply, not even the catch-all "open Raffle Win" answer
    expect(h.replies()).toHaveLength(0)

    // No account yet: nothing to mark, no error
    await h.service(telegramId(), { write_access_allowed: { web_app_name: 'raffwin' } })
    expect(h.replies()).toHaveLength(0)
  })

  it('an app open whose initData says the bot may write clears the mark; one that does not leaves it', async () => {
    const id = telegramId()
    const open = (allows?: boolean) => {
      clock.advance(60)
      const user = { id, username: uniqueUsername('w'), ...(allows === undefined ? {} : { allows_write_to_pm: allows }) }
      return http.post('/v1/auth/telegram').send({ initData: initData(user as { id: number }, { authDate: Math.floor(ctx.now() / 1000) }) })
    }
    expect((await open()).status).toBe(200)
    const [u] = await db.select().from(users).where(eq(users.telegramId, id))
    await db.update(users).set({ botBlockedAt: new Date(ctx.now()) }).where(eq(users.id, u!.id))

    expect((await open()).status).toBe(200)
    expect((await reload(u!.id)).botBlockedAt).not.toBeNull()
    expect((await open(false)).status).toBe(200)
    expect((await reload(u!.id)).botBlockedAt).not.toBeNull()
    expect((await open(true)).status).toBe(200)
    expect((await reload(u!.id)).botBlockedAt).toBeNull()
  })

  it('back from blocked: a reminder that fell due meanwhile moves 6-10 h out instead of following the welcome', async () => {
    const h = harness()
    const stale = new Date(ctx.now() - 3 * DAY)
    const far = new Date(ctx.now() + 20 * HOUR)
    const viaStart = await player({ botBlockedAt: new Date(ctx.now()), nextReminderAt: stale })
    const viaMember = await player({ botBlockedAt: new Date(ctx.now()), nextReminderAt: stale })
    const viaAllowed = await player({ botBlockedAt: new Date(ctx.now()), nextReminderAt: stale })
    const capped = await player({ botBlockedAt: new Date(ctx.now()), nextReminderAt: null })
    const later = await player({ botBlockedAt: new Date(ctx.now()), nextReminderAt: far })
    const neverBlocked = await player({ nextReminderAt: stale })

    await h.text(viaStart.telegramId, '/start')
    await h.chatMember(viaMember.telegramId, 'member')
    await h.service(viaAllowed.telegramId, { write_access_allowed: {} })
    await h.chatMember(capped.telegramId, 'member')
    await h.chatMember(later.telegramId, 'member')
    await h.text(neverBlocked.telegramId, '/start')

    for (const p of [viaStart, viaMember, viaAllowed]) {
      const after = await reload(p.id)
      expect(after.botBlockedAt).toBeNull()
      expect(after.nextReminderAt!.getTime()).toBeGreaterThanOrEqual(ctx.now() + 6 * HOUR - 5_000)
      expect(after.nextReminderAt!.getTime()).toBeLessThanOrEqual(ctx.now() + 10 * HOUR + 5_000)
    }
    // No schedule stays none (the next app open starts one); one already further out keeps its time
    expect(await reload(capped.id)).toMatchObject({ botBlockedAt: null, nextReminderAt: null })
    expect((await reload(later.id)).nextReminderAt!.getTime()).toBe(far.getTime())
    // /start from a player who never blocked the bot changes nothing
    expect((await reload(neverBlocked.id)).nextReminderAt!.getTime()).toBe(stale.getTime())
  })
})

/* Migration 0009 backfill ---------------------------------------------------- */

describe('migration 0009: reminder schedule for existing players', () => {
  it('only players inside one reminder spell (80 h) get a first reminder; longer away get none', async () => {
    const file = readFileSync(new URL('../drizzle/0009_m5_engagement_features.sql', import.meta.url), 'utf8')
    const backfill = file.split('--> statement-breakpoint').at(-1)!
    expect(backfill).toMatch(/UPDATE users/)

    const ages = { recent: 10, inside: 70, outside: 100, ancient: 24 * 30 }
    const players = Object.fromEntries(
      await Promise.all(Object.keys(ages).map(async (k) => [k, await player({ nextReminderAt: null })] as const)),
    ) as Record<keyof typeof ages, UserRow>
    const suspended = await player({ status: 'suspended', nextReminderAt: null })

    // Run inside a transaction that is rolled back: the statement touches every player in the shared schema
    const rollback = new Error('rollback')
    let seen: { id: string; next: Date | null; dbNow: Date }[] = []
    await db
      .transaction(async (tx) => {
        for (const [k, hours] of Object.entries(ages) as [keyof typeof ages, number][]) {
          await tx
            .update(users)
            .set({ lastSeenAt: sql`now() - ${hours}::int * interval '1 hour'` })
            .where(eq(users.id, players[k].id))
        }
        await tx.update(users).set({ lastSeenAt: sql`now() - interval '10 hours'` }).where(eq(users.id, suspended.id))
        await tx.execute(sql.raw(backfill))
        const rows = await tx
          .select({ id: users.id, next: users.nextReminderAt, dbNow: sql<string>`now()` })
          .from(users)
          .where(inArray(users.id, [...Object.values(players).map((p) => p.id), suspended.id]))
        seen = rows.map((r) => ({ id: r.id, next: r.next, dbNow: new Date(r.dbNow) }))
        throw rollback
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error
      })

    const next = (p: UserRow) => seen.find((r) => r.id === p.id)!
    const dbNow = seen[0]!.dbNow.getTime()
    // 10 h ago: 6-10 h after that open is already past (or about to be), so the next 2 h
    const recent = next(players.recent).next!.getTime()
    expect(recent).toBeGreaterThanOrEqual(dbNow - 1_000)
    expect(recent).toBeLessThanOrEqual(dbNow + 2 * HOUR + 1_000)
    // 70 h ago: inside the spell, so the next 2 h
    const inside = next(players.inside).next!.getTime()
    expect(inside).toBeGreaterThanOrEqual(dbNow - 1_000)
    expect(inside).toBeLessThanOrEqual(dbNow + 2 * HOUR + 1_000)
    // Away longer than a spell: no reminders at all (the come-back offer is theirs)
    expect(next(players.outside).next).toBeNull()
    expect(next(players.ancient).next).toBeNull()
    expect(next(suspended).next).toBeNull()

    // Rolled back: nothing changed for real
    expect((await reload(players.recent.id)).nextReminderAt).toBeNull()
  })
})
