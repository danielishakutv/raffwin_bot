/**
 * Payments a person must settle. Saved here first (once per reference and
 * kind), then reported to the main API, whose admins are told by the bot;
 * reporting is retried like a credit until the main API has it.
 */
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm'
import type { FlagKind } from '@raffwin/relay'
import type { AppContext } from '../context'
import type { Db } from '../db/client'
import { flags } from '../db/schema'
import { backoffMs } from './outbox'

type Writer = Pick<Db, 'insert'>

/** `at` is the app's clock (ctx.now()): due times are always compared against it, never the database's */
export async function raiseFlag(db: Writer, at: number, f: { reference: string; kind: FlagKind; telegramId: number | null; nairaKobo: number | null; detail: string }): Promise<void> {
  await db
    .insert(flags)
    .values({ reference: f.reference, kind: f.kind, telegramId: f.telegramId, nairaKobo: f.nairaKobo, detail: f.detail.slice(0, 500), nextAttemptAt: new Date(at), createdAt: new Date(at) })
    .onConflictDoNothing({ target: [flags.reference, flags.kind] })
}

/** Reports what is due. Each flag is leased for two minutes, so two workers never send the same one at once. */
export async function reportFlags(ctx: AppContext, limit = 20): Promise<{ reported: number; failed: number }> {
  const now = new Date(ctx.now())
  const due = await ctx.db
    .select({ id: flags.id })
    .from(flags)
    .where(and(isNull(flags.reportedAt), lte(flags.nextAttemptAt, now)))
    .orderBy(asc(flags.nextAttemptAt))
    .limit(limit)
  const pass = { reported: 0, failed: 0 }
  for (const { id } of due) {
    const [f] = await ctx.db
      .update(flags)
      .set({ nextAttemptAt: new Date(ctx.now() + 120_000) })
      .where(and(eq(flags.id, id), isNull(flags.reportedAt), lte(flags.nextAttemptAt, now)))
      .returning()
    if (!f) continue
    const r = await ctx.mainApi.flag({ reference: f.reference, kind: f.kind as FlagKind, telegramId: f.telegramId, nairaKobo: f.nairaKobo, detail: f.detail })
    if (r.ok || r.refused) {
      // A refusal of a flag (a malformed one) will not change on retry; the flag stays here, readable
      await ctx.db.update(flags).set({ reportedAt: new Date(ctx.now()), lastError: r.ok ? null : `refused: ${r.refused}` }).where(eq(flags.id, f.id))
      if (!r.ok) ctx.log.error({ flag: f.kind, reference: f.reference, refused: r.refused }, 'main API refused a flag')
      pass.reported += 1
    } else {
      await ctx.db
        .update(flags)
        .set({ attempts: sql`${flags.attempts} + 1`, nextAttemptAt: new Date(ctx.now() + backoffMs(f.attempts + 1)), lastError: r.error })
        .where(eq(flags.id, f.id))
      ctx.log.warn({ flag: f.kind, reference: f.reference, error: r.error, attempts: f.attempts + 1 }, 'flag not reported yet')
      pass.failed += 1
    }
  }
  return pass
}
