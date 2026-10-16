/**
 * Raffles as players see them, in the shared Raffle shape. Drafts and
 * cancelled raffles are never shown; drawn raffles stay visible for 30 days,
 * or for as long as the player holds an entry in them.
 */
import { and, asc, desc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import type { Entry, LiveSnapshot, Raffle, WinnerSlot } from '@raffwin/shared'
import type { Db } from '../db/client'
import { entries, rafflePrizes, raffles, users, type EntryRow, type RaffleRow } from '../db/schema'
import { HttpError } from '../lib/http-error'

const DRAWN_VISIBLE_DAYS = 30
const ENTRANTS_SHOWN = 40

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
    .select({ prize: rafflePrizes, winner: users.username })
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
      .map((p) => ({
        position: p.prize.position as 1 | 2 | 3,
        prizeItem: p.prize.prizeItem,
        username: r.status === 'drawn' ? p.winner : null,
      }))
    return {
      id: r.id,
      prizeName: r.prizeName,
      model: r.model,
      category: r.category,
      kind: r.kind,
      hue: r.hue,
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
      entrants: entrantRows.rows.filter((e) => e.raffle_id === r.id).map((e) => e.username),
    }
  })
}

export async function listForPlayer(db: Db, userId: string, now: number): Promise<Raffle[]> {
  const cutoff = new Date(now - DRAWN_VISIBLE_DAYS * 86_400_000)
  const mine = db.select({ id: entries.raffleId }).from(entries).where(eq(entries.userId, userId))
  const rows = await db
    .select()
    .from(raffles)
    .where(
      or(
        inArray(raffles.status, ['open', 'drawing']),
        and(eq(raffles.status, 'drawn'), gt(raffles.drawnAt, cutoff)),
        and(eq(raffles.status, 'drawn'), inArray(raffles.id, mine)),
      ),
    )
    .orderBy(asc(raffles.deadline))
  return toRaffles(db, rows)
}

export async function getForPlayer(db: Db, raffleId: string): Promise<Raffle> {
  const [row] = await db
    .select()
    .from(raffles)
    .where(and(eq(raffles.id, raffleId), inArray(raffles.status, ['open', 'drawing', 'drawn'])))
  if (!row) throw new HttpError('NOT_FOUND', 'That raffle no longer exists.')
  const [raffle] = await toRaffles(db, [row])
  return raffle as Raffle
}

/**
 * The polled snapshot: one indexed query over the visible raffles plus the
 * player's balance. Kept deliberately small, because every open app asks for it
 * every few seconds.
 */
export async function liveSnapshot(db: Db, user: { id: string; balanceCache: number }, now: number): Promise<LiveSnapshot> {
  const cutoff = new Date(now - DRAWN_VISIBLE_DAYS * 86_400_000)
  const [me] = await db.select({ balance: users.balanceCache }).from(users).where(eq(users.id, user.id))
  const rows = await db
    .select({
      id: raffles.id,
      entriesCount: raffles.entriesCount,
      entriesTarget: raffles.entriesTarget,
      status: raffles.status,
      deadline: raffles.deadline,
      drawnAt: raffles.drawnAt,
    })
    .from(raffles)
    .where(or(inArray(raffles.status, ['open', 'drawing']), and(eq(raffles.status, 'drawn'), gt(raffles.drawnAt, cutoff))))
  return {
    serverTime: now,
    balance: me?.balance ?? user.balanceCache,
    raffles: rows.map((r) => ({
      id: r.id,
      entriesCount: r.entriesCount,
      entriesTarget: r.entriesTarget,
      status: r.status,
      deadline: r.deadline.toISOString(),
      drawnAt: r.drawnAt?.toISOString() ?? null,
    })),
  }
}

export async function entriesForPlayer(db: Db, userId: string, limit = 200): Promise<Entry[]> {
  const rows = await db.select().from(entries).where(eq(entries.userId, userId)).orderBy(desc(entries.createdAt)).limit(limit)
  return rows.map(toEntry)
}
