/**
 * Records rejected and suspicious requests (docs/ARCHITECTURE.md section 9).
 * Recording must never turn a rejection into a 500, so a failed insert is
 * logged at error level with the event attached, never swallowed.
 */
import type { Logger } from 'pino'
import type { Db } from '../db/client'
import { securityEvents } from '../db/schema'

type NewEvent = typeof securityEvents.$inferInsert

export interface SecurityEventInput {
  severity: NewEvent['severity']
  category: NewEvent['category']
  kind: string
  ipHash: string | null
  route: string
  userId?: string | null
  requestId?: string
  details?: Record<string, unknown>
  actionTaken?: NewEvent['actionTaken']
}

export async function recordSecurityEvent(db: Db, log: Logger, event: SecurityEventInput): Promise<void> {
  const row: NewEvent = {
    severity: event.severity,
    category: event.category,
    kind: event.kind,
    fingerprint: `${event.ipHash ?? 'noip'}:${event.category}:${event.route}`,
    ipHash: event.ipHash,
    userId: event.userId ?? null,
    route: event.route,
    requestId: event.requestId,
    details: event.details ?? {},
    actionTaken: event.actionTaken ?? 'none',
  }
  log.warn({ securityEvent: row }, `security event: ${event.kind}`)
  try {
    await db.insert(securityEvents).values(row)
  } catch (error) {
    log.error({ err: error, securityEvent: row }, 'could not store security event')
  }
}
