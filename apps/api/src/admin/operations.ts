/**
 * Admin reads and direct writes. Anything that moves money or changes the
 * rate goes through approvals.ts instead; everything here is audit-logged.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm'
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
  entries,
  ledger,
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
import { currentQuote } from '../services/rates'
import { getAllSettings, putSetting } from '../services/settings'
import { appendAudit } from './audit'

/* Raffles -------------------------------------------------------------------- */

async function toAdminRaffles(ctx: AppContext, rows: RaffleRow[]): Promise<AdminRaffle[]> {
  if (rows.length === 0) return []
  const prizes = await ctx.db
    .select({ p: rafflePrizes, winner: users.username })
    .from(rafflePrizes)
    .leftJoin(users, eq(users.id, rafflePrizes.winnerUserId))
    .where(inArray(rafflePrizes.raffleId, rows.map((r) => r.id)))
    .orderBy(asc(rafflePrizes.position))
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    status: r.status,
    prizeName: r.prizeName,
    model: r.model,
    category: r.category,
    kind: r.kind,
    hue: r.hue,
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
        position: x.p.position as 1 | 2 | 3,
        prizeItem: x.p.prizeItem,
        prizeType: x.p.prizeType,
        raffsValue: x.p.raffsValue,
        winnerUsername: x.winner,
        winnerTicket: x.p.winnerTicket,
      })),
    seedCommitment: r.seedCommitment,
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

export async function createRaffle(ctx: AppContext, adminId: string, body: RaffleBody): Promise<AdminRaffle> {
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

/** Drafts only: once a raffle opens, its price, size and prizes are fixed. */
export async function updateRaffle(ctx: AppContext, adminId: string, id: string, body: RaffleBody): Promise<AdminRaffle> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(raffles).where(eq(raffles.id, id)).for('update')
    if (!row) throw new HttpError('NOT_FOUND', 'No such raffle.')
    if (row.status !== 'draft') throw new HttpError('INVALID_INPUT', 'Only drafts can be edited. An open raffle can only be cancelled.')
    const before = await getRaffle(ctx, id)
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
          set: { prizeItem: p.prizeItem, prizeType: p.prizeType, raffsValue: p.raffsValue },
        })
    }
    await appendAudit(tx, { adminId, action: 'raffle.update', targetType: 'raffle', targetId: id, before, after: body })
  })
  return getRaffle(ctx, id)
}

export async function openRaffle(ctx: AppContext, adminId: string, id: string): Promise<AdminRaffle> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(raffles).where(eq(raffles.id, id)).for('update')
    if (!row) throw new HttpError('NOT_FOUND', 'No such raffle.')
    if (row.status !== 'draft') throw new HttpError('INVALID_INPUT', `This raffle is already ${row.status}.`)
    if (row.deadline.getTime() < ctx.now() + 3_600_000) {
      throw new HttpError('INVALID_INPUT', 'The deadline must be at least an hour away to open a raffle.')
    }
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(rafflePrizes).where(eq(rafflePrizes.raffleId, id))
    if ((count?.n ?? 0) !== 3) throw new HttpError('INVALID_INPUT', 'A raffle needs its three prizes before it opens.')
    await tx.update(raffles).set({ status: 'open', openedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(raffles.id, id))
    await appendAudit(tx, { adminId, action: 'raffle.open', targetType: 'raffle', targetId: id })
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
  }
}

/** Search by username, name, email or phone (contains), or an exact Telegram id. */
export async function searchUsers(ctx: AppContext, q: string): Promise<AdminUserSummary[]> {
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
    .where(where)
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
  }
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
    baseStarsPerRaff: (all['rate.base_stars_per_raff_micro'] as number) / 1e6,
    nairaPerStar: all['rate.naira_per_star'] as number,
    maxEntriesPerUserPerRaffle: all['limits.max_entries_per_user_per_raffle'] as number | null,
    dailySpendRaffs: all['limits.daily_spend_raffs'] as number | null,
  }
}

export async function putLimits(ctx: AppContext, adminId: string, body: LimitsBody): Promise<AdminSettings> {
  const before = await getSettingsView(ctx)
  await ctx.db.transaction(async (tx) => {
    await putSetting(tx, 'limits.max_entries_per_user_per_raffle', body.maxEntriesPerUserPerRaffle, adminId)
    await putSetting(tx, 'limits.daily_spend_raffs', body.dailySpendRaffs, adminId)
    await putSetting(tx, 'rate.naira_per_star', body.nairaPerStar, adminId)
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
      outstanding: sql<number>`coalesce(sum(${users.balanceCache}), 0)::int`,
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
  const quote = await currentQuote(ctx.db, now)
  const securityLast24h = { low: 0, medium: 0, high: 0, critical: 0 }
  for (const s of sev) securityLast24h[s.severity] = s.n
  return {
    users: { total: u?.total ?? 0, signedUp: u?.signedUp ?? 0, signedUpToday: u?.today ?? 0 },
    entries: { today: e?.n ?? 0, raffsToday: e?.raffs ?? 0 },
    raffles: { open: r?.open ?? 0, drafts: r?.drafts ?? 0 },
    raffsOutstanding: u?.outstanding ?? 0,
    ledgerConsistent: (u?.outstanding ?? 0) === (ledgerSum?.n ?? 0),
    pendingApprovals: p?.n ?? 0,
    securityLast24h,
    rate: {
      starsPerRaff: quote.starsPerRaffMicro / 1e6,
      baseStarsPerRaff: quote.baseStarsPerRaffMicro / 1e6,
      movePct: Math.round(quote.moveMicro / 100) / 100,
      expiresAt: quote.expiresAt.toISOString(),
    },
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
