/**
 * The credit outbox. A confirmed payment's credit is saved (payments.ts)
 * before it is sent; this sends it, again and again if it has to, and marks
 * it delivered only when the main API says credited (or already credited,
 * which is the same thing a second time). The main API keys every credit on
 * the payment reference, so sending one twice can never pay twice.
 *
 *   delivered   the main API confirmed: done
 *   refused     the main API said no for good (no account, suspended, out of
 *               bounds, conflict): flagged for an admin, never retried
 *   no answer   (down, timeout, 5xx, 401): retried after 30 s, 1, 2, 4 ...
 *               minutes up to an hour, for as long as it takes; after a day
 *               undelivered it is also flagged, once
 */
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import type { AppContext } from '../context'
import { credits } from '../db/schema'
import { raiseFlag } from './flags'

const STUCK_AFTER_MS = 24 * 3_600_000

/** Wait before the next try: 30 s doubling, capped at an hour */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000)
}

export async function deliverCredits(ctx: AppContext, limit = 20): Promise<{ delivered: number; refused: number; retrying: number }> {
  const now = new Date(ctx.now())
  const due = await ctx.db
    .select({ id: credits.id })
    .from(credits)
    .where(and(eq(credits.status, 'pending'), lte(credits.nextAttemptAt, now)))
    .orderBy(asc(credits.nextAttemptAt))
    .limit(limit)
  const pass = { delivered: 0, refused: 0, retrying: 0 }
  for (const { id } of due) {
    // Lease it for two minutes: another worker skips it while this one is waiting on the network
    const [c] = await ctx.db
      .update(credits)
      .set({ nextAttemptAt: new Date(ctx.now() + 120_000), updatedAt: now })
      .where(and(eq(credits.id, id), eq(credits.status, 'pending'), lte(credits.nextAttemptAt, now)))
      .returning()
    if (!c) continue

    const r = await ctx.mainApi.credit(c.payload)
    const at = new Date(ctx.now())
    if (r.ok) {
      await ctx.db.update(credits).set({ status: 'delivered', response: r.data, deliveredAt: at, lastError: null, attempts: c.attempts + 1, updatedAt: at }).where(eq(credits.id, c.id))
      ctx.log.info({ reference: c.reference, status: r.data.status, raffs: r.data.raffs }, 'credit delivered')
      pass.delivered += 1
    } else if (r.refused) {
      await ctx.db.transaction(async (db) => {
        await db.update(credits).set({ status: 'refused', refusedCode: r.refused, lastError: r.message, attempts: c.attempts + 1, updatedAt: at }).where(eq(credits.id, c.id))
        await raiseFlag(db, ctx.now(), {
          reference: c.reference,
          kind: 'credit_refused',
          telegramId: c.payload.telegramId,
          nairaKobo: c.payload.nairaKobo,
          detail: `The credit was refused (${r.refused}): ${r.message}`,
        })
      })
      ctx.log.error({ reference: c.reference, refused: r.refused }, 'credit refused by the main API')
      pass.refused += 1
    } else {
      const stuck = !c.stuckFlagged && at.getTime() - c.createdAt.getTime() > STUCK_AFTER_MS
      await ctx.db.transaction(async (db) => {
        await db
          .update(credits)
          .set({
            attempts: sql`${credits.attempts} + 1`,
            nextAttemptAt: new Date(at.getTime() + backoffMs(c.attempts + 1)),
            lastError: r.error,
            ...(stuck ? { stuckFlagged: true } : {}),
            updatedAt: at,
          })
          .where(eq(credits.id, c.id))
        if (stuck) {
          await raiseFlag(db, ctx.now(), {
            reference: c.reference,
            kind: 'credit_stuck',
            telegramId: c.payload.telegramId,
            nairaKobo: c.payload.nairaKobo,
            detail: `Not delivered after ${c.attempts + 1} tries in a day. Last error: ${r.error}`,
          })
        }
      })
      ctx.log.warn({ reference: c.reference, error: r.error, attempts: c.attempts + 1 }, 'credit not delivered yet; retrying')
      pass.retrying += 1
    }
  }
  return pass
}
