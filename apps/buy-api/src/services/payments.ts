/**
 * A payment, confirmed. Whoever notices first (the webhook, the buyer coming
 * back to the site, or the daily reconciliation) calls settlePayment; it is
 * idempotent, so the others find it done.
 *
 *   1. ask Paystack again: GET /transaction/verify/:reference
 *   2. it must be status success, the quote's amount in kobo, NGN, and carry
 *      the quote's id and Telegram id in its metadata
 *   3. then, in one transaction under the quote's row lock:
 *        matches, confirmed in time  -> payment + a pending credit in the outbox
 *        confirmed after the window  -> payment + flag "late_payment" (no credit)
 *        anything differs            -> payment + flag "amount_mismatch" (no credit)
 *
 * The Raffs are always the quote's (baseRaffs + bonusRaffs at its stored
 * rate), never the rate at the time of the webhook.
 */
import { eq } from 'drizzle-orm'
import type { CreditRequest } from '@raffwin/relay'
import type { AppContext } from '../context'
import { credits, payments, quotes, type QuoteRow } from '../db/schema'
import { uniqueViolation } from '../db/client'
import { metadataOf, PaystackError, type PaystackTransaction } from '../lib/paystack'
import { raiseFlag } from './flags'
import { recordSecurity } from './security'

export type Settled = 'credit' | 'late' | 'mismatch' | 'unmatched' | 'already' | 'not_paid' | 'unknown_reference' | 'unreachable'

export async function settlePayment(ctx: AppContext, reference: string, source: 'webhook' | 'return' | 'reconcile', known?: PaystackTransaction): Promise<Settled> {
  const [quote] = await ctx.db.select().from(quotes).where(eq(quotes.reference, reference))
  if (quote && quote.status !== 'awaiting_payment' && quote.status !== 'failed') return 'already'

  let tx: PaystackTransaction
  try {
    tx = await ctx.paystack.verify(reference)
  } catch (error) {
    ctx.log.warn({ err: error instanceof PaystackError ? { message: error.message, status: error.status } : error, reference, source }, 'paystack verify failed; tried again later')
    return 'unreachable'
  }
  if (tx.status !== 'success') return 'not_paid'

  if (!quote) {
    // Paid at Paystack under a reference we never made (or lost): only an admin can tell what it was
    if (source !== 'reconcile') return 'unknown_reference'
    await recordUnmatched(ctx, reference, tx, known)
    return 'unmatched'
  }

  const problems = mismatches(quote, tx)
  const paidAt = tx.paid_at ? new Date(tx.paid_at) : new Date(ctx.now())
  const outcome: 'credit' | 'late' | 'mismatch' = problems.length ? 'mismatch' : paidAt.getTime() > quote.creditUntil.getTime() ? 'late' : 'credit'

  try {
    const done = await ctx.db.transaction(async (db) => {
      const [locked] = await db.select().from(quotes).where(eq(quotes.id, quote.id)).for('update')
      if (!locked || (locked.status !== 'awaiting_payment' && locked.status !== 'failed')) return false
      await db.insert(payments).values({
        reference,
        quoteId: quote.id,
        paystackId: tx.id,
        amountKobo: tx.amount,
        currency: tx.currency,
        paystackStatus: tx.status,
        channel: tx.channel ?? null,
        paidAt,
        outcome,
        source,
      })
      await db
        .update(quotes)
        .set({ status: outcome === 'credit' ? 'paid' : outcome, updatedAt: new Date(ctx.now()) })
        .where(eq(quotes.id, quote.id))
      if (outcome === 'credit') {
        const payload: CreditRequest = {
          reference,
          source: 'paystack',
          telegramId: quote.telegramId,
          quoteId: quote.id,
          nairaKobo: quote.nairaKobo,
          rateId: quote.rateId,
          nairaPerRaffKobo: quote.nairaPerRaffKobo,
          baseRaffs: quote.baseRaffs,
          bonusRaffs: quote.bonusRaffs,
          paidAt: paidAt.toISOString(),
        }
        // Saved before anything is sent: the outbox delivers it, however long that takes
        await db.insert(credits).values({ reference, quoteId: quote.id, payload, nextAttemptAt: new Date(ctx.now()) })
      } else {
        const minutes = Math.round((paidAt.getTime() - quote.createdAt.getTime()) / 60_000)
        await raiseFlag(db, ctx.now(), {
          reference,
          kind: outcome === 'late' ? 'late_payment' : 'amount_mismatch',
          telegramId: quote.telegramId,
          nairaKobo: tx.amount,
          detail:
            outcome === 'late'
              ? `Paid ${minutes} minutes after the quote (window ${ctx.config.CREDIT_WINDOW_MINUTES}). Quote: ${quote.baseRaffs + quote.bonusRaffs} Raffs for ₦${quote.nairaKobo / 100}.`
              : `Paystack differs from the quote: ${problems.join('; ')}.`,
        })
      }
      return true
    })
    if (!done) return 'already'
  } catch (error) {
    if (uniqueViolation(error) === 'payments_reference_key') return 'already'
    throw error
  }

  if (outcome === 'mismatch') {
    await recordSecurity(ctx, { kind: 'payment_mismatch', severity: 'high', ipHash: null, buyerId: quote.buyerId, details: { reference, problems } })
  }
  ctx.log.info({ reference, outcome, source }, 'payment settled')
  return outcome
}

function mismatches(q: QuoteRow, tx: PaystackTransaction): string[] {
  const meta = metadataOf(tx)
  const out: string[] = []
  if (tx.reference !== q.reference) out.push(`reference ${tx.reference}`)
  if (tx.amount !== q.nairaKobo) out.push(`amount ${tx.amount} kobo, quote ${q.nairaKobo}`)
  if (tx.currency !== 'NGN') out.push(`currency ${tx.currency}`)
  if (meta.quote_id !== q.id) out.push('quote id in metadata')
  if (Number(meta.telegram_id) !== q.telegramId) out.push('Telegram id in metadata')
  return out
}

async function recordUnmatched(ctx: AppContext, reference: string, tx: PaystackTransaction, known?: PaystackTransaction) {
  const t = known ?? tx
  const meta = metadataOf(t)
  const tg = Number(meta.telegram_id)
  try {
    await ctx.db.insert(payments).values({
      reference,
      paystackId: t.id,
      amountKobo: t.amount,
      currency: t.currency,
      paystackStatus: t.status,
      channel: t.channel ?? null,
      paidAt: t.paid_at ? new Date(t.paid_at) : null,
      outcome: 'unmatched',
      source: 'reconcile',
    })
  } catch (error) {
    if (uniqueViolation(error) !== 'payments_reference_key') throw error
  }
  await raiseFlag(ctx.db, ctx.now(), {
    reference,
    kind: 'unmatched',
    telegramId: Number.isSafeInteger(tg) && tg > 0 ? tg : null,
    nairaKobo: t.amount,
    detail: `A successful Paystack payment (${t.currency} ${t.amount / 100}) with no quote on this site.`,
  })
}
