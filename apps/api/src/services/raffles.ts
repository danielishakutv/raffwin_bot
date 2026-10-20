/**
 * Raffles as players see them, in the shared Raffle shape. Drafts and
 * cancelled raffles are never shown; drawn raffles stay visible for 30 days,
 * or for as long as the player holds an entry in them. A raffle an admin
 * deleted or archived is never shown to anyone, entrants and winners
 * included: not in the list, not on its own page, not in My entries.
 */
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Entry, LiveSnapshot, Raffle, WinnerSlot } from '@raffwin/shared'
import type { Db } from '../db/client'
import { entries, rafflePrizes, raffles, users, type EntryRow, type RaffleRow } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { CACHE_KEYS, type SharedCache } from '../lib/shared-cache'
import { publicName } from './draw'
import { featuresForLive } from './features'

const DRAWN_VISIBLE_DAYS = 30
const ENTRANTS_SHOWN = 40

/** Neither deleted nor archived by an admin: the only raffles a player ever sees */
const shownToPlayers = and(isNull(raffles.deletedAt), isNull(raffles.archivedAt))

export function toEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    raffleId: row.raffleId,
    qty: row.qty,
    raffsSpent: row.raffsSpent,
    ticketFrom: row.ticketFrom,
    ticketTo: row.ticketTo,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Builds the shared shape for a set of raffle rows: prizes, winners and recent entrants in two queries. */
export async function toRaffles(db: Db, rows: RaffleRow[]): Promise<Raffle[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const prizes = await db
    .select({ prize: rafflePrizes, winner: users.username, fullName: users.fullName, tgFirstName: users.tgFirstName })
    .from(rafflePrizes)
    .leftJoin(users, eq(users.id, rafflePrizes.winnerUserId))
    .where(inArray(rafflePrizes.raffleId, ids))
    .orderBy(asc(rafflePrizes.position))

  // Latest distinct entrants per raffle, newest first
  const entrantRows = await db.execute<{ raffle_id: string; username: string }>(sql`
    select raffle_id, username from (
      select e.raffle_id, u.username,
             row_number() over (partition by e.raffle_id order by max(e.created_at) desc) as n
      from ${entries} e join ${users} u on u.id = e.user_id
      where e.raffle_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) and u.username is not null
      group by e.raffle_id, u.username
    ) ranked where n <= ${ENTRANTS_SHOWN}
  `)

  return rows.map((r) => {
    const winners: WinnerSlot[] = prizes
      .filter((p) => p.prize.raffleId === r.id)
      .map((p) => {
        const drawn = r.status === 'drawn' && p.prize.winnerUserId !== null
        return {
          position: p.prize.position,
          prizeItem: p.prize.prizeItem,
          username: drawn ? p.winner : null,
          name: drawn ? publicName({ username: p.winner, fullName: p.fullName, tgFirstName: p.tgFirstName }) : null,
          ticket: drawn ? p.prize.winnerTicket : null,
        }
      })
    return {
      id: r.id,
      prizeName: r.prizeName,
      model: r.model,
      category: r.category,
      kind: r.kind,
      hue: r.hue,
      imageUrl: r.imageUrl,
      marketPriceNaira: r.marketPriceNaira,
      entryPriceRaffs: r.entryPriceRaffs,
      deadline: r.deadline.toISOString(),
      entriesCount: r.entriesCount,
      entriesTarget: r.entriesTarget,
      description: r.description,
      rules: r.rules,
      winners,
      drawnAt: r.drawnAt?.toISOString() ?? null,
      seedCommitment: r.seedCommitment,
      drawSeed: r.status === 'drawn' ? r.drawSeed : null,
      entrants: entrantRows.rows.filter((e) => e.raffle_id === r.id).map((e) => e.username),
    }
  })
}

/** Open raffles and those drawn in the last 30 days: the same for every player */
async function publicRaffles(db: Db, now: number): Promise<Raffle[]> {
  const cutoff = new Date(now - DRAWN_VISIBLE_DAYS * 86_400_000)
  const rows = await db
    .select()
    .from(raffles)
    .where(and(shownToPlayers, or(inArray(raffles.status, ['open', 'drawing']), and(eq(raffles.status, 'drawn'), gt(raffles.drawnAt, cutoff)))))
    .orderBy(asc(raffles.deadline))
  return toRaffles(db, rows)
}

/**
 * Everything a player sees: the public list (from the shared cache, so a
 * crowd opening the app at once after a draw costs one build of it), plus any
 * drawn raffle over 30 days old that this player holds an entry in, which is
 * rare and cheap.
 */
export async function listForPlayer(db: Db, userId: string, now: number, cache?: SharedCache): Promise<Raffle[]> {
  const cutoff = new Date(now - DRAWN_VISIBLE_DAYS * 86_400_000)
  const mine = db.select({ id: entries.raffleId }).from(entries).where(eq(entries.userId, userId))
  const [shared, olderRows] = await Promise.all([
    cache ? cache.get(CACHE_KEYS.publicRaffles, () => publicRaffles(db, now)) : publicRaffles(db, now),
    db
      .select()
      .from(raffles)
      .where(and(shownToPlayers, eq(raffles.status, 'drawn'), inArray(raffles.id, mine), sql`${raffles.drawnAt} <= ${cutoff}`)),
  ])
  if (olderRows.length === 0) return shared
  const seen = new Set(shared.map((r) => r.id))
  const older = await toRaffles(db, olderRows.filter((r) => !seen.has(r.id)))
  return [...shared, ...older].sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline))
}

export async function getForPlayer(db: Db, raffleId: string): Promise<Raffle> {
  const [row] = await db
    .select()
    .from(raffles)
    .where(and(eq(raffles.id, raffleId), shownToPlayers, inArray(raffles.status, ['open', 'drawing', 'drawn'])))
  if (!row) throw new HttpError('NOT_FOUND', 'That raffle no longer exists.')
  const [raffle] = await toRaffles(db, [row])
  return raffle as Raffle
}

type LiveRaffle = LiveSnapshot['raffles'][number]

async function liveRaffles(db: Db, now: number): Promise<LiveRaffle[]> {
  const cutoff = new Date(now - DRAWN_VISIBLE_DAYS * 86_400_000)
  const rows = await db
    .select({
      id: raffles.id,
      entriesCount: raffles.entriesCount,
      entriesTarget: raffles.entriesTarget,
      status: raffles.status,
      deadline: raffles.deadline,
      drawnAt: raffles.drawnAt,
      // Everything an admin can edit that players see; entry sales leave it alone
      version: sql<string>`md5(concat_ws('|', ${raffles.prizeName}, ${raffles.model}, ${raffles.category}, ${raffles.kind}, ${raffles.hue}, coalesce(${raffles.imageUrl}, ''), ${raffles.marketPriceNaira}, ${raffles.entryPriceRaffs}, ${raffles.description}, ${raffles.rules}::text, (select string_agg(p.position || ':' || p.prize_item || ':' || p.prize_type || ':' || p.raffs_value, ',' order by p.position) from raffle_prizes p where p.raffle_id = "raffles"."id")))`,
    })
    .from(raffles)
    .where(and(shownToPlayers, or(inArray(raffles.status, ['open', 'drawing']), and(eq(raffles.status, 'drawn'), gt(raffles.drawnAt, cutoff)))))
  return rows.map((r) => ({
    id: r.id,
    entriesCount: r.entriesCount,
    entriesTarget: r.entriesTarget,
    status: r.status,
    deadline: r.deadline.toISOString(),
    drawnAt: r.drawnAt?.toISOString() ?? null,
    version: r.version,
  }))
}

/** Within this long of a deadline the app polls faster, so the draw reaches it quickly */
const NEAR_DRAW_MS = 2 * 60_000
const NEAR_DRAW_POLL_MS = 3000

/**
 * How long the app should wait before its next poll: the configured pace,
 * faster while a raffle is about to draw (or drawing), times `loadFactor`
 * when the server is busy (services/capacity.ts).
 */
export function nextPollMs(rows: LiveRaffle[], now: number, baseMs: number, loadFactor = 1): number {
  const nearDraw = rows.some((r) => r.status === 'drawing' || (r.status === 'open' && Date.parse(r.deadline) - now < NEAR_DRAW_MS))
  const pace = nearDraw ? Math.min(baseMs, NEAR_DRAW_POLL_MS) : baseMs
  return Math.min(60_000, Math.round(pace * Math.max(1, loadFactor)))
}

/**
 * The polled snapshot. The balance is the one on the user row the sign-in
 * check has just read (no second query); the raffles and the global feature
 * switches come from the shared cache. So for most players a poll costs the
 * sign-in check and nothing else.
 */
export async function liveSnapshot(
  db: Db,
  user: { id: string; balanceCache: number },
  now: number,
  opts: { cache?: SharedCache; basePollMs?: number; loadFactor?: number } = {},
): Promise<LiveSnapshot> {
  const { cache } = opts
  const [rows, features] = await Promise.all([
    cache ? cache.get(CACHE_KEYS.liveRaffles, () => liveRaffles(db, now)) : liveRaffles(db, now),
    featuresForLive(db, user.id, cache),
  ])
  return {
    serverTime: now,
    balance: user.balanceCache,
    features,
    raffles: rows,
    pollMs: nextPollMs(rows, now, opts.basePollMs ?? 6000, opts.loadFactor),
  }
}

/**
 * A player's entries, newest first, each with enough of its raffle to show it
 * even once the raffle has left the list (refunded). Entries in a raffle an
 * admin deleted or archived are left out: that raffle is gone from the app.
 * The Raffs lines (entry, refund, prize) stay in the wallet history, which must add up.
 */
export async function entriesForPlayer(db: Db, userId: string, limit = 200): Promise<Entry[]> {
  const rows = await db
    .select({ e: entries, r: { prizeName: raffles.prizeName, kind: raffles.kind, hue: raffles.hue, imageUrl: raffles.imageUrl, status: raffles.status } })
    .from(entries)
    .innerJoin(raffles, eq(raffles.id, entries.raffleId))
    .where(and(eq(entries.userId, userId), shownToPlayers))
    .orderBy(desc(entries.createdAt))
    .limit(limit)
  return rows.map(({ e, r }) => ({
    ...toEntry(e),
    raffle: { prizeName: r.prizeName, kind: r.kind, hue: r.hue, imageUrl: r.imageUrl, refunded: r.status === 'cancelled' },
  }))
}
