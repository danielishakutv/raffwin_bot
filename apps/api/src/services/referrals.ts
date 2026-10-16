/**
 * The referral tracker (docs/ARCHITECTURE.md section 7): totals, the people
 * you referred, and a per-entry statement of your 10%.
 * Lists are cursor-paginated on (created_at, id), newest first.
 */
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
// people(): signed_up_at is written from a JS Date, so it already has millisecond precision
import { referralLink, type Page, type ReferralEarning, type ReferralSummary, type ReferredPerson } from '@raffwin/shared'
import type { AppContext } from '../context'
import { entries, raffles, referralEarnings, users, type UserRow } from '../db/schema'
import { HttpError } from '../lib/http-error'

const monthStartLagos = sql`(date_trunc('month', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos')`

function requireSignedUp(user: UserRow) {
  if (!user.signedUpAt) throw new HttpError('NOT_SIGNED_IN', 'Create your account first.')
}

export async function summary(ctx: AppContext, user: UserRow): Promise<ReferralSummary> {
  requireSignedUp(user)
  const [people] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.referredByUserId, user.id), isNotNull(users.signedUpAt)))
  const [earned] = await ctx.db
    .select({
      lifetime: sql<number>`coalesce(sum(${referralEarnings.raffs}) filter (where ${referralEarnings.reversedAt} is null), 0)::int`,
      month: sql<number>`coalesce(sum(${referralEarnings.raffs}) filter (where ${referralEarnings.reversedAt} is null and ${referralEarnings.createdAt} >= ${monthStartLagos}), 0)::int`,
      active: sql<number>`count(distinct ${referralEarnings.referredUserId}) filter (where ${referralEarnings.createdAt} >= ${monthStartLagos})::int`,
    })
    .from(referralEarnings)
    .where(eq(referralEarnings.referrerUserId, user.id))
  return {
    code: user.referralCode,
    link: referralLink(ctx.config.BOT_USERNAME, user.referralCode),
    peopleReferred: people?.n ?? 0,
    activeThisMonth: earned?.active ?? 0,
    lifetimeRaffs: earned?.lifetime ?? 0,
    monthRaffs: earned?.month ?? 0,
  }
}

/** Cursor = "<iso time>|<id>" of the last item on the previous page. */
function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null
  const [iso, id] = cursor.split('|')
  const at = new Date(iso ?? '')
  if (!id || Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new HttpError('INVALID_INPUT', 'That page link is not valid.', { cursor: 'Malformed cursor' })
  }
  return { at, id }
}

function encodeCursor(at: Date, id: string): string {
  return `${at.toISOString()}|${id}`
}

export async function people(
  ctx: AppContext,
  user: UserRow,
  q: { cursor?: string; limit: number },
): Promise<Page<ReferredPerson>> {
  requireSignedUp(user)
  const after = decodeCursor(q.cursor)
  const rows = await ctx.db
    .select({
      id: users.id,
      username: users.username,
      joinedAt: users.signedUpAt,
      // Correlated subqueries name "users"."id" explicitly: an interpolated column
      // may render unqualified and bind to the subquery's own id column instead
      entries: sql<number>`(select count(*)::int from ${entries} e where e.user_id = "users"."id")`,
      earned: sql<number>`(select coalesce(sum(r.raffs), 0)::int from ${referralEarnings} r
                           where r.referred_user_id = "users"."id" and r.referrer_user_id = ${user.id} and r.reversed_at is null)`,
    })
    .from(users)
    .where(
      and(
        eq(users.referredByUserId, user.id),
        isNotNull(users.signedUpAt),
        after
          ? or(lt(users.signedUpAt, after.at), and(eq(users.signedUpAt, after.at), lt(users.id, after.id)))
          : undefined,
      ),
    )
    .orderBy(desc(users.signedUpAt), desc(users.id))
    .limit(q.limit + 1)
  const page = rows.slice(0, q.limit)
  const last = page[page.length - 1]
  return {
    items: page.map((r) => ({
      username: r.username ?? '',
      joinedAt: (r.joinedAt as Date).toISOString(),
      entries: r.entries,
      raffsEarned: r.earned,
    })),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.joinedAt as Date, last.id) : null,
  }
}

export async function earnings(
  ctx: AppContext,
  user: UserRow,
  q: { cursor?: string; limit: number },
): Promise<Page<ReferralEarning>> {
  requireSignedUp(user)
  const after = decodeCursor(q.cursor)
  // created_at has microseconds, the cursor milliseconds: compare and order at ms
  // precision, or the last row of a page would reappear at the top of the next
  const at = sql`date_trunc('milliseconds', ${referralEarnings.createdAt})`
  const rows = await ctx.db
    .select({
      id: referralEarnings.id,
      createdAt: referralEarnings.createdAt,
      raffs: referralEarnings.raffs,
      username: users.username,
      raffleName: raffles.prizeName,
      entryRaffs: entries.raffsSpent,
    })
    .from(referralEarnings)
    .innerJoin(users, eq(users.id, referralEarnings.referredUserId))
    .innerJoin(entries, eq(entries.id, referralEarnings.entryId))
    .innerJoin(raffles, eq(raffles.id, entries.raffleId))
    .where(
      and(
        eq(referralEarnings.referrerUserId, user.id),
        isNull(referralEarnings.reversedAt),
        after ? sql`(${at}, ${referralEarnings.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(at), desc(referralEarnings.id))
    .limit(q.limit + 1)
  const page = rows.slice(0, q.limit)
  const last = page[page.length - 1]
  return {
    items: page.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      username: r.username ?? '',
      raffleName: r.raffleName,
      entryRaffs: r.entryRaffs,
      earnedRaffs: r.raffs,
    })),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  }
}
