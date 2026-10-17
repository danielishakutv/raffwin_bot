/**
 * Admin > Messages: notices and announcements sent by the bot, the outbox
 * they become, and the engagement settings (reminders, come-back offer,
 * streak rewards, transfer caps). Nothing here messages a player directly:
 * broadcasts and notifications are queued, and the workers send them
 * (services/notify.ts, services/worker.ts). Every write is audited.
 */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, isNotNull, ne, or, sql } from 'drizzle-orm'
import type { BroadcastBody, EngagementBody } from '@raffwin/shared/admin-schemas'
import type { AdminBroadcast, AdminEngagement, AdminNotification } from '@raffwin/shared/admin-types'
import type { Page } from '@raffwin/shared'
import type { AppContext } from '../context'
import type { Db } from '../db/client'
import {
  adminUsers,
  broadcasts,
  notifications,
  users,
  type AdminUserRow,
  type BroadcastRow,
  type NotificationRow,
  type RaffleRow,
  type UserRow,
} from '../db/schema'
import { HttpError } from '../lib/http-error'
import { REMINDER_TEXTS } from '../services/engagement-messages'
import type { Tx } from '../services/ledger'
import { broadcastText, createBroadcast, enqueue, openAppButton, type StoredAudience } from '../services/notify'
import { getAllSettings, putSetting } from '../services/settings'
import { appendAudit } from './audit'

type Reader = Pick<Db, 'select'>
type BroadcastKind = BroadcastRow['kind']

/* Players by handle ---------------------------------------------------------- */

/** "@Ada_Obi" -> "ada_obi"; Telegram ids stay digits */
export function normaliseHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').toLowerCase()
}

const TELEGRAM_ID = /^[0-9]{5,15}$/

/**
 * Resolves what an admin typed (Raffle Win username, Telegram username, with
 * or without @, or a Telegram id) to players. Raffle Win usernames win over
 * Telegram usernames; a Telegram username two accounts share (one of them
 * stale) resolves to nobody rather than to a guess.
 */
export async function resolvePlayers(
  db: Reader,
  handles: string[],
): Promise<{ found: Map<string, UserRow>; missing: string[] }> {
  const wanted = [...new Set(handles.map(normaliseHandle).filter(Boolean))]
  const ids = wanted.filter((h) => TELEGRAM_ID.test(h)).map(Number)
  const names = wanted.filter((h) => !TELEGRAM_ID.test(h))
  const rows = wanted.length
    ? await db
        .select()
        .from(users)
        .where(
          or(
            ids.length ? inArray(users.telegramId, ids) : undefined,
            names.length ? inArray(users.username, names) : undefined,
            names.length ? inArray(sql`lower(${users.tgUsername})`, names) : undefined,
          ),
        )
    : []
  const found = new Map<string, UserRow>()
  const missing: string[] = []
  for (const h of wanted) {
    const match = TELEGRAM_ID.test(h)
      ? rows.find((u) => u.telegramId === Number(h))
      : (rows.find((u) => u.username === h) ??
        (() => {
          const byTg = rows.filter((u) => u.tgUsername?.toLowerCase() === h)
          return byTg.length === 1 ? byTg[0] : undefined
        })())
    if (match) found.set(h, match)
    else missing.push(h)
  }
  return { found, missing }
}

/* Shapes ---------------------------------------------------------------------- */

export function toAdminNotification(n: NotificationRow, username: string | null): AdminNotification {
  return {
    id: n.id,
    kind: n.kind,
    templateKey: n.templateKey,
    username,
    text: n.text,
    status: n.status,
    attempts: n.attempts,
    error: n.error,
    notBefore: n.notBefore.toISOString(),
    sentAt: n.sentAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  }
}

function audienceLabel(b: Pick<BroadcastRow, 'audience' | 'refType' | 'kind'>): string {
  const a = b.audience as StoredAudience
  if (b.refType === 'test') return 'Test: your own Telegram'
  switch (a.type) {
    case 'all':
      return b.kind === 'raffle_new' ? 'Everyone with new raffle alerts on' : 'Everyone'
    case 'no_phone':
      return 'Players without a phone number'
    case 'inactive':
      return `Inactive ${a.days}+ day${a.days === 1 ? '' : 's'}`
    case 'users': {
      const n = a.userIds.length
      if (b.kind === 'raffle_cancelled') return `The raffle's ${n} entrant${n === 1 ? '' : 's'}`
      return `${n} named player${n === 1 ? '' : 's'}`
    }
    default:
      return 'Unknown audience'
  }
}

async function toAdminBroadcasts(ctx: AppContext, rows: { b: BroadcastRow; createdBy: string | null }[]): Promise<AdminBroadcast[]> {
  if (rows.length === 0) return []
  const counts = await ctx.db
    .select({
      id: notifications.broadcastId,
      sent: sql<number>`count(*) filter (where ${notifications.status} = 'sent')::int`,
      failed: sql<number>`count(*) filter (where ${notifications.status} = 'failed')::int`,
      // Not attempted: stopped by an admin, blocked the bot, suspended. Not a failure.
      skipped: sql<number>`count(*) filter (where ${notifications.status} = 'skipped')::int`,
      pending: sql<number>`count(*) filter (where ${notifications.status} in ('pending', 'sending'))::int`,
    })
    .from(notifications)
    .where(inArray(notifications.broadcastId, rows.map((r) => r.b.id)))
    .groupBy(notifications.broadcastId)
  const byId = new Map(counts.map((c) => [c.id, c]))
  return rows.map(({ b, createdBy }) => {
    const c = byId.get(b.id)
    return {
      id: b.id,
      kind: b.kind,
      title: b.title,
      text: b.text,
      openButton: b.openButton,
      audienceLabel: audienceLabel(b),
      status: b.status,
      total: b.total,
      sent: c?.sent ?? 0,
      failed: c?.failed ?? 0,
      skipped: c?.skipped ?? 0,
      pending: c?.pending ?? 0,
      createdBy,
      createdAt: b.createdAt.toISOString(),
      finishedAt: b.finishedAt?.toISOString() ?? null,
    }
  })
}

const creatorName = sql<string | null>`(select a.name from ${adminUsers} a where a.id = "broadcasts"."created_by_admin_id")`

export async function listBroadcasts(ctx: AppContext): Promise<AdminBroadcast[]> {
  const rows = await ctx.db
    .select({ b: broadcasts, createdBy: creatorName })
    .from(broadcasts)
    .orderBy(desc(broadcasts.createdAt))
    .limit(50)
  return toAdminBroadcasts(ctx, rows)
}

export async function getBroadcast(ctx: AppContext, id: string): Promise<AdminBroadcast> {
  const rows = await ctx.db.select({ b: broadcasts, createdBy: creatorName }).from(broadcasts).where(eq(broadcasts.id, id))
  if (!rows[0]) throw new HttpError('NOT_FOUND', 'No such broadcast.')
  return (await toAdminBroadcasts(ctx, rows))[0] as AdminBroadcast
}

/* Sending --------------------------------------------------------------------- */

/**
 * A notice or announcement from an admin. test = only to the admin's own
 * Telegram: queued to their player account when they have one (so it shows in
 * history like any broadcast), otherwise sent at once by the bot.
 */
export async function createAdminBroadcast(ctx: AppContext, admin: AdminUserRow, body: BroadcastBody): Promise<AdminBroadcast> {
  if (body.test) return sendTest(ctx, admin, body)

  let audience: StoredAudience
  if (body.audience.type === 'users') {
    const { found, missing } = await resolvePlayers(ctx.db, body.audience.users)
    if (missing.length) {
      const list = missing.map((h) => (TELEGRAM_ID.test(h) ? h : `@${h}`)).join(', ')
      throw new HttpError('INVALID_INPUT', `No Raffle Win player found for: ${list}. Check the spelling, or use their Telegram id.`, {
        'audience.users': `Not found: ${list}`,
      })
    }
    audience = { type: 'users', userIds: [...new Set([...found.values()].map((u) => u.id))] }
  } else {
    audience = body.audience
  }

  const id = await ctx.db.transaction(async (tx) => {
    const b = await createBroadcast(tx, {
      kind: 'announcement',
      title: body.title,
      text: body.text,
      openButton: body.openButton,
      audience,
      adminId: admin.id,
    })
    await appendAudit(tx, {
      adminId: admin.id,
      action: 'broadcast.create',
      targetType: 'broadcast',
      targetId: b.id,
      after: { title: body.title, text: body.text, openButton: body.openButton, audience: audienceLabel(b), userIds: audience.type === 'users' ? audience.userIds : undefined },
    })
    return b.id
  })
  return getBroadcast(ctx, id)
}

async function sendTest(ctx: AppContext, admin: AdminUserRow, body: BroadcastBody): Promise<AdminBroadcast> {
  if (admin.telegramId === null) throw new HttpError('INVALID_INPUT', 'Your admin account has no Telegram account bound yet.')
  const [player] = await ctx.db.select().from(users).where(eq(users.telegramId, admin.telegramId))
  const button = body.openButton ? openAppButton(ctx) : null

  if (!player) {
    // No player account to queue it to: the bot sends it now, and nothing is stored but the audit row
    const send = ctx.sendTelegram
    if (!send) throw new HttpError('NOT_READY', 'This server cannot message Telegram right now, so the test was not sent.')
    try {
      await send(admin.telegramId, broadcastText(body), { html: true, buttons: button ? [[button]] : undefined })
    } catch (error) {
      ctx.log.error({ err: error, adminId: admin.id }, 'test broadcast: the bot could not message the admin')
      throw new HttpError('SERVER_ERROR', 'The bot could not message your Telegram account. Open the bot, press Start, then try again.')
    }
    await ctx.db.transaction((tx) =>
      appendAudit(tx, { adminId: admin.id, action: 'broadcast.test', targetType: 'admin', targetId: admin.id, after: { title: body.title, direct: true } }),
    )
    const now = new Date(ctx.now()).toISOString()
    return {
      id: randomUUID(),
      kind: 'announcement',
      title: body.title,
      text: body.text,
      openButton: body.openButton,
      audienceLabel: 'Test: your own Telegram',
      status: 'done',
      total: 1,
      sent: 1,
      failed: 0,
      skipped: 0,
      pending: 0,
      createdBy: admin.name,
      createdAt: now,
      finishedAt: now,
    }
  }

  const id = await ctx.db.transaction(async (tx) => {
    const b = await createBroadcast(tx, {
      kind: 'announcement',
      title: body.title,
      text: body.text,
      openButton: body.openButton,
      audience: { type: 'users', userIds: [player.id] },
      refType: 'test',
      adminId: admin.id,
    })
    // Queued straight away (no waiting for the scheduler's fan-out): the sender picks it up within seconds
    await enqueue(tx, {
      userId: player.id,
      telegramId: player.telegramId,
      kind: 'announcement',
      text: broadcastText(b),
      buttons: button ? [[button]] : null,
      broadcastId: b.id,
      dedupeKey: `b:${b.id}`,
    })
    await tx.update(broadcasts).set({ status: 'sending', total: 1, cursorUserId: player.id }).where(eq(broadcasts.id, b.id))
    await appendAudit(tx, { adminId: admin.id, action: 'broadcast.test', targetType: 'broadcast', targetId: b.id, after: { title: body.title } })
    return b.id
  })
  return getBroadcast(ctx, id)
}

/** Stops a broadcast: no more players are queued, and messages not yet sent are skipped ('cancelled'). */
export async function cancelBroadcast(ctx: AppContext, adminId: string, id: string): Promise<AdminBroadcast> {
  await ctx.db.transaction(async (tx) => {
    const [b] = await tx.select().from(broadcasts).where(eq(broadcasts.id, id)).for('update')
    if (!b) throw new HttpError('NOT_FOUND', 'No such broadcast.')
    if (b.status === 'done' || b.status === 'cancelled') {
      throw new HttpError('INVALID_INPUT', b.status === 'done' ? 'This broadcast has already been sent to everyone.' : 'This broadcast is already cancelled.')
    }
    const skipped = await stopBroadcast(tx, b.id, new Date(ctx.now()))
    await appendAudit(tx, {
      adminId,
      action: 'broadcast.cancel',
      targetType: 'broadcast',
      targetId: b.id,
      before: { status: b.status, total: b.total },
      after: { status: 'cancelled', skipped },
    })
  })
  return getBroadcast(ctx, id)
}

/**
 * Cancelled + every pending message skipped. A message a sender has already
 * claimed ('sending') finishes: it may be on its way to Telegram right now.
 */
async function stopBroadcast(tx: Tx, broadcastId: string, at: Date): Promise<number> {
  await tx.update(broadcasts).set({ status: 'cancelled', finishedAt: at }).where(eq(broadcasts.id, broadcastId))
  const skipped = await tx
    .update(notifications)
    .set({ status: 'skipped', error: 'cancelled', lockedAt: null })
    .where(and(eq(notifications.broadcastId, broadcastId), eq(notifications.status, 'pending')))
    .returning({ id: notifications.id })
  return skipped.length
}

/** Cancels the still-running broadcasts about something (e.g. a raffle's alert once it is unpublished). */
export async function cancelBroadcastsFor(
  tx: Tx,
  ref: { type: string; id: string },
  kinds: BroadcastKind[],
  at: Date,
): Promise<number> {
  const running = await tx
    .select({ id: broadcasts.id })
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.refType, ref.type),
        eq(broadcasts.refId, ref.id),
        inArray(broadcasts.kind, kinds),
        inArray(broadcasts.status, ['fanning_out', 'sending']),
      ),
    )
    .for('update')
  for (const b of running) await stopBroadcast(tx, b.id, at)
  return running.length
}

/* Raffle alerts ---------------------------------------------------------------- */

const LAGOS_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

/**
 * A raffle just opened: everyone with new raffle alerts on hears about it
 * (the fan-out filters on that feature). Once per raffle: re-opening one that
 * was unpublished does not alert again unless its first alert was stopped.
 */
export async function announceRaffleOpened(
  tx: Tx,
  raffle: Pick<RaffleRow, 'id' | 'prizeName' | 'entryPriceRaffs' | 'deadline'>,
  prizeCount: number,
  adminId: string | null,
): Promise<string | null> {
  const [earlier] = await tx
    .select({ id: broadcasts.id })
    .from(broadcasts)
    .where(and(eq(broadcasts.kind, 'raffle_new'), eq(broadcasts.refType, 'raffle'), eq(broadcasts.refId, raffle.id), ne(broadcasts.status, 'cancelled')))
  if (earlier) return null
  const price = raffle.entryPriceRaffs
  const lines = [
    `One entry: ${price.toLocaleString('en-NG')} Raff${price === 1 ? '' : 's'}.${prizeCount > 1 ? ` ${prizeCount} prizes to win.` : ''}`,
    `Entries close ${LAGOS_TIME.format(raffle.deadline)} (Lagos time).`,
    '',
    'Tap below to enter.',
  ]
  const b = await createBroadcast(tx, {
    kind: 'raffle_new',
    title: `New raffle: ${raffle.prizeName}`,
    text: lines.join('\n'),
    openButton: true,
    audience: { type: 'all' },
    refType: 'raffle',
    refId: raffle.id,
    adminId,
  })
  return b.id
}

/**
 * A cancelled raffle's entrants hear that it was cancelled and that every
 * Raff they spent on it is back in their balance (cancelRaffle refunds each
 * entry in full). Nobody entered = no message. Its new-raffle alert, if still
 * going out, is stopped.
 */
export async function announceRaffleCancelled(
  tx: Tx,
  raffle: Pick<RaffleRow, 'id' | 'prizeName'>,
  entrantIds: string[],
  adminId: string | null,
  at: Date,
): Promise<string | null> {
  await cancelBroadcastsFor(tx, { type: 'raffle', id: raffle.id }, ['raffle_new'], at)
  const userIds = [...new Set(entrantIds)]
  if (userIds.length === 0) return null
  const b = await createBroadcast(tx, {
    kind: 'raffle_cancelled',
    title: `Raffle cancelled: ${raffle.prizeName}`,
    text: `The ${raffle.prizeName} raffle has been cancelled. Every Raff you spent on entries in it has been refunded to your Raffle Win balance, in full.\n\nWe are sorry about this. Tap below to see your balance and the raffles still open.`,
    openButton: true,
    audience: { type: 'users', userIds },
    refType: 'raffle',
    refId: raffle.id,
    adminId,
  })
  return b.id
}

/* Outbox ------------------------------------------------------------------------ */

export const NOTIFICATION_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'] as const

export async function listNotifications(
  ctx: AppContext,
  q: { cursor?: string; limit: number; kind?: NotificationRow['kind']; status?: NotificationRow['status']; userId?: string },
): Promise<Page<AdminNotification>> {
  // Cursor "<iso ms>|<id>", newest first; created_at has microseconds, so compare at milliseconds with the id as tie-break
  const [iso, id] = (q.cursor ?? '').split('|')
  const before = q.cursor ? { at: new Date(iso ?? ''), id: id ?? '' } : null
  if (before && (Number.isNaN(before.at.getTime()) || !/^[0-9a-f-]{36}$/.test(before.id))) {
    throw new HttpError('INVALID_INPUT', 'Malformed cursor.')
  }
  const at = sql`date_trunc('milliseconds', ${notifications.createdAt})`
  const rows = await ctx.db
    .select({ n: notifications, username: users.username })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.userId))
    .where(
      and(
        before ? sql`(${at}, ${notifications.id}) < (${before.at.toISOString()}::timestamptz, ${before.id}::uuid)` : undefined,
        q.kind ? eq(notifications.kind, q.kind) : undefined,
        q.status ? eq(notifications.status, q.status) : undefined,
        q.userId ? eq(notifications.userId, q.userId) : undefined,
      ),
    )
    .orderBy(desc(at), desc(notifications.id))
    .limit(q.limit + 1)
  const page = rows.slice(0, q.limit)
  const last = page[page.length - 1]
  return {
    items: page.map((r) => toAdminNotification(r.n, r.username)),
    nextCursor: rows.length > q.limit && last ? `${last.n.createdAt.toISOString()}|${last.n.id}` : null,
  }
}

/* Engagement settings ------------------------------------------------------------ */

const ENGAGEMENT_KEYS = {
  reminderMinHours: 'engagement.reminder_min_hours',
  reminderMaxHours: 'engagement.reminder_max_hours',
  maxRemindersPerSpell: 'engagement.max_reminders_per_spell',
  quietStartHour: 'engagement.quiet_start_hour',
  quietEndHour: 'engagement.quiet_end_hour',
  comebackAfterHours: 'engagement.comeback_after_hours',
  comebackRaffs: 'engagement.comeback_raffs',
  comebackCooldownDays: 'engagement.comeback_cooldown_days',
  streakRewards: 'streak.rewards',
  transferMinRaffs: 'transfers.min_raffs',
  transferDailyMaxRaffs: 'transfers.daily_max_raffs',
} as const satisfies Record<keyof EngagementBody, string>

type EngagementValues = Omit<AdminEngagement, 'reminderTexts' | 'outbox'>

async function engagementValues(db: Reader): Promise<EngagementValues> {
  const all = await getAllSettings(db)
  return Object.fromEntries(Object.entries(ENGAGEMENT_KEYS).map(([field, key]) => [field, all[key]])) as unknown as EngagementValues
}

export async function getEngagement(ctx: AppContext): Promise<AdminEngagement> {
  const dayAgo = new Date(ctx.now() - 86_400_000)
  const [o] = await ctx.db
    .select({
      pending: sql<number>`count(*) filter (where ${notifications.status} in ('pending', 'sending'))::int`,
      sent: sql<number>`count(*) filter (where ${notifications.sentAt} >= ${dayAgo})::int`,
      failed: sql<number>`count(*) filter (where ${notifications.status} = 'failed' and ${notifications.createdAt} >= ${dayAgo})::int`,
    })
    .from(notifications)
  const [blocked] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(users).where(isNotNull(users.botBlockedAt))
  return {
    ...(await engagementValues(ctx.db)),
    reminderTexts: REMINDER_TEXTS.map((r) => ({ key: r.key, text: r.text })),
    outbox: { pending: o?.pending ?? 0, sentLast24h: o?.sent ?? 0, failedLast24h: o?.failed ?? 0, blockedPlayers: blocked?.n ?? 0 },
  }
}

export async function putEngagement(ctx: AppContext, adminId: string, body: EngagementBody): Promise<AdminEngagement> {
  const before = await engagementValues(ctx.db)
  await ctx.db.transaction(async (tx) => {
    for (const [field, key] of Object.entries(ENGAGEMENT_KEYS) as [keyof EngagementBody, (typeof ENGAGEMENT_KEYS)[keyof EngagementBody]][]) {
      await putSetting(tx, key, body[field] as never, adminId)
    }
    await appendAudit(tx, { adminId, action: 'settings.engagement', targetType: 'settings', before, after: body })
  })
  return getEngagement(ctx)
}

/** For the overview: messages sent in the last 24 h and still waiting. */
export async function outboxTotals(db: Reader, since: Date): Promise<{ sentLast24h: number; pending: number }> {
  const [o] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${notifications.sentAt} >= ${since})::int`,
      pending: sql<number>`count(*) filter (where ${notifications.status} in ('pending', 'sending'))::int`,
    })
    .from(notifications)
    .where(or(gte(notifications.sentAt, since), inArray(notifications.status, ['pending', 'sending'])))
  return { sentLast24h: o?.sent ?? 0, pending: o?.pending ?? 0 }
}
