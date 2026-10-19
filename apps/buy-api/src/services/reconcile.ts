/**
 * Daily reconciliation: every successful Paystack payment in a window is
 * matched against what we recorded. A webhook that never arrived (and a
 * buyer who never came back to the site) would otherwise leave a paid
 * payment uncredited for ever.
 *
 *   paid at Paystack, nothing here   -> settled now (credited, or flagged)
 *   paid at Paystack, no quote here  -> flagged "unmatched"
 *   credited here, still pending     -> the outbox is on it; after a day it
 *                                       flags itself (outbox.ts)
 *
 * Runs at RECONCILE_HOUR (Lagos) for the two days before, so a payment made
 * just before midnight is seen twice; settling is idempotent. Also runnable
 * by hand: node dist/reconcile.js [from] [to]
 */
import { and, eq, isNotNull } from 'drizzle-orm'
import type { AppContext } from '../context'
import { payments, reconcileRuns } from '../db/schema'
import { lagos, lagosMidnight } from '../lib/util'
import { settlePayment } from './payments'

export interface ReconcileResult {
  seen: number
  recovered: number
  flagged: number
}

export async function reconcile(ctx: AppContext, from: Date, to: Date, day: string | null): Promise<ReconcileResult> {
  const [run] = await ctx.db.insert(reconcileRuns).values({ day, fromAt: from, toAt: to }).returning({ id: reconcileRuns.id })
  const result: ReconcileResult = { seen: 0, recovered: 0, flagged: 0 }
  try {
    for (let page = 1, pages = 1; page <= pages; page++) {
      const batch = await ctx.paystack.listSuccessful(from, to, page)
      pages = batch.pageCount
      for (const tx of batch.transactions) {
        result.seen += 1
        const [known] = await ctx.db.select({ id: payments.id }).from(payments).where(eq(payments.reference, tx.reference))
        if (known) continue
        const settled = await settlePayment(ctx, tx.reference, 'reconcile', tx)
        if (settled === 'credit') result.recovered += 1
        if (settled === 'late' || settled === 'mismatch' || settled === 'unmatched') result.flagged += 1
        if (settled === 'unreachable') throw new Error('Paystack stopped answering verify calls')
      }
    }
    await ctx.db.update(reconcileRuns).set({ ...result, finishedAt: new Date(ctx.now()) }).where(eq(reconcileRuns.id, run!.id))
    ctx.log.info({ reconcile: day ?? 'by hand', ...result }, 'reconciliation finished')
    return result
  } catch (error) {
    await ctx.db
      .update(reconcileRuns)
      .set({ ...result, error: (error as Error).message.slice(0, 500), finishedAt: new Date(ctx.now()) })
      .where(eq(reconcileRuns.id, run!.id))
    throw error
  }
}

/** The worker's check: has yesterday (Lagos) been reconciled? If it is past the hour and not, run it. */
export async function reconcileIfDue(ctx: AppContext): Promise<ReconcileResult | null> {
  const now = ctx.now()
  const today = lagos(now)
  if (today.hour < ctx.config.RECONCILE_HOUR) return null
  const yesterday = lagos(lagosMidnight(today.day) - 3_600_000).day
  const [done] = await ctx.db
    .select({ id: reconcileRuns.id })
    .from(reconcileRuns)
    .where(and(eq(reconcileRuns.day, yesterday), isNotNull(reconcileRuns.finishedAt)))
  if (done) return null
  const to = new Date(lagosMidnight(today.day))
  const from = new Date(lagosMidnight(today.day) - 2 * 86_400_000)
  return reconcile(ctx, from, to, yesterday)
}
