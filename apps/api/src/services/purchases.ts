/**
 * Raffs bought on the sales site (decision of 19 Oct). The sales site's
 * backend tells us about a confirmed payment through the signed relay
 * (http/relay.ts); this is where it becomes Raffs.
 *
 *   account   who this Telegram id is here, their balance, the rate this hour
 *             and the sales options an admin set (Settings > Rate and sales)
 *   credit    one confirmed payment, credited once
 *
 * A credit is never taken on trust, even signed. It must name a real hourly
 * quote and carry exactly that quote's price; its Raffs must be what the naira
 * buys at that price (rounded down) plus a bonus of at most 15%; the quote
 * must be recent for the payment; the naira must be within the admin's
 * maximum. So a leaked relay secret still cannot mint Raffs at a made-up rate.
 *
 * Idempotent on the payment reference (purchases_reference_key): the same
 * payment again answers "already credited" with the same figures; the same
 * reference with different figures is refused as a conflict.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  bonusRaffs,
  MAX_BONUS_PERCENT,
  raffsForNaira,
  type AccountResponse,
  type CreditRequest,
  type CreditResponse,
  type RelayRefusal,
} from '@raffwin/relay'
import type { AppContext } from '../context'
import { uniqueViolation } from '../db/client'
import { purchases, rateQuotes, users, type PurchaseRow } from '../db/schema'
import { escapeHtml } from '../lib/html'
import { post } from './ledger'
import { enqueue, openAppButton } from './notify'
import { currentQuote } from './rates'
import { getSetting, salesSettings } from './settings'

/** How long after its hour a quote can still be what a payment is credited at (30 min to pay + 2 h to confirm + the hour itself, with room) */
export const QUOTE_MAX_AGE_MS = 4 * 3_600_000
/** A payment time this far ahead of our clock is refused */
const PAID_AHEAD_MS = 5 * 60_000

export async function accountFor(ctx: AppContext, telegramId: number): Promise<AccountResponse> {
  const quote = await currentQuote(ctx.db, ctx.now())
  const base = quote.baseNairaPerRaffKobo ?? (await getSetting(ctx.db, 'rate.base_naira_per_raff_kobo'))
  const rate = { id: quote.id, nairaPerRaffKobo: quote.nairaPerRaffKobo, baseNairaPerRaffKobo: base, validUntil: quote.expiresAt.toISOString() }
  const sales = await salesSettings(ctx.db)
  const [user] = await ctx.db.select({ status: users.status, balance: users.balanceCache }).from(users).where(eq(users.telegramId, telegramId))
  if (!user) return { exists: false, rate, sales }
  return { exists: true, status: user.status === 'active' ? 'active' : 'suspended', balance: user.balance, rate, sales }
}

export type CreditOutcome = { ok: true; response: CreditResponse } | { ok: false; refusal: RelayRefusal; message: string }

const refuse = (refusal: RelayRefusal, message: string): CreditOutcome => ({ ok: false, refusal, message })

/** The checks that do not need the player: is this amount right for this quote? */
async function checkAmounts(ctx: AppContext, c: CreditRequest): Promise<CreditOutcome | null> {
  const [quote] = await ctx.db.select().from(rateQuotes).where(eq(rateQuotes.id, c.rateId))
  if (!quote) return refuse('out_of_bounds', 'No such rate')
  if (quote.nairaPerRaffKobo !== c.nairaPerRaffKobo) return refuse('out_of_bounds', `Rate ${c.nairaPerRaffKobo} is not the quote's ${quote.nairaPerRaffKobo}`)
  const paidAt = Date.parse(c.paidAt)
  if (paidAt < quote.hourStart.getTime() || paidAt - quote.hourStart.getTime() > QUOTE_MAX_AGE_MS) return refuse('out_of_bounds', 'Payment time is outside the quote window')
  if (paidAt > ctx.now() + PAID_AHEAD_MS) return refuse('out_of_bounds', 'Payment time is in the future')
  if (c.baseRaffs !== raffsForNaira(c.nairaKobo, c.nairaPerRaffKobo)) return refuse('out_of_bounds', 'Raffs do not match the naira at that rate')
  if (c.bonusRaffs > bonusRaffs(c.baseRaffs, MAX_BONUS_PERCENT)) return refuse('out_of_bounds', 'Bonus above the maximum')
  const maxNaira = await getSetting(ctx.db, 'sales.max_naira')
  if (c.nairaKobo > maxNaira * 100) return refuse('out_of_bounds', `Above the ₦${maxNaira} maximum`)
  return null
}

function sameCredit(row: PurchaseRow, c: CreditRequest): boolean {
  return (
    row.telegramId === c.telegramId &&
    row.quoteId === c.quoteId &&
    row.nairaKobo === c.nairaKobo &&
    row.rateId === c.rateId &&
    row.baseRaffs === c.baseRaffs &&
    row.bonusRaffs === c.bonusRaffs
  )
}

/** The answer for a reference already credited */
async function repeat(ctx: AppContext, c: CreditRequest): Promise<CreditOutcome | null> {
  const [row] = await ctx.db.select().from(purchases).where(eq(purchases.reference, c.reference))
  if (!row) return null
  if (!sameCredit(row, c)) return refuse('reference_conflict', 'This reference was credited with different figures')
  const [u] = await ctx.db.select({ balance: users.balanceCache }).from(users).where(eq(users.id, row.userId))
  return { ok: true, response: { status: 'already_credited', creditId: row.id, raffs: row.raffs, balance: u?.balance ?? 0 } }
}

export async function creditPurchase(ctx: AppContext, c: CreditRequest): Promise<CreditOutcome> {
  const before = await repeat(ctx, c)
  if (before) return before
  const wrong = await checkAmounts(ctx, c)
  if (wrong) return wrong

  try {
    return await ctx.db.transaction(async (tx) => {
      // The player's row is the lock: two credits for one player queue here
      const [user] = await tx.select().from(users).where(eq(users.telegramId, c.telegramId)).for('update')
      if (!user) return refuse('no_account', 'No player with this Telegram id')
      if (user.status !== 'active') return refuse('account_suspended', `The player is ${user.status}`)
      // Under the lock: a repeat that arrived while we were checking
      const [dup] = await tx.select().from(purchases).where(eq(purchases.reference, c.reference))
      if (dup) {
        if (!sameCredit(dup, c)) return refuse('reference_conflict', 'This reference was credited with different figures')
        return { ok: true as const, response: { status: 'already_credited' as const, creditId: dup.id, raffs: dup.raffs, balance: user.balanceCache } }
      }

      const id = randomUUID()
      const raffs = c.baseRaffs + c.bonusRaffs
      const naira = (c.nairaKobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })
      const entry = await post(tx, {
        userId: user.id,
        type: 'purchase',
        raffs,
        note: c.bonusRaffs ? `Bought for ₦${naira} (${c.bonusRaffs} bonus)` : `Bought for ₦${naira}`,
        referenceType: 'purchase',
        referenceId: id,
      })
      await tx.insert(purchases).values({
        id,
        reference: c.reference,
        source: c.source,
        userId: user.id,
        telegramId: c.telegramId,
        quoteId: c.quoteId,
        nairaKobo: c.nairaKobo,
        rateId: c.rateId,
        nairaPerRaffKobo: c.nairaPerRaffKobo,
        baseRaffs: c.baseRaffs,
        bonusRaffs: c.bonusRaffs,
        raffs,
        paidAt: new Date(c.paidAt),
        ledgerId: entry.id,
      })

      // The bot tells the player. No link anywhere but to their own wallet in the Mini App.
      const button = openAppButton(ctx, 'Open my wallet', 'wallet')
      const n = (x: number) => x.toLocaleString('en-NG')
      await enqueue(tx, {
        userId: user.id,
        telegramId: user.telegramId,
        kind: 'purchase',
        text: [
          `<b>${n(raffs)} Raffs are in your balance</b>`,
          '',
          `Your payment of ₦${escapeHtml(naira)} went through${c.bonusRaffs ? `, with ${n(c.bonusRaffs)} bonus Raffs` : ''}. Your balance is now ${n(entry.balanceAfter)} Raffs.`,
        ].join('\n'),
        buttons: button ? [[button]] : null,
        dedupeKey: `purchase:${id}`,
      })
      return { ok: true as const, response: { status: 'credited' as const, creditId: id, raffs, balance: entry.balanceAfter } }
    })
  } catch (error) {
    // Two deliveries of one payment for different players at the same instant: the unique reference stops the second
    if (uniqueViolation(error) === 'purchases_reference_key') {
      const after = await repeat(ctx, c)
      if (after) return after
    }
    throw error
  }
}
