/**
 * Hash-chained audit log. Appends are serialised with a transaction-scoped
 * advisory lock, so seq is gapless and every row's prev_hash is the hash of
 * the row before it. verifyChain() recomputes the whole chain.
 */
import { asc, desc, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { Db } from '../db/client'
import { auditLog } from '../db/schema'
import type { Tx } from '../services/ledger'

const GENESIS = '0'.repeat(64)
/** Arbitrary constant naming the audit-log lock in pg_advisory_xact_lock */
const AUDIT_LOCK_KEY = 727_001

export interface AuditInput {
  adminId: string | null
  action: string
  targetType?: string
  targetId?: string
  before?: unknown
  after?: unknown
  ipHash?: string | null
}

/** Stable JSON: keys sorted at every level, so the hash does not depend on key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`
}

function rowHash(r: {
  seq: number
  adminId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  before: unknown
  after: unknown
  ipHash: string | null
  createdAt: Date
  prevHash: string
}): string {
  const body = canonical({
    seq: r.seq,
    adminId: r.adminId,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    before: r.before ?? null,
    after: r.after ?? null,
    ipHash: r.ipHash,
    createdAt: r.createdAt.toISOString(),
    prevHash: r.prevHash,
  })
  return createHash('sha256').update(body).digest('hex')
}

export async function appendAudit(tx: Tx, input: AuditInput): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`)
  const [last] = await tx.select({ seq: auditLog.seq, hash: auditLog.hash }).from(auditLog).orderBy(desc(auditLog.seq)).limit(1)
  // A JSON round trip makes what is hashed exactly what jsonb stores and returns
  const row = {
    seq: (last?.seq ?? 0) + 1,
    adminId: input.adminId,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    before: input.before === undefined ? null : JSON.parse(JSON.stringify(input.before)),
    after: input.after === undefined ? null : JSON.parse(JSON.stringify(input.after)),
    ipHash: input.ipHash ?? null,
    // Millisecond precision: the stored timestamptz must round-trip to the hashed value
    createdAt: new Date(Math.floor(Date.now())),
    prevHash: last?.hash ?? GENESIS,
  }
  await tx.insert(auditLog).values({ ...row, hash: rowHash(row) })
}

export interface ChainCheck {
  ok: boolean
  rows: number
  /** First seq whose hash or link does not match, if any */
  brokenAt: number | null
}

export async function verifyChain(db: Db): Promise<ChainCheck> {
  const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq))
  let prev = GENESIS
  let expectedSeq = 1
  for (const r of rows) {
    if (r.seq !== expectedSeq || r.prevHash !== prev || rowHash(r) !== r.hash) {
      return { ok: false, rows: rows.length, brokenAt: r.seq }
    }
    prev = r.hash
    expectedSeq += 1
  }
  return { ok: true, rows: rows.length, brokenAt: null }
}
