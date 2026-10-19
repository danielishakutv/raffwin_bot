/**
 * Admin reads and direct writes. Anything that moves money or changes the
 * rate goes through approvals.ts instead; everything here is audit-logged.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import type { RaffleBody, LimitsBody } from '@raffwin/shared/admin-schemas'
import type {
  AdminAuditRow,
  AdminOverview,
  AdminRaffle,
  AdminSecurityEvent,
  AdminSettings,
  AdminUserDetail,
  AdminUserSummary,
} from '@raffwin/shared/admin-types'
import type { Page } from '@raffwin/shared'
import type { AppContext } from '../context'
import {
  adminUsers,
  approvals,
  auditLog,
  comebackOffers,
  dailyCheckins,
  deliveryPoints,
  entries,
  ledger,
  notifications,
  rafflePrizes,
  raffles,
  referralEarnings,
  securityEvents,
  sessions,
  users,
  type RaffleRow,
  type UserRow,
} from '../db/schema'
import { HttpError } from '../lib/http-error'
import { newDrawSeed } from '../services/draw'
import { stopDrawReminders } from '../services/draw-reminders'
import { currentQuote } from '../services/rates'
import { getAllSettings, putSetting, type SalesSettings } from '../services/settings'
import { appendAudit } from './audit'
import { recordSecurityEvent } from '../lib/security-events'
import { userFeatures } from './features-admin'
import { announceRaffleOpened, cancelBroadcastsFor, outboxTotals, toAdminNotification } from './messages'

/* Raffles -------------------------------------------------------------------- */

async function toAdminRaffles(ctx: AppContext, rows: RaffleRow[]): Promise<AdminRaffle[]> {
  if (rows.length === 0) return []
  const prizes = await ctx.db
    .select({ p: rafflePrizes, winner: users.username, winnerPhone: users.phone })
    .from(rafflePrizes)
    .leftJoin(users, eq(users.id, rafflePrizes.winnerUserId))
    .where(inArray(rafflePrizes.raffleId, rows.map((r) => r.id)))
    .orderBy(asc(rafflePrizes.position))
  // Names of the raffles these were copied from ("Run again")
  const sourceIds = [...new Set(rows.map((r) => r.copiedFromRaffleId).filter((x): x is string => !!x))]
  const sources = new Map(
    sourceIds.length
      ? (await ctx.db.select({ id: raffles.id, prizeName: raffles.prizeName }).from(raffles).where(inArray(raffles.id, sourceIds))).map((s) => [s.id, s.prizeName])
      : [],
  )
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    status: r.status,
    prizeName: r.prizeName,
    model: r.model,
    category: r.category,
    kind: r.kind,
    hue: r.hue,
    imageUrl: r.imageUrl,
    marketPriceNaira: r.marketPriceNaira,
    entryPriceRaffs: r.entryPriceRaffs,
    entriesTarget: r.entriesTarget,
    entriesCount: r.entriesCount,
    raffsCollected: r.entriesCount * r.entryPriceRaffs,
    deadline: r.deadline.toISOString(),
    description: r.description,
    rules: r.rules,
    prizes: prizes
      .filter((x) => x.p.raffleId === r.id)
      .map((x) => ({
        position: x.p.position,
        prizeItem: x.p.prizeItem,
        prizeType: x.p.prizeType,
        raffsValue: x.p.raffsValue,
        costNaira: x.p.costNaira,
        winnerUsername: x.winner,
        // To reach the winner about delivery
        winnerPhone: x.winnerPhone,
        winnerTicket: x.p.winnerTicket,
      })),
    seedCommitment: r.seedCommitment,
    copiedFrom: r.copiedFromRaffleId ? { id: r.copiedFromRaffleId, prizeName: sources.get(r.copiedFromRaffleId) ?? '' } : null,
    openedAt: r.openedAt?.toISOString() ?? null,
    drawnAt: r.drawnAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

export async function listRaffles(ctx: AppContext, status?: string): Promise<AdminRaffle[]> {
  const rows = await ctx.db
    .select()
    .from(raffles)
    .where(status ? eq(raffles.status, status as RaffleRow['status']) : undefined)
    .orderBy(desc(raffles.createdAt))
    .limit(500)
  return toAdminRaffles(ctx, rows)
}

export async function getRaffle(ctx: AppContext, id: string): Promise<AdminRaffle> {
  const [row] = await ctx.db.select().from(raffles).where(eq(raffles.id, id))
  if (!row) throw new HttpError('NOT_FOUND', 'No such raffle.')
  return (await toAdminRaffles(ctx, [row]))[0] as AdminRaffle
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return `${base || 'raffle'}-${randomUUID().slice(0, 6)}`
}

export async function createRaffle(ctx: AppContext, adminId: string | null, body: RaffleBody): Promise<AdminRaffle> {
  const id = await ctx.db.transaction(async (tx) => {
    const { prizes, deadline, ...fields } = body
    const [row] = await tx
      .insert(raffles)
      .values({ ...fields, deadline: new Date(deadline), slug: slugify(body.prizeName), createdByAdminId: adminId })
      .returning()
    if (!row) throw new Error('raffle insert returned no row')
    await tx.insert(rafflePrizes).values(prizes.map((p) => ({ ...p, raffleId: row.id })))
    await appendAudit(tx, { adminId, action: 'raffle.create', targetType: 'raffle', targetId: row.id, after: body })
    return row.id
  })
  return getRaffle(ctx, id)
}

/**
 * "Run again": a new draft with everything players see copied from another
 * raffle (any status), its prizes without winners, no entries, a fresh seed at
 * publishing, and a deadline as far ahead as the original ran (1 to 30 days,
 * on the hour). The original is not touched. Edit the draft, then publish it.
 */
export async function copyRaffle(ctx: AppContext, adminId: string | null, sourceId: string): Promise<AdminRaffle> {
  const id = await ctx.db.transaction(async (tx) => {
    const [src] = await tx.select().from(raffles).where(eq(raffles.id, sourceId))
    if (!src) throw new HttpError('NOT_FOUND', 'No such raffle.')
    const prizes = await tx.select().from(rafflePrizes).where(eq(rafflePrizes.raffleId, sourceId)).orderBy(asc(rafflePrizes.position))
    const ran = src.deadline.getTime() - (src.openedAt ?? src.createdAt).getTime()
    const span = Math.min(30 * 86_400_000, Math.max(86_400_000, ran))
    const deadline = new Date(Math.ceil((ctx.now() + span) / 3_600_000) * 3_600_000)
    const [row] = await tx
      .insert(raffles)
      .values({
        slug: slugify(src.prizeName),
        prizeName: src.prizeName,
        model: src.model,
        category: src.category,
        kind: src.kind,
        hue: src.hue,
        imageUrl: src.imageUrl,
        marketPriceNaira: src.marketPriceNaira,
        entryPriceRaffs: src.entryPriceRaffs,
        entriesTarget: src.entriesTarget,
        deadline,
        description: src.description,
        rules: src.rules,
        createdByAdminId: adminId,
        copiedFromRaffleId: src.id,
      })
      .returning({ id: raffles.id })
    if (!row) throw new Error('raffle insert returned no row')
    if (prizes.length) {
      await tx.insert(rafflePrizes).values(
        prizes.map((p) => ({ raffleId: row.id, position: p.position, prizeItem: p.prizeItem, prizeType: p.prizeType, raffsValue: p.raffsValue, costNaira: p.costNaira })),
      )
    }
    await appendAudit(tx, { adminId, action: 'raffle.copy', targetType: 'raffle', targetId: row.id, after: { copiedFrom: src.id, sourceStatus: src.status, deadline } })
    return row.id
  })
  return getRaffle(ctx, id)
}

/**
 * Drafts: anyone with raffles.write. Open raffles: super admins only, and the
 * stock can never drop below what is already sold, nor the deadline into the
 * past. Drawn and cancelled raffles are history and cannot change.
 */
export async function updateRaffle(
  ctx: AppContext,
  adminId: string,
  id: string,
  body: RaffleBody,
  superAdmin = false,
): Promise<AdminRaffle> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(raffles).where(eq(raffles.id, id)).for('update')
    if (!row) throw new HttpError('NOT_FOUND', 'No such raffle.')
    if (row.status === 'open') {
      if (!superAdmin) throw new HttpError('FORBIDDEN', 'Only a super admin can change a raffle that is open for entries.')
      // Past its deadline the draw owns it (services/draw.ts runs within seconds)
      if (row.deadline.getTime() <= ctx.now()) {
        throw new HttpError('INVALID_INPUT', 'Entries for this raffle have closed and the draw is running. It can no longer be changed.')
      }
      if (body.entriesTarget < row.entriesCount) {
        throw new HttpError('INVALID_INPUT', `${row.entriesCount} entries are already sold; the total cannot be lower.`, {
          entriesTarget: `At least ${row.entriesCount}`,
        })
      }
      if (new Date(body.deadline).getTime() <= ctx.now()) {
        throw new HttpError('INVALID_INPUT', 'An open raffle needs a deadline in the future.', { deadline: 'In the past' })
      }
    } else if (row.status !== 'draft') {
      throw new HttpError('INVALID_INPUT', `This raffle is ${row.status}; it can no longer be changed.`)
    }
    const before = await getRaffle(ctx, id)
    // Players who already entered were promised these places: an open raffle can gain prizes, never lose them
    if (row.status === 'open' && row.entriesCount > 0 && body.prizes.length < before.prizes.length) {
      throw new HttpError('INVALID_INPUT', `${row.entriesCount} entries are already sold with ${before.prizes.length} prizes on offer; prizes can be added or edited, not removed.`, {
        prizes: `At least ${before.prizes.length}`,
      })
    }
    const { prizes, deadline, ...fields } = body
    await tx
      .update(raffles)
      .set({ ...fields, deadline: new Date(deadline), updatedAt: sql`now()` })
      .where(eq(raffles.id, id))
    for (const p of prizes) {
      await tx
        .insert(rafflePrizes)
        .values({ ...p, raffleId: id })
        .onConflictDoUpdate({
          target: [rafflePrizes.raffleId, rafflePrizes.position],
          set: { prizeItem: p.prizeItem, prizeType: p.prizeType, raffsValue: p.raffsValue, costNaira: p.costNaira },
        })
    }
    // Places taken off the end (drafts, or open raffles nobody has entered yet). The audit row keeps them in `before`.
    await tx.delete(rafflePrizes).where(and(eq(rafflePrizes.raffleId, id), gt(rafflePrizes.position, prizes.length)))
    await appendAudit(tx, { adminId, action: 'raffle.update', targetType: 'raffle', targetId: id, before, after: body })
  })
  return getRaffle(ctx, id)
}

/** Open -> draft (hidden from players). Refused once anyone has entered: cancel it instead, which refunds them. */
export async function unpublishRaffle(ctx: AppContext, adminId: string, id: string, reason: string): Promise<AdminRaffle> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(raffles).where(eq(raffles.id, id)).for('update')
    if (!row) throw new HttpError('NOT_FOUND', 'No such raffle.')
    if (row.status !== 'open') throw new HttpError('INVALID_INPUT', `Only an open raffle can be unpublished; this one is ${row.status}.`)
    if (row.entriesCount > 0) {
      throw new HttpError(
        'INVALID_INPUT',
        `${row.entriesCount} entr${row.entriesCount === 1 ? 'y is' : 'ies are'} already sold. Cancel the raffle instead: that refunds everyone.`,
      )
    }
    await tx.update(raffles).set({ status: 'draft', updatedAt: sql`now()` }).where(eq(raffles.id, id))
    // Players are not alerted about a raffle they can no longer see
    const alertsStopped = await cancelBroadcastsFor(tx, { type: 'raffle', id }, ['raffle_new'], new Date(ctx.now()))
    await stopDrawReminders(tx, id, new Date(ctx.now()))
    await appendAudit(tx, { adminId, action: 'raffle.unpublish', targetType: 'raffle', targetId: id, before: { status: 'open' }, after: { status: 'draft', reason, alertsStopped } })
  })
  return getRaffle(ctx, id)
}

export async function openRaffle(ctx: AppContext, adminId: string | null, id: string): Promise<AdminRaffle> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(raffles).where(eq(raffles.id, id)).for('update')
    if (!row) throw new HttpError('NOT_FOUND', 'No such raffle.')
    if (row.status !== 'draft') throw new HttpError('INVALID_INPUT', `This raffle is already ${row.status}.`)
    if (row.deadline.getTime() < ctx.now() + 3_600_000) {
      throw new HttpError('INVALID_INPUT', 'The deadline must be at least an hour away to open a raffle.')
    }
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(rafflePrizes).where(eq(rafflePrizes.raffleId, id))
    if ((count?.n ?? 0) < 1) throw new HttpError('INVALID_INPUT', 'Add at least one prize before publishing.')
    // The draw seed is fixed now and its SHA-256 published, so the result cannot be steered later
    const { seed, commitment } = newDrawSeed()
    await tx
      .update(raffles)
      .set({ status: 'open', openedAt: sql`now()`, drawSeed: seed, seedCommitment: commitment, updatedAt: sql`now()` })
      .where(eq(raffles.id, id))
    // The bot tells everyone with new raffle alerts on (queued; sent by the workers)
    const broadcastId = await announceRaffleOpened(tx, row, count?.n ?? 1, adminId)
    await appendAudit(tx, { adminId, action: 'raffle.open', targetType: 'raffle', targetId: id, after: { broadcastId, commitment } })
  })
  return getRaffle(ctx, id)
}

/* Users ---------------------------------------------------------------------- */

const referrerName = sql<string | null>`(select r.username from ${users} r where r.id = "users"."referred_by_user_id")`

function toSummary(u: UserRow, referredByUsername: string | null): AdminUserSummary {
  return {
    id: u.id,
    telegramId: u.telegramId,
    username: u.username,
    fullName: u.fullName,
    phone: u.phone,
    email: u.email,
    status: u.status,
    balance: u.balanceCache,
    signedUpAt: u.signedUpAt?.toISOString() ?? null,
    lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
    referredByUsername,
    phoneVerified: u.phone !== null && u.phoneVerifiedAt !== null,
    botBlocked: u.botBlockedAt !== null,
  }
}

export const USER_FILTERS = ['no_phone', 'with_phone', 'blocked', 'inactive'] as const
export type UserFilter = (typeof USER_FILTERS)[number]
/** "Inactive" in the players list: not opened the app for this long */
const INACTIVE_DAYS = 2

function userFilterSql(ctx: AppContext, filter: UserFilter | undefined): SQL | undefined {
  switch (filter) {
    case 'no_phone':
      return isNull(users.phone)
    case 'with_phone':
      return isNotNull(users.phone)
    case 'blocked':
      return isNotNull(users.botBlockedAt)
    case 'inactive':
      return lt(sql`coalesce(${users.lastSeenAt}, ${users.createdAt})`, new Date(ctx.now() - INACTIVE_DAYS * 86_400_000))
    default:
      return undefined
  }
}

/**
 * Search by username, name, email or phone (contains), or an exact Telegram
 * id; optionally only players without a phone, with one, who blocked the bot,
 * or inactive for 2+ days.
 */
export async function searchUsers(ctx: AppContext, q: string, filter?: UserFilter): Promise<AdminUserSummary[]> {
  const term = q.trim()
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  const where = !term
    ? undefined
    : or(
        ilike(users.username, like),
        ilike(users.fullName, like),
        ilike(users.email, like),
        ilike(users.phone, like),
        /^\d{5,15}$/.test(term) ? eq(users.telegramId, Number(term)) : undefined,
      )
  const rows = await ctx.db
    .select({ u: users, referredBy: referrerName })
    .from(users)
    .where(and(where, userFilterSql(ctx, filter)))
    .orderBy(desc(users.createdAt))
    .limit(100)
  return rows.map((r) => toSummary(r.u, r.referredBy))
}

export async function userDetail(ctx: AppContext, id: string): Promise<AdminUserDetail> {
  const [row] = await ctx.db.select({ u: users, referredBy: referrerName }).from(users).where(eq(users.id, id))
  if (!row) throw new HttpError('NOT_FOUND', 'No such user.')
  const [sum] = await ctx.db.select({ n: sql<number>`coalesce(sum(${ledger.raffs}), 0)::int` }).from(ledger).where(eq(ledger.userId, id))
  const ledgerRows = await ctx.db.select().from(ledger).where(eq(ledger.userId, id)).orderBy(desc(ledger.createdAt)).limit(100)
  const entryRows = await ctx.db
    .select({ e: entries, raffleName: raffles.prizeName })
    .from(entries)
    .innerJoin(raffles, eq(raffles.id, entries.raffleId))
    .where(eq(entries.userId, id))
    .orderBy(desc(entries.createdAt))
    .limit(100)
  const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.userId, id)).orderBy(desc(sessions.createdAt)).limit(20)
  const [ref] = await ctx.db
    .select({
      people: sql<number>`(select count(*)::int from ${users} p where p.referred_by_user_id = ${id} and p.signed_up_at is not null)`,
      earned: sql<number>`coalesce(sum(${referralEarnings.raffs}) filter (where ${referralEarnings.reversedAt} is null), 0)::int`,
    })
    .from(referralEarnings)
    .where(eq(referralEarnings.referrerUserId, id))
  const u = row.u
  const [streak] = await ctx.db
    .select({
      best: sql<number>`coalesce(max(${dailyCheckins.streak}), 0)::int`,
      lastDay: sql<string | null>`max(${dailyCheckins.day})::text`,
      lastStreak: sql<number | null>`(select c.streak from ${dailyCheckins} c where c.user_id = ${id} order by c.day desc limit 1)`,
    })
    .from(dailyCheckins)
    .where(eq(dailyCheckins.userId, id))
  const offers = await ctx.db
    .select()
    .from(comebackOffers)
    .where(eq(comebackOffers.userId, id))
    .orderBy(desc(comebackOffers.offeredAt))
    .limit(10)
  const messages = await ctx.db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, id))
    .orderBy(desc(notifications.createdAt))
    .limit(30)
  const [delivery] = await ctx.db.select().from(deliveryPoints).where(eq(deliveryPoints.userId, id))
  // The streak is current while its last claim was today or yesterday (Lagos days)
  const today = lagosDay(ctx.now())
  const yesterday = lagosDay(ctx.now() - 86_400_000)
  const lastDay = streak?.lastDay ?? null
  const current = lastDay === today || lastDay === yesterday ? (streak?.lastStreak ?? 0) : 0
  return {
    user: { ...toSummary(u, row.referredBy), referralCode: u.referralCode, tgUsername: u.tgUsername, createdAt: u.createdAt.toISOString() },
    ledgerBalance: sum?.n ?? 0,
    ledger: ledgerRows.map((l) => ({
      id: l.id,
      type: l.type,
      raffs: l.raffs,
      stars: l.stars,
      balanceAfter: l.balanceAfter,
      note: l.note,
      createdAt: l.createdAt.toISOString(),
    })),
    entries: entryRows.map(({ e, raffleName }) => ({
      id: e.id,
      raffleName,
      qty: e.qty,
      raffsSpent: e.raffsSpent,
      ticketFrom: e.ticketFrom,
      ticketTo: e.ticketTo,
      createdAt: e.createdAt.toISOString(),
    })),
    sessions: sessionRows.map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      revokedAt: s.revokedAt?.toISOString() ?? null,
      revokedReason: s.revokedReason,
    })),
    referrals: { people: ref?.people ?? 0, raffsEarned: ref?.earned ?? 0 },
    engagement: {
      remindersOn: u.remindersOptOutAt === null,
      nextReminderAt: u.nextReminderAt?.toISOString() ?? null,
      remindersSinceLastOpen: u.remindersSinceOpen,
      lastReminderAt: u.lastReminderAt?.toISOString() ?? null,
      botBlockedAt: u.botBlockedAt?.toISOString() ?? null,
      streak: { current, best: streak?.best ?? 0, lastClaimedDay: lastDay },
      comebackOffers: offers.map((o) => ({
        offeredAt: o.offeredAt.toISOString(),
        expiresAt: o.expiresAt.toISOString(),
        claimedAt: o.claimedAt?.toISOString() ?? null,
        raffs: o.raffs,
      })),
    },
    features: await userFeatures(ctx.db, id),
    notifications: messages.map((n) => toAdminNotification(n, u.username)),
    delivery: delivery ? { state: delivery.state, city: delivery.city, motorPark: delivery.motorPark } : null,
  }
}

/** YYYY-MM-DD of the Lagos calendar day (UTC+1, no daylight saving) containing `ms` */
function lagosDay(ms: number): string {
  return new Date(ms + 3_600_000).toISOString().slice(0, 10)
}

/**
 * Attaches a referrer to an account that has none, chosen by username or
 * Telegram id. The referrer earns 10% on this account's entries from now on;
 * earlier entries are not paid back-dated. An existing bond is never replaced
 * (nobody can take someone else's referrals), an account cannot refer itself,
 * and two accounts cannot refer each other. Audited and flagged for review.
 */
export async function assignReferrer(
  ctx: AppContext,
  adminId: string,
  userId: string,
  body: { referrer: string; reason: string },
): Promise<AdminUserDetail> {
  const handle = body.referrer.trim().replace(/^@/, '').toLowerCase()
  const byTelegramId = /^[0-9]{5,15}$/.test(handle)
  await ctx.db.transaction(async (tx) => {
    const [target] = await tx.select().from(users).where(eq(users.id, userId)).for('update')
    if (!target) throw new HttpError('NOT_FOUND', 'No such player.')
    if (target.referredByUserId) {
      throw new HttpError('INVALID_INPUT', 'This player already has a referrer; it cannot be changed.', { referrer: 'Already set' })
    }
    const [referrer] = await tx
      .select()
      .from(users)
      .where(byTelegramId ? eq(users.telegramId, Number(handle)) : eq(users.username, handle))
    if (!referrer) throw new HttpError('INVALID_INPUT', `No player ${byTelegramId ? 'with Telegram id' : 'called @'}${handle}.`, { referrer: 'Not found' })
    if (referrer.id === target.id) throw new HttpError('INVALID_INPUT', 'A player cannot refer themselves.', { referrer: 'Same player' })
    if (referrer.referredByUserId === target.id) {
      throw new HttpError('INVALID_INPUT', `@${referrer.username} was referred by this player; two players cannot refer each other.`, { referrer: 'Would loop' })
    }
    if (referrer.status !== 'active') throw new HttpError('INVALID_INPUT', `@${referrer.username} is ${referrer.status}.`, { referrer: 'Not active' })
    await tx
      .update(users)
      .set({ referredByUserId: referrer.id, referredAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(users.id, target.id), sql`${users.referredByUserId} is null`))
    await appendAudit(tx, {
      adminId,
      action: 'user.referrer.assign',
      targetType: 'user',
      targetId: target.id,
      before: { referredByUserId: null },
      after: { referredByUserId: referrer.id, referrerUsername: referrer.username, reason: body.reason },
    })
  })
  await recordSecurityEvent(ctx.db, ctx.log, {
    severity: 'medium',
    category: 'fraud',
    kind: 'referrer_assigned_by_admin',
    ipHash: null,
    route: 'POST /admin/v1/users/:id/referrer',
    userId,
    details: { adminId, referrer: handle, reason: body.reason },
  })
  return userDetail(ctx, userId)
}

/** Suspending also ends every session, so the player is out immediately. */
export async function setUserStatus(
  ctx: AppContext,
  adminId: string,
  userId: string,
  status: 'active' | 'suspended',
  reason: string,
): Promise<AdminUserDetail> {
  await ctx.db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for('update')
    if (!u) throw new HttpError('NOT_FOUND', 'No such user.')
    await tx.update(users).set({ status, updatedAt: sql`now()` }).where(eq(users.id, userId))
    if (status === 'suspended') {
      await tx
        .update(sessions)
        .set({ revokedAt: sql`now()`, revokedReason: 'suspended' })
        .where(and(eq(sessions.userId, userId), sql`${sessions.revokedAt} is null`))
    }
    await appendAudit(tx, {
      adminId,
      action: status === 'suspended' ? 'user.suspend' : 'user.reinstate',
      targetType: 'user',
      targetId: userId,
      before: { status: u.status },
      after: { status, reason },
    })
  })
  return userDetail(ctx, userId)
}

/* Settings ------------------------------------------------------------------- */

export async function getSettingsView(ctx: AppContext): Promise<AdminSettings> {
  const all = await getAllSettings(ctx.db)
  return {
    rate: {
      nairaPerRaff: (all['rate.base_naira_per_raff_kobo'] as number) / 100,
      moveMinPct: all['rate.move_min_pct'] as number,
      moveMaxPct: all['rate.move_max_pct'] as number,
    },
    sales: {
      packages: all['sales.packages'] as SalesSettings['packages'],
      minNaira: all['sales.min_naira'] as number,
      maxNaira: all['sales.max_naira'] as number,
    },
    maxEntriesPerUserPerRaffle: all['limits.max_entries_per_user_per_raffle'] as number | null,
    dailySpendRaffs: all['limits.daily_spend_raffs'] as number | null,
  }
}

export async function putLimits(ctx: AppContext, adminId: string, body: LimitsBody): Promise<AdminSettings> {
  const before = await getSettingsView(ctx)
  await ctx.db.transaction(async (tx) => {
    await putSetting(tx, 'limits.max_entries_per_user_per_raffle', body.maxEntriesPerUserPerRaffle, adminId)
    await putSetting(tx, 'limits.daily_spend_raffs', body.dailySpendRaffs, adminId)
    await appendAudit(tx, { adminId, action: 'settings.limits', targetType: 'settings', before, after: body })
  })
  return getSettingsView(ctx)
}

/* Overview ------------------------------------------------------------------- */

export async function overview(ctx: AppContext): Promise<AdminOverview> {
  const now = ctx.now()
  const dayStart = new Date(Math.floor((now + 3_600_000) / 86_400_000) * 86_400_000 - 3_600_000) // Lagos midnight
  const [u] = await ctx.db
    .select({
      total: sql<number>`count(*)::int`,
      signedUp: sql<number>`count(${users.signedUpAt})::int`,
      today: sql<number>`count(*) filter (where ${users.signedUpAt} >= ${dayStart})::int`,
      active7: sql<number>`count(*) filter (where ${users.lastSeenAt} >= ${new Date(now - 7 * 86_400_000)})::int`,
      outstanding: sql<number>`coalesce(sum(${users.balanceCache}), 0)::int`,
      withPhone: sql<number>`count(${users.phone})::int`,
      blocked: sql<number>`count(${users.botBlockedAt})::int`,
      reachable: sql<number>`count(*) filter (where ${users.botBlockedAt} is null and ${users.status} = 'active')::int`,
    })
    .from(users)
  const [ledgerSum] = await ctx.db.select({ n: sql<number>`coalesce(sum(${ledger.raffs}), 0)::int` }).from(ledger)
  const [e] = await ctx.db
    .select({ n: sql<number>`count(*)::int`, raffs: sql<number>`coalesce(sum(${entries.raffsSpent}), 0)::int` })
    .from(entries)
    .where(gte(entries.createdAt, dayStart))
  const [r] = await ctx.db
    .select({
      open: sql<number>`count(*) filter (where ${raffles.status} = 'open')::int`,
      drafts: sql<number>`count(*) filter (where ${raffles.status} = 'draft')::int`,
    })
    .from(raffles)
  const [p] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(approvals).where(eq(approvals.status, 'pending'))
  const sev = await ctx.db
    .select({ severity: securityEvents.severity, n: sql<number>`count(*)::int` })
    .from(securityEvents)
    .where(gte(securityEvents.occurredAt, new Date(now - 86_400_000)))
    .groupBy(securityEvents.severity)
  const [raisedRow] = await ctx.db
    .select({
      spent: sql<number>`coalesce((select sum(raffs_spent) from ${entries}), 0)::int`,
      refunded: sql<number>`coalesce((select sum(raffs) from ${ledger} where type = 'refund'), 0)::int`,
    })
    .from(sql`(select 1) as one`)
  const settingsNow = await getSettingsView(ctx)
  const nairaPerRaff = settingsNow.rate.nairaPerRaff
  const raisedRaffs = (raisedRow?.spent ?? 0) - (raisedRow?.refunded ?? 0)
  const quote = await currentQuote(ctx.db, now)
  const outbox = await outboxTotals(ctx.db, new Date(now - 86_400_000))
  const securityLast24h = { low: 0, medium: 0, high: 0, critical: 0 }
  for (const s of sev) securityLast24h[s.severity] = s.n
  return {
    users: { total: u?.total ?? 0, signedUp: u?.signedUp ?? 0, signedUpToday: u?.today ?? 0, activeLast7Days: u?.active7 ?? 0 },
    raised: { raffs: raisedRaffs, naira: Math.round(raisedRaffs * nairaPerRaff), nairaPerRaff },
    entries: { today: e?.n ?? 0, raffsToday: e?.raffs ?? 0 },
    raffles: { open: r?.open ?? 0, drafts: r?.drafts ?? 0 },
    raffsOutstanding: u?.outstanding ?? 0,
    ledgerConsistent: (u?.outstanding ?? 0) === (ledgerSum?.n ?? 0),
    pendingApprovals: p?.n ?? 0,
    securityLast24h,
    rate: {
      nairaPerRaff: quote.nairaPerRaffKobo / 100,
      // Quotes from before the naira base have none; the setting is the base they will move from next
      baseNairaPerRaff: (quote.baseNairaPerRaffKobo ?? settingsNow.rate.nairaPerRaff * 100) / 100,
      movePct: Math.round(quote.moveMicro / 100) / 100,
      expiresAt: quote.expiresAt.toISOString(),
    },
    phones: { withPhone: u?.withPhone ?? 0, withoutPhone: (u?.total ?? 0) - (u?.withPhone ?? 0) },
    bot: { reachable: u?.reachable ?? 0, blocked: u?.blocked ?? 0, sentLast24h: outbox.sentLast24h, pending: outbox.pending },
  }
}

/* Security events and audit log (cursor pages) -------------------------------- */

export async function listSecurityEvents(
  ctx: AppContext,
  q: { cursor?: string; limit: number; severity?: string; category?: string },
): Promise<Page<AdminSecurityEvent>> {
  // Cursor "<iso ms>|<id>". occurred_at has microseconds, so compare and order
  // at millisecond precision with the id as tie-break, or rows would be skipped
  const [iso, id] = (q.cursor ?? '').split('|')
  const before = q.cursor ? { at: new Date(iso ?? ''), id: id ?? '' } : null
  if (before && (Number.isNaN(before.at.getTime()) || !/^[0-9a-f-]{36}$/.test(before.id))) {
    throw new HttpError('INVALID_INPUT', 'Malformed cursor.')
  }
  const at = sql`date_trunc('milliseconds', ${securityEvents.occurredAt})`
  const rows = await ctx.db
    .select()
    .from(securityEvents)
    .where(
      and(
        before ? sql`(${at}, ${securityEvents.id}) < (${before.at.toISOString()}::timestamptz, ${before.id}::uuid)` : undefined,
        q.severity ? eq(securityEvents.severity, q.severity as 'low') : undefined,
        q.category ? eq(securityEvents.category, q.category as 'auth') : undefined,
      ),
    )
    .orderBy(desc(at), desc(securityEvents.id))
    .limit(q.limit + 1)
  const page = rows.slice(0, q.limit)
  const last = page[page.length - 1]
  return {
    items: page.map((s) => ({
      id: s.id,
      occurredAt: s.occurredAt.toISOString(),
      severity: s.severity,
      category: s.category,
      kind: s.kind,
      ipHash: s.ipHash,
      userId: s.userId,
      route: s.route,
      requestId: s.requestId,
      details: s.details,
      actionTaken: s.actionTaken,
    })),
    nextCursor: rows.length > q.limit && last ? `${last.occurredAt.toISOString()}|${last.id}` : null,
  }
}

export async function listAudit(ctx: AppContext, q: { cursor?: string; limit: number }): Promise<Page<AdminAuditRow>> {
  const before = q.cursor ? Number(q.cursor) : null
  if (before !== null && !Number.isSafeInteger(before)) throw new HttpError('INVALID_INPUT', 'Malformed cursor.')
  const rows = await ctx.db
    .select({ a: auditLog, admin: adminUsers.name })
    .from(auditLog)
    .leftJoin(adminUsers, eq(adminUsers.id, auditLog.adminId))
    .where(before !== null ? lt(auditLog.seq, before) : undefined)
    .orderBy(desc(auditLog.seq))
    .limit(q.limit + 1)
  const page = rows.slice(0, q.limit)
  const last = page[page.length - 1]
  return {
    items: page.map(({ a, admin }) => ({
      seq: a.seq,
      createdAt: a.createdAt.toISOString(),
      admin,
      action: a.action,
      targetType: a.targetType,
      targetId: a.targetId,
      before: a.before,
      after: a.after,
    })),
    nextCursor: rows.length > q.limit && last ? String(last.a.seq) : null,
  }
}
