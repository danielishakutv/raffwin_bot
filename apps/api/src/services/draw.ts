/**
 * The draw (decision of 19 Oct). Runs on its own worker loop every few
 * seconds (services/worker.ts), so a raffle is settled within seconds of its
 * deadline and every open app sees the result on its next live poll.
 *
 *   at opening   a secret seed is fixed and its SHA-256 published
 *                (seed_commitment); raffles opened before this existed get
 *                theirs on the first pass after deploy, still before their deadline
 *   at deadline  fewer than minEntriesToDraw() tickets sold (5, or the number of
 *                prizes if larger): nothing to draw, so the raffle is cancelled and
 *                every entry refunded in full (approvals.cancelRaffle);
 *                otherwise one winning ticket per place, distinct tickets, picked
 *                from the seed (pickWinningTickets), Raffs prizes credited, the
 *                seed published, the winners and every entrant told by the bot
 *
 * Everything for one raffle happens in one transaction under the raffle's row
 * lock (the same lock entries and admin edits take), so an entry or an edit
 * can never land between "the deadline passed" and "the winners were picked".
 */
import { createHash, randomBytes } from 'node:crypto'
import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm'
import { minEntriesToDraw, prizeLabel } from '@raffwin/shared'
import type { AppContext } from '../context'
import { entries, rafflePrizes, raffles, users, type RaffleRow } from '../db/schema'
import { appendAudit } from '../admin/audit'
import { cancelRaffle } from '../admin/approvals'
import { escapeHtml } from '../lib/html'
import { sha256Hex } from '../lib/crypto'
import { stopDrawReminders } from './draw-reminders'
import { post, type Tx } from './ledger'
import { createBroadcast, enqueue, openAppButton } from './notify'
import { forgetRaffles } from '../lib/shared-cache'

/** A fresh secret seed and the commitment published while entries are open. */
export function newDrawSeed(): { seed: string; commitment: string } {
  const seed = randomBytes(32).toString('hex')
  return { seed, commitment: sha256Hex(seed) }
}

/**
 * Winning ticket numbers, index 0 = 1st place. Deterministic: anyone holding
 * the published seed, the raffle id and the number of tickets sold gets the
 * same tickets (the method is spelled out in @raffwin/shared DRAW_METHOD).
 */
export function pickWinningTickets(seed: string, raffleId: string, sold: number, places: number): number[] {
  if (places > sold) throw new Error(`cannot draw ${places} distinct tickets from ${sold}`)
  const taken = new Set<number>()
  const picked: number[] = []
  for (let place = 1; place <= places; place++) {
    for (let attempt = 0; ; attempt++) {
      const digest = createHash('sha256').update(`${seed}:${raffleId}:${sold}:${place}:${attempt}`).digest('hex')
      const ticket = Number(BigInt(`0x${digest}`) % BigInt(sold)) + 1
      if (!taken.has(ticket)) {
        taken.add(ticket)
        picked.push(ticket)
        break
      }
    }
  }
  return picked
}

/** "@ada_obi", or a first name for a player without a username. Never a phone or a full name. */
export function publicName(u: { username: string | null; fullName: string | null; tgFirstName: string | null }): string {
  if (u.username) return `@${u.username}`
  const first = (u.fullName ?? u.tgFirstName ?? '').trim().split(/\s+/)[0]
  return first || 'A player'
}

/** Gives every open raffle without a commitment its seed now, long before it can draw. */
export async function ensureSeedCommitments(ctx: AppContext): Promise<number> {
  const missing = await ctx.db
    .select({ id: raffles.id })
    .from(raffles)
    .where(and(eq(raffles.status, 'open'), isNull(raffles.seedCommitment)))
  for (const { id } of missing) {
    const { seed, commitment } = newDrawSeed()
    await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .update(raffles)
        .set({ drawSeed: seed, seedCommitment: commitment })
        .where(and(eq(raffles.id, id), isNull(raffles.seedCommitment)))
        .returning({ id: raffles.id })
      if (row) await appendAudit(tx, { adminId: null, action: 'raffle.seed_committed', targetType: 'raffle', targetId: id, after: { commitment, late: true } })
    })
  }
  return missing.length
}

export interface DrawPass {
  drawn: number
  cancelled: number
  failed: number
}

/** One pass: settles every open raffle whose deadline has passed. A failure is logged and retried next pass. */
export async function runDrawsOnce(ctx: AppContext): Promise<DrawPass> {
  const due = await ctx.db
    .select({ id: raffles.id })
    .from(raffles)
    .where(and(eq(raffles.status, 'open'), lte(raffles.deadline, new Date(ctx.now()))))
    .orderBy(asc(raffles.deadline))
  const pass: DrawPass = { drawn: 0, cancelled: 0, failed: 0 }
  for (const { id } of due) {
    try {
      const outcome = await settleRaffle(ctx, id)
      if (outcome !== 'skipped') forgetRaffles(ctx.cache)
      if (outcome === 'drawn') pass.drawn += 1
      if (outcome === 'cancelled') pass.cancelled += 1
    } catch (error) {
      pass.failed += 1
      ctx.log.error({ err: error, raffleId: id }, 'draw failed; it is tried again on the next pass')
    }
  }
  return pass
}

/** Draws or cancels one raffle whose deadline has passed. 'skipped' = someone else settled it first. */
export async function settleRaffle(ctx: AppContext, raffleId: string): Promise<'drawn' | 'cancelled' | 'skipped'> {
  const at = new Date(ctx.now())
  return ctx.db.transaction(async (tx) => {
    const [raffle] = await tx.select().from(raffles).where(eq(raffles.id, raffleId)).for('update')
    if (!raffle || raffle.status !== 'open' || raffle.deadline.getTime() > at.getTime()) return 'skipped'
    const prizes = await tx.select().from(rafflePrizes).where(eq(rafflePrizes.raffleId, raffleId)).orderBy(asc(rafflePrizes.position))
    const need = minEntriesToDraw(prizes.length)

    if (raffle.entriesCount < need) {
      const result = await cancelRaffle(tx, raffleId, null, at, { sold: raffle.entriesCount, need })
      await appendAudit(tx, {
        adminId: null,
        action: 'raffle.not_drawn',
        targetType: 'raffle',
        targetId: raffleId,
        after: { reason: 'too_few_entries', sold: raffle.entriesCount, need, ...result },
      })
      return 'cancelled'
    }

    await drawWinners(ctx, tx, raffle, prizes, at)
    return 'drawn'
  })
}

type PrizeRow = typeof rafflePrizes.$inferSelect

async function drawWinners(ctx: AppContext, tx: Tx, raffle: RaffleRow, prizes: PrizeRow[], at: Date): Promise<void> {
  // A raffle opened before seeds existed and never committed (the commitment pass had not run): seed it now
  const late = !raffle.drawSeed
  const seed = raffle.drawSeed ?? newDrawSeed().seed
  const commitment = raffle.seedCommitment ?? sha256Hex(seed)
  const sold = raffle.entriesCount
  const tickets = pickWinningTickets(seed, raffle.id, sold, prizes.length)

  // Each ticket's entry: the one whose range starts at or below it (entries_ticket_from_key)
  const owners: { entryId: string; userId: string }[] = []
  for (const ticket of tickets) {
    const [e] = await tx
      .select({ id: entries.id, userId: entries.userId, ticketTo: entries.ticketTo })
      .from(entries)
      .where(and(eq(entries.raffleId, raffle.id), lte(entries.ticketFrom, ticket)))
      .orderBy(desc(entries.ticketFrom))
      .limit(1)
    if (!e || e.ticketTo < ticket) throw new Error(`raffle ${raffle.id}: no entry holds ticket ${ticket} of ${sold}`)
    owners.push({ entryId: e.id, userId: e.userId })
  }

  // Raffle locked first, then users in id order (the global lock order); also read what the messages need
  const winnerIds = [...new Set(owners.map((o) => o.userId))].sort()
  const people = await tx
    .select({ id: users.id, telegramId: users.telegramId, username: users.username, fullName: users.fullName, tgFirstName: users.tgFirstName })
    .from(users)
    .where(sql`${users.id} = any(${sql.param(winnerIds)}::uuid[])`)
    .orderBy(asc(users.id))
    .for('update')
  const byId = new Map(people.map((p) => [p.id, p]))

  const results: { position: number; prizeItem: string; ticket: number; userId: string; name: string; raffs: number }[] = []
  for (const [i, prize] of prizes.entries()) {
    const ticket = tickets[i] as number
    const owner = owners[i] as { userId: string }
    const person = byId.get(owner.userId)
    if (!person) throw new Error(`winner ${owner.userId} not found`)
    const credit = prize.prizeType === 'raffs_credit' && prize.raffsValue > 0 ? prize.raffsValue : 0
    if (credit) {
      await post(tx, {
        userId: person.id,
        type: 'prize',
        raffs: credit,
        note: `Prize: ${prize.prizeItem} (${raffle.prizeName}, ticket ${ticket})`,
        referenceType: 'raffle_prize',
        referenceId: prize.id,
      })
    }
    await tx
      .update(rafflePrizes)
      .set({ winnerUserId: person.id, winnerTicket: ticket, fulfilmentStatus: credit ? 'delivered' : 'pending' })
      .where(eq(rafflePrizes.id, prize.id))
    results.push({ position: prize.position, prizeItem: prize.prizeItem, ticket, userId: person.id, name: publicName(person), raffs: credit })
  }

  await stopDrawReminders(tx, raffle.id, at)
  await tx
    .update(raffles)
    .set({ status: 'drawn', drawnAt: at, drawSeed: seed, seedCommitment: commitment, updatedAt: sql`now()` })
    .where(eq(raffles.id, raffle.id))
  await appendAudit(tx, {
    adminId: null,
    action: 'raffle.drawn',
    targetType: 'raffle',
    targetId: raffle.id,
    after: { sold, seed, commitment, committedLate: late, winners: results.map(({ position, ticket, userId }) => ({ position, ticket, userId })) },
  })

  // The bot: the whole board to the entrants and to everyone with new-raffle alerts on, and each winner their own message
  const total = prizes.length
  const board = results.map((r) => `${prizeLabel(r.position, total)}: ${r.name} (ticket ${r.ticket}) wins ${r.prizeItem}`)
  await createBroadcast(tx, {
    kind: 'raffle_drawn',
    title: `Winners: ${raffle.prizeName}`,
    text: [...board, '', `${sold.toLocaleString('en-NG')} tickets were in the draw. Open Raffle Win to watch it and see the next raffles.`].join('\n'),
    openButton: true,
    audience: { type: 'all' },
    refType: 'raffle',
    refId: raffle.id,
    adminId: null,
  })
  const button = openAppButton(ctx, 'See my win')
  for (const r of results) {
    const person = byId.get(r.userId)
    if (!person) continue
    const lines = [
      `<b>You won!</b> ${escapeHtml(r.prizeItem)} in the ${escapeHtml(raffle.prizeName)} raffle, with ticket ${r.ticket}.`,
      '',
      r.raffs
        ? `${r.raffs.toLocaleString('en-NG')} Raffs are already in your balance.`
        : 'We will contact you on your phone number to arrange collection at your motor park. Keep your phone on.',
    ]
    await enqueue(tx, {
      userId: person.id,
      telegramId: person.telegramId,
      kind: 'raffle_won',
      text: lines.join('\n'),
      buttons: button ? [[button]] : null,
      dedupeKey: `won:${raffle.id}:${r.position}`,
    })
  }
}
