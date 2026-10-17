/**
 * Entering a raffle (docs/ARCHITECTURE.md section 8). One transaction:
 *
 *   0. (before it) the player has a phone, when require_phone_for_entry is on
 *   1. lock the raffle row          (serialises ticket numbers for this raffle)
 *   2. lock the player and referrer (in id order, so two transactions can never
 *                                    wait on each other's user rows)
 *   3. check status, deadline, stock, caps and balance
 *   4. assign the next contiguous ticket range, write the entry and its ledger row
 *   5. credit the referrer 10% (single level, Raffs only)
 *
 * The raffle is always locked before any user row, in every code path that
 * locks both, so the lock order is global and deadlock-free.
 */
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import { referralEarning, type Entry, type Raffle, type Transaction } from '@raffwin/shared'
import type { EnterRaffleBody } from '@raffwin/shared/schemas'
import type { AppContext } from '../context'
import { uniqueViolation } from '../db/client'
import { entries, ledger, raffles, referralEarnings, users, type UserRow } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { isFeatureOn } from './features'
import { post, toTransaction, type Tx } from './ledger'
import { getForPlayer, toEntry } from './raffles'
import { getSetting } from './settings'

export interface EnterResult {
  entry: Entry
  raffle: Raffle
  balance: number
  transaction: Transaction
}

/** Midnight in Lagos (UTC+1, no daylight saving) at or before `now`. */
export function lagosDayStart(now: number): Date {
  const LAGOS = 60 * 60 * 1000
  return new Date(Math.floor((now + LAGOS) / 86_400_000) * 86_400_000 - LAGOS)
}

export async function enterRaffle(ctx: AppContext, player: UserRow, body: EnterRaffleBody): Promise<EnterResult> {
  if (!player.signedUpAt) throw new HttpError('NOT_SIGNED_IN', 'Create your account first.')

  const replay = await findByKey(ctx, player.id, body.idempotencyKey)
  if (replay) return replay

  // Winners must be reachable: with the switch on, no phone means no entry (nothing has moved yet)
  if (!player.phone && (await isFeatureOn(ctx.db, 'require_phone_for_entry', player.id))) {
    throw new HttpError('PHONE_REQUIRED', 'Share your phone number first, so we can reach you if you win.')
  }

  const now = ctx.now()
  let created: { entryId: string }
  try {
    created = await ctx.db.transaction(async (tx) => {
      const [raffle] = await tx.select().from(raffles).where(eq(raffles.id, body.raffleId)).for('update')
      if (!raffle || raffle.status === 'draft') throw new HttpError('NOT_FOUND', 'That raffle no longer exists.')
      if (raffle.status !== 'open' || raffle.deadline.getTime() <= now) {
        throw new HttpError('RAFFLE_CLOSED', 'Entries for this raffle have closed.')
      }
      if (body.priceRaffs !== undefined && body.priceRaffs !== raffle.entryPriceRaffs) {
        throw new HttpError('PRICE_CHANGED', `The entry price is now ${raffle.entryPriceRaffs} Raffs (it was ${body.priceRaffs}). Check it and confirm again.`)
      }
      const remaining = raffle.entriesTarget - raffle.entriesCount
      if (remaining <= 0) throw new HttpError('RAFFLE_CLOSED', 'This raffle is sold out.')
      if (body.qty > remaining) {
        throw new HttpError('INVALID_INPUT', `Only ${remaining} ${remaining === 1 ? 'entry is' : 'entries are'} left.`, {
          qty: `At most ${remaining}`,
        })
      }

      const lockIds = [player.id, ...(player.referredByUserId ? [player.referredByUserId] : [])].sort()
      const locked = await tx.select().from(users).where(inArray(users.id, lockIds)).orderBy(asc(users.id)).for('update')
      const me = locked.find((u) => u.id === player.id)
      if (!me || me.status !== 'active') {
        throw new HttpError('ACCOUNT_SUSPENDED', 'This account is suspended. Send /paysupport to the bot for help.')
      }

      await checkCaps(ctx, tx, me.id, raffle.id, body.qty, body.qty * raffle.entryPriceRaffs, now)

      const cost = body.qty * raffle.entryPriceRaffs
      if (me.balanceCache < cost) {
        throw new HttpError('INSUFFICIENT_FUNDS', `You need ${cost - me.balanceCache} more Raffs for this entry.`)
      }

      const ticketFrom = raffle.entriesCount + 1
      const ticketTo = raffle.entriesCount + body.qty
      await tx
        .update(raffles)
        .set({ entriesCount: ticketTo, updatedAt: sql`now()` })
        .where(eq(raffles.id, raffle.id))
      const [entry] = await tx
        .insert(entries)
        .values({
          userId: me.id,
          raffleId: raffle.id,
          qty: body.qty,
          raffsSpent: cost,
          ticketFrom,
          ticketTo,
          idempotencyKey: body.idempotencyKey,
        })
        .returning({ id: entries.id })
      if (!entry) throw new Error('entry insert returned no row')

      await post(tx, {
        userId: me.id,
        type: 'entry',
        raffs: -cost,
        note: `Entry: ${raffle.prizeName} x${body.qty} (tickets ${ticketFrom}-${ticketTo})`,
        referenceType: 'entry',
        referenceId: entry.id,
      })

      const referrer = locked.find((u) => u.id === me.referredByUserId)
      const earned = referralEarning(cost)
      if (referrer && referrer.status === 'active' && earned > 0) {
        const credit = await post(tx, {
          userId: referrer.id,
          type: 'referral',
          raffs: earned,
          note: `Referral: @${me.username} entered ${raffle.prizeName}`,
          referenceType: 'entry',
          referenceId: entry.id,
        })
        await tx.insert(referralEarnings).values({
          referrerUserId: referrer.id,
          referredUserId: me.id,
          entryId: entry.id,
          raffs: earned,
          ledgerId: credit.id,
        })
      }
      return { entryId: entry.id }
    })
  } catch (error) {
    // Two taps with one key raced past the replay check: return the winner's entry
    if (uniqueViolation(error) === 'entries_idempotency_key') {
      const winner = await findByKey(ctx, player.id, body.idempotencyKey)
      if (winner) return winner
    }
    throw error
  }
  return result(ctx, player.id, created.entryId)
}

async function checkCaps(
  _ctx: AppContext,
  tx: Tx,
  userId: string,
  raffleId: string,
  qty: number,
  cost: number,
  now: number,
): Promise<void> {
  const perRaffle = await getSetting(tx, 'limits.max_entries_per_user_per_raffle')
  if (perRaffle !== null) {
    const [held] = await tx
      .select({ n: sql<number>`coalesce(sum(${entries.qty}), 0)::int` })
      .from(entries)
      .where(and(eq(entries.userId, userId), eq(entries.raffleId, raffleId)))
    const have = held?.n ?? 0
    if (have + qty > perRaffle) {
      throw new HttpError(
        'INVALID_INPUT',
        `You can hold at most ${perRaffle} entries in one raffle; you have ${have}.`,
        { qty: `At most ${Math.max(0, perRaffle - have)}` },
      )
    }
  }
  const daily = await getSetting(tx, 'limits.daily_spend_raffs')
  if (daily !== null) {
    const [spent] = await tx
      .select({ n: sql<number>`coalesce(sum(${entries.raffsSpent}), 0)::int` })
      .from(entries)
      .where(and(eq(entries.userId, userId), gte(entries.createdAt, lagosDayStart(now))))
    const today = spent?.n ?? 0
    if (today + cost > daily) {
      throw new HttpError('INVALID_INPUT', `Your daily limit is ${daily} Raffs on entries; ${Math.max(0, daily - today)} left today.`)
    }
  }
}

async function findByKey(ctx: AppContext, userId: string, key: string): Promise<EnterResult | null> {
  const [row] = await ctx.db
    .select({ id: entries.id })
    .from(entries)
    .where(and(eq(entries.userId, userId), eq(entries.idempotencyKey, key)))
  return row ? result(ctx, userId, row.id) : null
}

async function result(ctx: AppContext, userId: string, entryId: string): Promise<EnterResult> {
  const [entry] = await ctx.db.select().from(entries).where(eq(entries.id, entryId))
  if (!entry) throw new Error(`entry ${entryId} missing`)
  const [debit] = await ctx.db
    .select()
    .from(ledger)
    .where(and(eq(ledger.referenceId, entryId), eq(ledger.userId, userId), eq(ledger.type, 'entry')))
  const [me] = await ctx.db.select({ balance: users.balanceCache }).from(users).where(eq(users.id, userId))
  if (!debit || !me) throw new Error(`entry ${entryId} has no ledger row`)
  return {
    entry: toEntry(entry),
    raffle: await getForPlayer(ctx.db, entry.raffleId),
    balance: me.balance,
    transaction: toTransaction(debit),
  }
}
