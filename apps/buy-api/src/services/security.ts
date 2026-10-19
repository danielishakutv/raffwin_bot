/**
 * Refusals worth keeping: bad webhook signatures, bad logins, amount
 * mismatches, replays. A failed insert is logged, never swallowed, and never
 * turns the refusal into a 500.
 */
import type { AppContext } from '../context'
import { securityEvents } from '../db/schema'

export async function recordSecurity(
  ctx: AppContext,
  event: { kind: string; severity: 'low' | 'medium' | 'high'; ipHash: string | null; buyerId?: string | null; details?: Record<string, unknown> },
): Promise<void> {
  ctx.log.warn({ security: event }, `security event: ${event.kind}`)
  try {
    await ctx.db.insert(securityEvents).values({ kind: event.kind, severity: event.severity, ipHash: event.ipHash, buyerId: event.buyerId ?? null, details: event.details ?? {} })
  } catch (error) {
    ctx.log.error({ err: error, security: event }, 'could not store security event')
  }
}
