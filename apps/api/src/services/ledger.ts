/**
 * The only way Raffs move. Each call writes one ledger row and moves
 * users.balance_cache by the same amount in the same statement order, inside
 * the caller's transaction. A nightly check compares SUM(ledger) with the cache.
 */
import { desc, eq, sql } from 'drizzle-orm'
import type { Transaction as UiTransaction } from '@raffwin/shared'
import type { Db } from '../db/client'
import { ledger, users, type LedgerRow } from '../db/schema'

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface Posting {
  userId: string
  type: LedgerRow['type']
  raffs: number
  note: string
  stars?: number | null
  referenceType?: string
  referenceId?: string
}

export async function post(tx: Tx, p: Posting): Promise<LedgerRow> {
  if (!Number.isInteger(p.raffs) || p.raffs === 0) throw new Error(`ledger posting must be a non-zero integer, got ${p.raffs}`)
  const [user] = await tx
    .update(users)
    .set({ balanceCache: sql`${users.balanceCache} + ${p.raffs}`, updatedAt: sql`now()` })
    .where(eq(users.id, p.userId))
    .returning({ balance: users.balanceCache })
  if (!user) throw new Error(`ledger posting for unknown user ${p.userId}`)
  const [row] = await tx
    .insert(ledger)
    .values({
      userId: p.userId,
      type: p.type,
      raffs: p.raffs,
      stars: p.stars ?? null,
      referenceType: p.referenceType ?? null,
      referenceId: p.referenceId ?? null,
      note: p.note,
      balanceAfter: user.balance,
    })
    .returning()
  if (!row) throw new Error('ledger insert returned no row')
  return row
}

export function toTransaction(row: LedgerRow): UiTransaction {
  return {
    id: row.id,
    type: row.type,
    raffs: row.raffs,
    naira: null,
    stars: row.stars,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    status: 'completed',
  }
}

export async function recentTransactions(db: Db, userId: string, limit = 200): Promise<UiTransaction[]> {
  const rows = await db.select().from(ledger).where(eq(ledger.userId, userId)).orderBy(desc(ledger.createdAt)).limit(limit)
  return rows.map(toTransaction)
}
