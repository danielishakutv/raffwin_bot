/**
 * Inactivity reminders, come-back offers and the activity clock behind them.
 *
 *   activity     every app open (auth.ts) and any use after 5 quiet minutes
 *                (requireAuth) sets last_seen_at = now, schedules the next
 *                reminder a random 6..10 h later and restarts the spell count
 *   reminders    runEngagementOnce, every minute: a player whose next reminder
 *                is due gets one text from the pool (never one they had in the
 *                last 48 h), at most 8 per spell away, never in quiet hours
 *   come-back    away 48 h+: one offer per spell (and per 7 days) of 1 free
 *                Raff, credited by claimComeback on the next open
 *
 * Nothing here messages Telegram directly: everything goes through the outbox
 * (services/notify.ts), which also drops reminders and offers to a player who
 * opted out or blocked the bot after they were queued, and holds back one that
 * reaches it in quiet hours (a backlog, a 429 pause). Settings are in
 * services/settings.ts (engagement.*); days and quiet hours are Lagos time.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import type { AppContext } from '../context'
import type { Db } from '../db/client'
import { comebackOffers, notifications, users, type NotificationButton } from '../db/schema'
import { firstName } from '../lib/html'
import { comebackText, REMINDER_TEXTS, REMINDERS_OFF, renderReminder, TURN_OFF_LABEL } from './engagement-messages'
import { featureSql, isFeatureOn } from './features'
import { post } from './ledger'
import { enqueue, openAppButton } from './notify'
import { getAllSettings, getSetting, type SettingKey, type SettingValue } from './settings'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Africa/Lagos is UTC+1 all year (no DST) */
const LAGOS_OFFSET_MS = HOUR_MS
/** A player never gets the same reminder text twice within this window */
const REPEAT_WINDOW_MS = 48 * HOUR_MS
/** Reminders held back by quiet hours go out over this long after quiet_end, not all at 07:00 */
const QUIET_SPREAD_MS = 90 * MINUTE_MS
/** A come-back offer stays open this long after its message goes out */
export const OFFER_DAYS = 7
/** Most players handled per step per scheduler pass; the rest wait a minute */
const TICK_LIMIT = 500
/** requireAuth refreshes last_seen_at when it is older than this */
export const ACTIVITY_REFRESH_MS = 5 * MINUTE_MS

/* Settings and time ------------------------------------------------------------ */

export interface EngagementSettings {
  reminderMinHours: number
  reminderMaxHours: number
  maxRemindersPerSpell: number
  quietStartHour: number
  quietEndHour: number
  comebackAfterHours: number
  comebackRaffs: number
  comebackCooldownDays: number
}

/** The engagement.* settings in one query. */
export async function engagementSettings(db: Pick<Db, 'select'>): Promise<EngagementSettings> {
  const all = await getAllSettings(db)
  const v = <K extends SettingKey>(key: K) => all[key] as SettingValue<K>
  return {
    reminderMinHours: v('engagement.reminder_min_hours'),
    reminderMaxHours: v('engagement.reminder_max_hours'),
    maxRemindersPerSpell: v('engagement.max_reminders_per_spell'),
    quietStartHour: v('engagement.quiet_start_hour'),
    quietEndHour: v('engagement.quiet_end_hour'),
    comebackAfterHours: v('engagement.comeback_after_hours'),
    comebackRaffs: v('engagement.comeback_raffs'),
    comebackCooldownDays: v('engagement.comeback_cooldown_days'),
  }
}

/** A random gap between reminders, min..max hours (a min above max is read the other way round). */
function reminderDelayMs(s: EngagementSettings): number {
  const lo = Math.min(s.reminderMinHours, s.reminderMaxHours)
  const hi = Math.max(s.reminderMinHours, s.reminderMaxHours)
  return (lo + Math.random() * (hi - lo)) * HOUR_MS
}

/** When the next reminder is due after `fromMs`: a random min..max hours later (settings). */
export async function nextReminderAfter(ctx: AppContext, fromMs: number): Promise<Date> {
  return new Date(fromMs + reminderDelayMs(await engagementSettings(ctx.db)))
}

/** The hour (0-23) on a Lagos clock at `ms`. */
export function lagosHour(ms: number): number {
  return new Date(ms + LAGOS_OFFSET_MS).getUTCHours()
}

/** Quiet from start:00 up to end:00 Lagos time, wrapping midnight when start > end. start = end means never quiet. */
export function inQuietHours(ms: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false
  const h = lagosHour(ms)
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour
}

/** The first moment after `ms` that a Lagos clock shows endHour:00. */
export function nextQuietEnd(ms: number, endHour: number): number {
  const lagosDayStart = Math.floor((ms + LAGOS_OFFSET_MS) / DAY_MS) * DAY_MS
  let at = lagosDayStart + endHour * HOUR_MS - LAGOS_OFFSET_MS
  if (at <= ms) at += DAY_MS
  return at
}

/** Somewhere in the first 90 minutes after quiet hours end (also the sender's, for a nudge that reaches it in quiet hours). */
export function afterQuietHours(ms: number, s: Pick<EngagementSettings, 'quietEndHour'>): number {
  return nextQuietEnd(ms, s.quietEndHour) + Math.random() * QUIET_SPREAD_MS
}

/* Activity --------------------------------------------------------------------- */

/** The columns an app open sets: seen now, next reminder min..max hours from now, a new spell. */
export async function activityFields(ctx: AppContext): Promise<{ lastSeenAt: Date; nextReminderAt: Date; remindersSinceOpen: number }> {
  const now = ctx.now()
  return { lastSeenAt: new Date(now), nextReminderAt: await nextReminderAfter(ctx, now), remindersSinceOpen: 0 }
}

/** The player opened the app (or used it): seen now, and the reminder schedule starts again. */
export async function touchActivity(ctx: AppContext, userId: string): Promise<void> {
  await ctx.db.update(users).set(await activityFields(ctx)).where(eq(users.id, userId))
}

/* Opt-out ---------------------------------------------------------------------- */

/**
 * Turns bot reminders and come-back offers on or off for a player (the app's
 * Profile switch, and the button under every reminder). Announcements, raffle
 * alerts and transfers are not affected. Turning back on schedules the next
 * reminder min..max hours from now.
 */
export async function setReminders(ctx: AppContext, userId: string, on: boolean): Promise<void> {
  if (on) {
    await ctx.db
      .update(users)
      .set({ remindersOptOutAt: null, nextReminderAt: await nextReminderAfter(ctx, ctx.now()), updatedAt: sql`now()` })
      .where(eq(users.id, userId))
  } else {
    await ctx.db
      .update(users)
      // Keeps the first opt-out time when the button is pressed twice
      .set({ remindersOptOutAt: sql`coalesce(${users.remindersOptOutAt}, ${new Date(ctx.now())})`, updatedAt: sql`now()` })
      .where(eq(users.id, userId))
  }
}

/* Messages --------------------------------------------------------------------- */

/** Under every reminder and offer: open the app, and a way to stop them. */
export function engagementButtons(ctx: Pick<AppContext, 'config'>): NotificationButton[][] {
  const off: NotificationButton = { text: TURN_OFF_LABEL, callbackData: REMINDERS_OFF }
  const open = openAppButton(ctx)
  return open ? [[open], [off]] : [[off]]
}

/**
 * Which pool text to send: none the player had in the last 48 h, and among
 * the rest the one they had longest ago (never = longest), ties at random.
 * `lastSent` maps a text key to when the player last had it (ms). Null when
 * every text was used inside the window.
 */
export function chooseReminderKey(lastSent: ReadonlyMap<string, number>, nowMs: number): string | null {
  const when = (key: string) => lastSent.get(key) ?? Number.NEGATIVE_INFINITY
  const allowed = REMINDER_TEXTS.filter((t) => when(t.key) <= nowMs - REPEAT_WINDOW_MS)
  if (allowed.length === 0) return null
  const oldest = Math.min(...allowed.map((t) => when(t.key)))
  const ties = allowed.filter((t) => when(t.key) === oldest)
  return ties[Math.floor(Math.random() * ties.length)]!.key
}

/* The scheduler ---------------------------------------------------------------- */

export interface EngagementCounts {
  /** Reminders queued */
  reminders: number
  /** Come-back offers made (each with its message queued) */
  offers: number
  /** Reminders moved past quiet hours */
  deferred: number
  /** Players who reached the reminders-per-spell cap: no more until they open the app */
  stopped: number
  /** Due reminders not sent because no text was left (should not happen with 16+ texts) */
  noText: number
}

/**
 * One scheduler pass (every minute, services/worker.ts): come-back offers
 * first, then due reminders, skipping anyone who just got an offer. Each
 * player is handled on their own; one failure is logged and the rest go on.
 */
export async function runEngagementOnce(ctx: AppContext): Promise<EngagementCounts> {
  const s = await engagementSettings(ctx.db)
  const counts: EngagementCounts = { reminders: 0, offers: 0, deferred: 0, stopped: 0, noText: 0 }
  const offered = await makeComebackOffers(ctx, s, counts)
  await queueDueReminders(ctx, s, offered, counts)
  return counts
}

/** Who may get a bot nudge at all: active, reachable, not opted out, with an account. */
function reachable() {
  return and(eq(users.status, 'active'), isNull(users.botBlockedAt), isNull(users.remindersOptOutAt), isNotNull(users.signedUpAt))
}

async function makeComebackOffers(ctx: AppContext, s: EngagementSettings, counts: EngagementCounts): Promise<Set<string>> {
  const offered = new Set<string>()
  // 0 Raffs = the offer is switched off in settings (the feature switch is per player, below)
  if (s.comebackRaffs < 1) return offered
  const nowMs = ctx.now()
  const cutoff = new Date(nowMs - s.comebackAfterHours * HOUR_MS)
  const cooldownFrom = new Date(nowMs - s.comebackCooldownDays * DAY_MS)

  const due = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        reachable(),
        lte(users.lastSeenAt, cutoff),
        sql`${featureSql('comeback_offer')} = true`,
        // One offer per spell away, and none within the cooldown of the last one
        sql`not exists (select 1 from ${comebackOffers} o
              where o.user_id = ${users.id}
                and (o.offered_at > ${cooldownFrom} or o.spell_started_at = ${users.lastSeenAt}))`,
      ),
    )
    .orderBy(asc(users.lastSeenAt))
    .limit(TICK_LIMIT)

  for (const { id } of due) {
    try {
      const made = await ctx.db.transaction(async (tx) => {
        const [u] = await tx.select().from(users).where(eq(users.id, id)).for('update')
        // Opened the app, opted out or blocked the bot since the list was read
        if (!u || !u.lastSeenAt || u.lastSeenAt > cutoff || u.status !== 'active' || u.botBlockedAt || u.remindersOptOutAt) {
          return false
        }
        const sendAt = inQuietHours(nowMs, s.quietStartHour, s.quietEndHour) ? afterQuietHours(nowMs, s) : nowMs
        const [offer] = await tx
          .insert(comebackOffers)
          .values({
            userId: id,
            raffs: s.comebackRaffs,
            // Copied in SQL, so the spell matches last_seen_at to the microsecond
            spellStartedAt: sql`(select ${users.lastSeenAt} from ${users} where ${users.id} = ${id})`,
            offeredAt: new Date(nowMs),
            // "in the next 7 days" counts from when the message can arrive
            expiresAt: new Date(sendAt + OFFER_DAYS * DAY_MS),
          })
          .onConflictDoNothing()
          .returning({ id: comebackOffers.id })
        if (!offer) return false
        await enqueue(tx, {
          userId: id,
          telegramId: u.telegramId,
          kind: 'comeback',
          text: comebackText(firstName(u), s.comebackRaffs, OFFER_DAYS),
          buttons: engagementButtons(ctx),
          templateKey: 'comeback',
          dedupeKey: `comeback:${offer.id}`,
          notBefore: new Date(sendAt),
        })
        // The next reminder keeps its usual distance from the offer instead of following it within minutes
        if (u.nextReminderAt) {
          await tx
            .update(users)
            .set({ nextReminderAt: new Date(sendAt + reminderDelayMs(s)) })
            .where(eq(users.id, id))
        }
        return true
      })
      if (made) {
        offered.add(id)
        counts.offers += 1
      }
    } catch (error) {
      ctx.log.error({ err: error, userId: id }, 'engagement: could not make a come-back offer')
    }
  }
  return offered
}

async function queueDueReminders(
  ctx: AppContext,
  s: EngagementSettings,
  skip: ReadonlySet<string>,
  counts: EngagementCounts,
): Promise<void> {
  const nowMs = ctx.now()
  const now = new Date(nowMs)
  const due = (
    await ctx.db
      .select({
        id: users.id,
        telegramId: users.telegramId,
        tgFirstName: users.tgFirstName,
        fullName: users.fullName,
        lastSeenAt: users.lastSeenAt,
        createdAt: users.createdAt,
        remindersSinceOpen: users.remindersSinceOpen,
        // As text, so the guarded update below compares to the microsecond
        dueAt: sql<string>`${users.nextReminderAt}::text`,
      })
      .from(users)
      .where(and(reachable(), lte(users.nextReminderAt, now), sql`${featureSql('reminders')} = true`))
      .orderBy(asc(users.nextReminderAt))
      .limit(TICK_LIMIT)
  ).filter((u) => !skip.has(u.id))
  if (due.length === 0) return

  // Only if the schedule is still the one read here: an app open in between resets it, and wins
  const unchanged = (u: { id: string; dueAt: string }) =>
    and(eq(users.id, u.id), sql`${users.nextReminderAt} = ${u.dueAt}::timestamptz`)
  const reschedule = (u: { id: string; dueAt: string }, at: Date | null) =>
    ctx.db.update(users).set({ nextReminderAt: at }).where(unchanged(u))

  if (inQuietHours(nowMs, s.quietStartHour, s.quietEndHour)) {
    for (const u of due) {
      await reschedule(u, new Date(afterQuietHours(nowMs, s)))
      counts.deferred += 1
    }
    return
  }

  // When each player last had each text (sent, or queued and not yet sent)
  const history = await ctx.db
    .select({
      userId: notifications.userId,
      key: notifications.templateKey,
      lastMs: sql<number>`(extract(epoch from max(coalesce(${notifications.sentAt}, ${notifications.notBefore}))) * 1000)::float8`,
    })
    .from(notifications)
    .where(
      and(
        inArray(
          notifications.userId,
          due.map((u) => u.id),
        ),
        eq(notifications.kind, 'reminder'),
        inArray(notifications.status, ['pending', 'sending', 'sent']),
        isNotNull(notifications.templateKey),
        // Bounds the scan; anything older is "long ago" anyway
        sql`${notifications.createdAt} > now() - interval '30 days'`,
      ),
    )
    .groupBy(notifications.userId, notifications.templateKey)
  const lastSent = new Map<string, Map<string, number>>()
  for (const h of history) {
    if (!h.key) continue
    const perUser = lastSent.get(h.userId) ?? new Map<string, number>()
    perUser.set(h.key, Number(h.lastMs))
    lastSent.set(h.userId, perUser)
  }

  for (const u of due) {
    try {
      if (u.remindersSinceOpen >= s.maxRemindersPerSpell) {
        // Enough for this spell: quiet until the player opens the app again
        await reschedule(u, null)
        counts.stopped += 1
        continue
      }
      const key = chooseReminderKey(lastSent.get(u.id) ?? new Map(), nowMs)
      if (!key) {
        ctx.log.warn({ userId: u.id }, 'engagement: every reminder text was used in the last 48 h; skipping this reminder')
        await reschedule(u, new Date(nowMs + reminderDelayMs(s)))
        counts.noText += 1
        continue
      }
      const queued = await ctx.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(users)
          .set({
            remindersSinceOpen: sql`${users.remindersSinceOpen} + 1`,
            lastReminderAt: now,
            nextReminderAt: new Date(nowMs + reminderDelayMs(s)),
          })
          .where(unchanged(u))
          .returning({ id: users.id })
        if (!claimed) return false
        const spell = (u.lastSeenAt ?? u.createdAt).getTime()
        const outcome = await enqueue(tx, {
          userId: u.id,
          telegramId: u.telegramId,
          kind: 'reminder',
          text: renderReminder(key, firstName(u)),
          buttons: engagementButtons(ctx),
          templateKey: key,
          dedupeKey: `reminder:${u.id}:${u.remindersSinceOpen + 1}:${spell}`,
          notBefore: now,
        })
        if (outcome === 'duplicate') ctx.log.warn({ userId: u.id, key }, 'engagement: this reminder was already queued')
        return outcome === 'queued'
      })
      if (queued) counts.reminders += 1
    } catch (error) {
      ctx.log.error({ err: error, userId: u.id }, 'engagement: could not queue a reminder')
    }
  }
}

/* Claiming an offer ------------------------------------------------------------ */

/**
 * Credits the newest unclaimed, unexpired come-back offer, once: a 'bonus'
 * ledger row and the offer marked claimed, in one transaction with the offer
 * row locked, so two opens at the same moment credit it once. Null = nothing
 * to claim. An offer message still waiting in the outbox (quiet hours) is
 * dropped, since the player is already back.
 *
 * An offer made while it was switched on is not credited once settings set it
 * to 0 Raffs or the comeback_offer switch is off for the player: null, and its
 * waiting message is dropped too. The offer itself stays unclaimed, so it pays
 * out if the offer is switched back on before it expires.
 */
export async function claimComeback(ctx: AppContext, userId: string): Promise<{ raffs: number } | null> {
  const now = new Date(ctx.now())
  // Read outside the transaction: featuresFor runs its queries side by side, which one connection cannot
  const withdrawn =
    (await getSetting(ctx.db, 'engagement.comeback_raffs')) < 1 || !(await isFeatureOn(ctx.db, 'comeback_offer', userId))
  return ctx.db.transaction(async (tx) => {
    const [offer] = await tx
      .select()
      .from(comebackOffers)
      .where(and(eq(comebackOffers.userId, userId), isNull(comebackOffers.claimedAt), gt(comebackOffers.expiresAt, now)))
      .orderBy(desc(comebackOffers.offeredAt))
      .limit(1)
      .for('update')
    if (!offer) return null
    const skipMessage = (error: string) =>
      tx
        .update(notifications)
        .set({ status: 'skipped', error })
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.dedupeKey, `comeback:${offer.id}`),
            eq(notifications.status, 'pending'),
          ),
        )
    if (withdrawn) {
      await skipMessage('offer withdrawn')
      return null
    }
    const row = await post(tx, {
      userId,
      type: 'bonus',
      raffs: offer.raffs,
      note: offer.raffs === 1 ? 'Welcome back: 1 free Raff' : `Welcome back: ${offer.raffs} free Raffs`,
      referenceType: 'comeback_offer',
      referenceId: offer.id,
    })
    await tx.update(comebackOffers).set({ claimedAt: now, ledgerId: row.id }).where(eq(comebackOffers.id, offer.id))
    await skipMessage('already claimed')
    return { raffs: offer.raffs }
  })
}
