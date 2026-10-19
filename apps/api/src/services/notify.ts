/**
 * The bot's outbox. Nothing in the API messages a player directly: it queues
 * a notification row (enqueue) or a broadcast to many players
 * (createBroadcast), and the workers (services/worker.ts) do the rest:
 *
 *   fanOutOnce      broadcast -> one notification per matching player, in batches
 *   sendPendingOnce due notifications -> Telegram, at a pace it accepts, with
 *                   every outcome recorded on the row (sent, retried, failed, skipped);
 *                   personal messages first, and a 429 pauses every sender
 *
 * Rows are never deleted, so the admin can always see what a player was sent
 * and why something did not arrive.
 */
import { and, asc, eq, gt, inArray, isNull, lt, lte, sql, type SQL } from 'drizzle-orm'
import type { AppContext } from '../context'
import type { Db } from '../db/client'
import {
  broadcasts,
  entries,
  notifications,
  settings,
  users,
  type BroadcastRow,
  type NotificationButton,
  type NotificationRow,
} from '../db/schema'
import { escapeHtml } from '../lib/html'
import { afterQuietHours, engagementSettings, inQuietHours, type EngagementSettings } from './engagement'
import { featureSql } from './features'

type Writer = Pick<Db, 'insert'>
type NotificationKind = NotificationRow['kind']
type BroadcastKind = BroadcastRow['kind']

/* Queueing ------------------------------------------------------------------- */

export interface EnqueueInput {
  userId: string
  /** Private chat id = the player's Telegram id */
  telegramId: number
  kind: NotificationKind
  /** Telegram HTML, already escaped (lib/html.ts) */
  text: string
  buttons?: NotificationButton[][] | null
  /** Which reminder text or template produced it (r01.., ...) */
  templateKey?: string | null
  /** One message per player per key, e.g. transfer:<id>; a second enqueue is a no-op */
  dedupeKey?: string | null
  /** Not sent before this (quiet hours); default now */
  notBefore?: Date
  broadcastId?: string | null
}

/** Queues one message to one player. 'duplicate' = that player already has one with this dedupe key. */
export async function enqueue(db: Writer, input: EnqueueInput): Promise<'queued' | 'duplicate'> {
  const rows = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      telegramId: input.telegramId,
      kind: input.kind,
      text: input.text,
      buttons: input.buttons ?? null,
      templateKey: input.templateKey ?? null,
      dedupeKey: input.dedupeKey ?? null,
      broadcastId: input.broadcastId ?? null,
      ...(input.notBefore ? { notBefore: input.notBefore } : {}),
    })
    // The only unique rule a new row can hit is (user_id, dedupe_key)
    .onConflictDoNothing()
    .returning({ id: notifications.id })
  return rows.length ? 'queued' : 'duplicate'
}

/**
 * A button that opens the Mini App, optionally at a route (e.g. 'wallet').
 * Null when this server has no PUBLIC_APP_URL: send the message without it.
 */
export function openAppButton(ctx: Pick<AppContext, 'config'>, label = 'Open Raffle Win', path?: string): NotificationButton | null {
  const base = ctx.config.PUBLIC_APP_URL
  if (!base) return null
  const route = path?.replace(/^[#/]+/, '')
  return { text: label, webApp: route ? `${base}#/${route}` : base }
}

/* Broadcasts ----------------------------------------------------------------- */

/** As stored in broadcasts.audience: usernames are resolved to user ids before it is saved. */
export type StoredAudience =
  | { type: 'all' }
  | { type: 'no_phone' }
  | { type: 'inactive'; days: number }
  | { type: 'users'; userIds: string[] }

export interface BroadcastInput {
  kind: BroadcastKind
  title?: string
  /** Plain text as written; escaped when sent */
  text: string
  openButton: boolean
  audience: StoredAudience
  refType?: string | null
  refId?: string | null
  adminId?: string | null
}

/** Creates a broadcast in fanning_out; the scheduler queues its messages within a minute. */
export async function createBroadcast(tx: Writer, input: BroadcastInput): Promise<BroadcastRow> {
  const [row] = await tx
    .insert(broadcasts)
    .values({
      kind: input.kind,
      title: input.title ?? '',
      text: input.text,
      openButton: input.openButton,
      audience: input.audience,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      createdByAdminId: input.adminId ?? null,
    })
    .returning()
  if (!row) throw new Error('broadcast insert returned no row')
  return row
}

/** The message as Telegram HTML: bold title (when given), a blank line, then the text. */
export function broadcastText(b: { title?: string | null; text: string }): string {
  const title = b.title?.trim()
  return title ? `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(b.text)}` : escapeHtml(b.text)
}

const BROADCAST_NOTIFICATION_KIND: Record<BroadcastKind, NotificationKind> = {
  announcement: 'announcement',
  feature: 'feature',
  raffle_new: 'raffle_new',
  raffle_cancelled: 'raffle_cancelled',
  raffle_drawn: 'raffle_drawn',
}

/** Who a broadcast reaches, as SQL over users. Blocked and suspended players never are. */
function audienceWhere(ctx: AppContext, b: BroadcastRow): SQL {
  const audience = b.audience as StoredAudience
  const parts: SQL[] = [eq(users.status, 'active'), isNull(users.botBlockedAt)]
  switch (audience.type) {
    case 'all':
      break
    case 'no_phone':
      parts.push(isNull(users.phone))
      break
    case 'inactive': {
      const cutoff = new Date(ctx.now() - audience.days * 86_400_000)
      parts.push(lt(sql`coalesce(${users.lastSeenAt}, ${users.createdAt})`, cutoff))
      break
    }
    case 'users':
      // One array parameter, however long the list (inArray binds one parameter per id, and
      // Postgres takes at most 65535); an empty list matches nobody
      parts.push(sql`${users.id} = any(${sql.param(audience.userIds)}::uuid[])`)
      break
    default:
      throw new Error(`broadcast ${b.id}: unknown audience ${JSON.stringify(audience)}`)
  }
  // Players can switch new-raffle alerts off (or an admin for them); announcements always go
  if (b.kind === 'raffle_new') parts.push(sql`${featureSql('new_raffle_alerts')} = true`)
  // Winners announced: the raffle's own entrants always hear, everyone else as with new raffles
  if (b.kind === 'raffle_drawn') {
    parts.push(
      sql`(${featureSql('new_raffle_alerts')} = true or exists (select 1 from ${entries} e where e.user_id = ${users.id} and e.raffle_id::text = ${b.refId}))`,
    )
  }
  if (b.cursorUserId) parts.push(gt(users.id, b.cursorUserId))
  return and(...parts) as SQL
}

/**
 * One scheduler pass over broadcasts: queues the next batches of messages for
 * each broadcast still fanning out (oldest first, players in id order after
 * the cursor), moves a broadcast to 'sending' when no players are left, and
 * marks 'done' every sending broadcast with nothing pending any more.
 * At most `maxBatches` batches per broadcast per pass, so one huge audience
 * cannot hold the scheduler for long; the next pass carries on from the cursor.
 * A broadcast that fails is logged and tried again next pass; it never holds
 * up newer broadcasts or the 'done' step.
 */
export async function fanOutOnce(
  ctx: AppContext,
  batch = 1000,
  maxBatches = 10,
): Promise<{ queued: number; finished: number }> {
  const open = await ctx.db
    .select({ id: broadcasts.id })
    .from(broadcasts)
    .where(eq(broadcasts.status, 'fanning_out'))
    .orderBy(asc(broadcasts.createdAt))
  let queued = 0
  for (const { id } of open) {
    try {
      for (let i = 0; i < maxBatches; i++) {
        const step = await fanOutBatch(ctx, id, batch)
        queued += step.queued
        if (step.finished) break
      }
    } catch (error) {
      ctx.log.error({ err: error, broadcastId: id }, 'broadcast fan-out failed; the other broadcasts go on and this one is tried again next pass')
    }
  }

  // Done = fanned out and nothing left to send (sent, failed or skipped)
  const done = await ctx.db
    .update(broadcasts)
    .set({ status: 'done', finishedAt: new Date(ctx.now()) })
    .where(
      and(
        eq(broadcasts.status, 'sending'),
        sql`not exists (select 1 from ${notifications} n
              where n.broadcast_id = ${broadcasts.id} and n.status in ('pending', 'sending'))`,
      ),
    )
    .returning({ id: broadcasts.id })
  return { queued, finished: done.length }
}

/** One batch of one broadcast, in one transaction with the broadcast row locked. */
async function fanOutBatch(ctx: AppContext, broadcastId: string, batch: number): Promise<{ queued: number; finished: boolean }> {
  return ctx.db.transaction(async (tx) => {
    const [b] = await tx.select().from(broadcasts).where(eq(broadcasts.id, broadcastId)).for('update')
    // Cancelled (or finished by another pass) since the list was read
    if (!b || b.status !== 'fanning_out') return { queued: 0, finished: true }

    const recipients = await tx
      .select({ id: users.id, telegramId: users.telegramId })
      .from(users)
      .where(audienceWhere(ctx, b))
      .orderBy(asc(users.id))
      .limit(batch)
    if (recipients.length === 0) {
      await tx.update(broadcasts).set({ status: 'sending' }).where(eq(broadcasts.id, b.id))
      return { queued: 0, finished: true }
    }

    const text = broadcastText(b)
    const button = b.openButton ? openAppButton(ctx) : null
    const inserted = await tx
      .insert(notifications)
      .values(
        recipients.map((r) => ({
          userId: r.id,
          telegramId: r.telegramId,
          kind: BROADCAST_NOTIFICATION_KIND[b.kind],
          text,
          buttons: button ? [[button]] : null,
          broadcastId: b.id,
          dedupeKey: `b:${b.id}`,
        })),
      )
      // A player already queued for this broadcast (a pass that died mid-way) is not queued twice
      .onConflictDoNothing()
      .returning({ id: notifications.id })
    const last = recipients[recipients.length - 1]!
    await tx
      .update(broadcasts)
      .set({ cursorUserId: last.id, total: sql`${broadcasts.total} + ${inserted.length}` })
      .where(eq(broadcasts.id, b.id))
    return { queued: inserted.length, finished: false }
  })
}

/* Sending -------------------------------------------------------------------- */

/** A claim older than this belongs to a sender that died mid-send; the row goes back to pending. */
const STALE_CLAIM_MS = 5 * 60_000
/** Waits after a failed attempt 1, 2, 3, 4; attempt 5 failing ends it */
const BACKOFF_MINUTES = [1, 5, 30, 30]
const MAX_ATTEMPTS = 5
/** Telegram allows about 30 messages a second to different chats; stay well under */
const DEFAULT_GAP_MS = 40
/** Kinds a player's "reminders off" switch silences. Announcements, raffles and transfers still go. */
const OPT_OUT_KINDS: ReadonlySet<NotificationKind> = new Set(['reminder', 'comeback'])
/** The same nudges never arrive in quiet hours, even when a backlog or a 429 pause carries them there */
const QUIET_HOURS_KINDS = OPT_OUT_KINDS
/**
 * Claim order when more is due than one pass takes: a player's own transfer
 * or win first, then reminders and offers, then broadcasts; oldest first within each.
 * A 50,000-player announcement must not hold a transfer back for minutes.
 */
const KIND_RANK = sql`case ${notifications.kind} when 'transfer' then 0 when 'raffle_won' then 0 when 'comeback' then 1 when 'reminder' then 1 else 2 end`
function kindRank(kind: NotificationKind): number {
  return kind === 'transfer' || kind === 'raffle_won' ? 0 : kind === 'comeback' || kind === 'reminder' ? 1 : 2
}

/**
 * Telegram's 429 limits the whole bot, so it pauses every sender process, not
 * only the one that hit it: stored as epoch ms in a row of the settings table
 * (not an admin setting; services/settings.ts never reads this key).
 */
export const OUTBOX_PAUSE_KEY = 'outbox.paused_until'

/** Until when (epoch ms) senders wait after a 429; 0 = not paused. */
export async function outboxPausedUntil(db: Pick<Db, 'select'>): Promise<number> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, OUTBOX_PAUSE_KEY))
  const v = (row?.value as { v?: unknown } | undefined)?.v
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

async function pauseOutbox(db: Pick<Db, 'insert'>, untilMs: number): Promise<void> {
  const value = { v: untilMs }
  await db
    .insert(settings)
    .values({ key: OUTBOX_PAUSE_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } })
}

export type SendFailure =
  | { kind: 'rate_limited'; retryAfterSeconds: number; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'transient'; message: string }

/**
 * Sorts a send error by what to do about it. Duck-typed on grammY's
 * GrammyError (error_code, description, parameters.retry_after), so a plain
 * object works too; anything else (network, timeouts) is transient.
 */
export function classifySendError(error: unknown): SendFailure {
  const e = error as { error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown }; message?: unknown }
  const code = typeof e?.error_code === 'number' ? e.error_code : null
  const description =
    typeof e?.description === 'string' ? e.description : typeof e?.message === 'string' ? e.message : String(error)
  const message = (code ? `${code}: ${description}` : description).slice(0, 500)
  if (code === 429) {
    const retry = Number(e.parameters?.retry_after)
    return { kind: 'rate_limited', retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : 5, message }
  }
  if (code === 403 || (code === 400 && /chat not found|user is deactivated|bot was blocked/i.test(description))) {
    return { kind: 'blocked', message }
  }
  return { kind: 'transient', message }
}

export interface SendCounts {
  sent: number
  failed: number
  retried: number
  skipped: number
}

/**
 * One sender pass: takes back stale claims, does nothing while a 429 pause
 * lasts, claims up to `max` due messages (transfers, then reminders and
 * offers, then broadcasts; SKIP LOCKED, so parallel senders never share a
 * row), sends them about `gapMs` apart and records each outcome:
 *   sent                        sent_at, telegram_message_id
 *   429 slow down               every sender pauses for retry_after (OUTBOX_PAUSE_KEY), and this
 *                               row, the rest of the pass and everything else due wait until then;
 *                               not counted as an attempt
 *   403 / chat gone             failed, and the player is marked bot_blocked_at
 *   anything else               pending again after 1, 5, 30, 30 min; failed on the 5th attempt
 *   player blocked / suspended  skipped (and opted out, for reminders and offers)
 *   reminder or offer in        pending again 0-90 min after quiet hours end (Lagos); not an
 *   quiet hours                 attempt, counted as retried
 */
export async function sendPendingOnce(
  ctx: AppContext,
  opts: { max?: number; gapMs?: number } = {},
): Promise<SendCounts> {
  const max = opts.max ?? 25
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS
  const counts: SendCounts = { sent: 0, failed: 0, retried: 0, skipped: 0 }
  const now = () => new Date(ctx.now())
  // Due by the database clock or the injected one, whichever is later: now() has
  // microseconds, so a row queued this millisecond would otherwise look early
  const dueBy = () => sql`greatest(now(), ${now()})`

  const reclaimed = await ctx.db
    .update(notifications)
    .set({ status: 'pending', lockedAt: null })
    .where(and(eq(notifications.status, 'sending'), lt(notifications.lockedAt, new Date(ctx.now() - STALE_CLAIM_MS))))
    .returning({ id: notifications.id })
  if (reclaimed.length) ctx.log.warn({ count: reclaimed.length }, 'outbox: took back messages a sender claimed and never finished')

  const send = ctx.sendTelegram
  if (!send) {
    const [due] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.status, 'pending'), lte(notifications.notBefore, dueBy())))
    if (due && due.n > 0) ctx.log.warn({ due: due.n }, 'outbox: messages are due but this process cannot send (no bot configured)')
    return counts
  }

  // Telegram asked the bot (in this process or another) to slow down: nothing goes out until then
  if (ctx.now() < (await outboxPausedUntil(ctx.db))) return counts

  const dueIds = ctx.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.status, 'pending'), lte(notifications.notBefore, dueBy())))
    .orderBy(KIND_RANK, asc(notifications.notBefore))
    .limit(max)
    .for('update', { skipLocked: true })
  const claimed = await ctx.db
    .update(notifications)
    .set({ status: 'sending', lockedAt: now(), attempts: sql`${notifications.attempts} + 1` })
    .where(inArray(notifications.id, dueIds))
    .returning()
  if (claimed.length === 0) return counts
  claimed.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.notBefore.getTime() - b.notBefore.getTime())

  const userIds = [...new Set(claimed.map((n) => n.userId))]
  const people = await ctx.db
    .select({ id: users.id, status: users.status, botBlockedAt: users.botBlockedAt, remindersOptOutAt: users.remindersOptOutAt })
    .from(users)
    .where(inArray(users.id, userIds))
  const byId = new Map(people.map((p) => [p.id, p]))

  const finish = (id: string, set: Partial<typeof notifications.$inferInsert>) =>
    ctx.db.update(notifications).set({ lockedAt: null, ...set }).where(eq(notifications.id, id))

  // Read once, and only when a reminder or offer is in the pass
  let quiet: EngagementSettings | null = null

  let sentOne = false
  for (let i = 0; i < claimed.length; i++) {
    const n = claimed[i]!
    const who = byId.get(n.userId)
    const skipReason = !who
      ? 'no account'
      : who.status !== 'active'
        ? 'suspended'
        : who.botBlockedAt
          ? 'blocked'
          : who.remindersOptOutAt && OPT_OUT_KINDS.has(n.kind)
            ? 'opted out'
            : null
    if (skipReason) {
      await finish(n.id, { status: 'skipped', error: skipReason })
      counts.skipped += 1
      continue
    }

    if (QUIET_HOURS_KINDS.has(n.kind)) {
      quiet ??= await engagementSettings(ctx.db)
      if (inQuietHours(ctx.now(), quiet.quietStartHour, quiet.quietEndHour)) {
        // Queued before quiet hours but held up (a backlog, a 429 pause): it waits for the morning
        await finish(n.id, {
          status: 'pending',
          notBefore: new Date(afterQuietHours(ctx.now(), quiet)),
          attempts: Math.max(n.attempts - 1, 0),
        })
        counts.retried += 1
        continue
      }
    }

    if (sentOne && gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs))
    sentOne = true
    try {
      const result = await send(n.telegramId, n.text, { html: true, buttons: n.buttons ?? undefined })
      await finish(n.id, { status: 'sent', sentAt: now(), telegramMessageId: result?.messageId ?? null, error: null })
      counts.sent += 1
    } catch (error) {
      const failure = classifySendError(error)
      if (failure.kind === 'rate_limited') {
        // Telegram limits the whole bot: this row and the rest of the pass wait, none of it counted as an attempt
        const untilMs = ctx.now() + failure.retryAfterSeconds * 1000
        const notBefore = new Date(untilMs)
        const rest = claimed.slice(i).map((r) => r.id)
        await ctx.db
          .update(notifications)
          .set({ status: 'pending', lockedAt: null, notBefore, attempts: sql`greatest(${notifications.attempts} - 1, 0)`, error: failure.message })
          .where(and(inArray(notifications.id, rest), eq(notifications.status, 'sending')))
        // So do the other senders, and everything else already due
        await pauseOutbox(ctx.db, untilMs)
        await ctx.db
          .update(notifications)
          .set({ notBefore })
          .where(and(eq(notifications.status, 'pending'), lte(notifications.notBefore, dueBy())))
        counts.retried += rest.length
        ctx.log.warn({ retryAfter: failure.retryAfterSeconds, waiting: rest.length }, 'outbox: Telegram asked the bot to slow down')
        break
      }
      if (failure.kind === 'blocked') {
        await finish(n.id, { status: 'failed', error: failure.message })
        await ctx.db
          .update(users)
          .set({ botBlockedAt: sql`coalesce(${users.botBlockedAt}, ${now()})` })
          .where(eq(users.id, n.userId))
        // Later rows for this player in the same pass are skipped, not sent into the same wall
        byId.set(n.userId, { ...who!, botBlockedAt: now() })
        counts.failed += 1
        continue
      }
      if (n.attempts >= MAX_ATTEMPTS) {
        await finish(n.id, { status: 'failed', error: failure.message })
        counts.failed += 1
        ctx.log.error({ notificationId: n.id, attempts: n.attempts, error: failure.message }, 'outbox: message failed for good')
      } else {
        const waitMin = BACKOFF_MINUTES[Math.min(n.attempts, BACKOFF_MINUTES.length) - 1] ?? 30
        await finish(n.id, { status: 'pending', notBefore: new Date(ctx.now() + waitMin * 60_000), error: failure.message })
        counts.retried += 1
        ctx.log.warn({ notificationId: n.id, attempts: n.attempts, error: failure.message }, 'outbox: send failed, will retry')
      }
    }
  }
  return counts
}
