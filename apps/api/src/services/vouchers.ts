/**
 * Voucher codes sold offline (decision of 19 Oct). Raffs are not sold inside
 * the Mini App; a player who bought a code from a vendor types it under
 * Wallet > Redeem a code.
 *
 *   a code     16 characters from VOUCHER_ALPHABET (no 0/O, 1/I), shown as
 *              XXXX-XXXX-XXXX-XXXX: 80 random bits. Stored as SHA-256 only.
 *   a batch    one vendor, one value, up to 5,000 codes, an optional expiry.
 *              Asked for by one admin, approved by another (approvals.ts);
 *              its codes are generated and handed over exactly once.
 *   redeeming  single use, under the code's row lock. Every failed attempt is
 *              a security event, and MAX_WRONG_PER_HOUR of them stop the
 *              player for an hour (the route also limits per address).
 */
import { randomInt } from 'node:crypto'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { AppContext } from '../context'
import { securityEvents, users, voucherBatches, vouchers } from '../db/schema'
import { sha256Hex } from '../lib/crypto'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'
import type { RequestMeta } from '../context'
import { requireFeature } from './features'
import { post, type Tx } from './ledger'
import { tellReferrerTopUp } from './referral-notices'

export const VOUCHER_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const VOUCHER_LENGTH = 16
export const MAX_WRONG_PER_HOUR = 5
export const MAX_BATCH = 5000

export function generateCode(): string {
  let code = ''
  for (let i = 0; i < VOUCHER_LENGTH; i++) code += VOUCHER_ALPHABET[randomInt(VOUCHER_ALPHABET.length)]
  return code
}

/** XXXX-XXXX-XXXX-XXXX */
export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code
}

/** What a player typed, as stored: capitals, no spaces or dashes. Null when it cannot be a code. */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== VOUCHER_LENGTH) return null
  for (const ch of code) if (!VOUCHER_ALPHABET.includes(ch)) return null
  return code
}

export const hashCode = (normalized: string) => sha256Hex(`voucher:${normalized}`)

/* Redeeming ------------------------------------------------------------------ */

type Wrong = 'not_a_code' | 'unknown' | 'used' | 'void' | 'expired'

const WRONG_MESSAGE: Record<Wrong, string> = {
  not_a_code: 'That is not a code. Codes have 16 letters and numbers, like ABCD-EFGH-JKLM-NPQR.',
  unknown: 'That code is not valid. Check it letter by letter and try again.',
  used: 'That code has already been used.',
  void: 'That code is not valid. Check it letter by letter and try again.',
  expired: 'That code has expired.',
}

async function wrongLastHour(ctx: AppContext, userId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(securityEvents)
    .where(and(eq(securityEvents.kind, 'voucher_wrong'), eq(securityEvents.userId, userId), gte(securityEvents.occurredAt, new Date(ctx.now() - 3_600_000))))
  return row?.n ?? 0
}

export async function redeemVoucher(ctx: AppContext, userId: string, input: string, meta: RequestMeta): Promise<{ raffs: number; balance: number; transactionId: string }> {
  await requireFeature(ctx.db, 'vouchers', userId)
  if ((await wrongLastHour(ctx, userId)) >= MAX_WRONG_PER_HOUR) {
    throw new HttpError('LIMIT_REACHED', 'Too many wrong codes. Wait an hour and try again.')
  }

  const wrong = async (why: Wrong, tail: string | null): Promise<never> => {
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: 'low',
      category: 'fraud',
      kind: 'voucher_wrong',
      ipHash: meta.ipHash,
      route: meta.route,
      userId,
      requestId: meta.requestId,
      // Never the code: only why it failed and, for a real code, its last 4
      details: { why, tail },
      actionTaken: 'blocked',
    })
    throw new HttpError('INVALID_INPUT', WRONG_MESSAGE[why])
  }

  const code = normalizeCode(input)
  if (!code) return wrong('not_a_code', null)

  const at = new Date(ctx.now())
  const refused = (why: Wrong) => ({ ok: false as const, why })
  const outcome = await ctx.db.transaction(async (tx) => {
    const [v] = await tx
      .select({ v: vouchers, batch: voucherBatches })
      .from(vouchers)
      .innerJoin(voucherBatches, eq(voucherBatches.id, vouchers.batchId))
      .where(eq(vouchers.codeHash, hashCode(code)))
      .for('update', { of: vouchers })
    if (!v) return refused('unknown')
    if (v.v.status === 'redeemed') return refused('used')
    if (v.v.status === 'void' || v.batch.voidedAt) return refused('void')
    if (v.batch.expiresAt && v.batch.expiresAt.getTime() <= at.getTime()) return refused('expired')

    const entry = await post(tx, {
      userId,
      type: 'voucher',
      raffs: v.batch.valueRaffs,
      note: `Voucher ...${v.v.codeTail}`,
      referenceType: 'voucher',
      referenceId: v.v.id,
    })
    await tx
      .update(vouchers)
      .set({ status: 'redeemed', redeemedByUserId: userId, redeemedAt: at, ledgerId: entry.id })
      .where(eq(vouchers.id, v.v.id))
    const [player] = await tx
      .select({ id: users.id, username: users.username, fullName: users.fullName, tgFirstName: users.tgFirstName, referredByUserId: users.referredByUserId })
      .from(users)
      .where(eq(users.id, userId))
    if (player) await tellReferrerTopUp(ctx, tx, player, v.batch.valueRaffs, `voucher:${v.v.id}`)
    return { ok: true as const, raffs: v.batch.valueRaffs, balance: entry.balanceAfter, transactionId: entry.id }
  })
  if (!outcome.ok) return wrong(outcome.why, code.slice(-4))
  ctx.log.info({ userId, raffs: outcome.raffs }, 'voucher redeemed')
  return { raffs: outcome.raffs, balance: outcome.balance, transactionId: outcome.transactionId }
}

/* Admin ------------------------------------------------------------------------ */

/** Inside the approval that created the batch. The codes do not exist yet. */
export async function createBatch(
  tx: Tx,
  input: { vendor: string; note: string; valueRaffs: number; count: number; expiresAt: string | null; requestedByAdminId: string; approvalId: string | null },
): Promise<string> {
  const [row] = await tx
    .insert(voucherBatches)
    .values({
      vendor: input.vendor,
      note: input.note,
      valueRaffs: input.valueRaffs,
      codeCount: input.count,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      requestedByAdminId: input.requestedByAdminId,
      approvalId: input.approvalId,
    })
    .returning({ id: voucherBatches.id })
  if (!row) throw new Error('voucher batch insert returned no row')
  return row.id
}

/**
 * Generates the batch's codes and returns them, once. A second call finds the
 * batch already issued and refuses: there is no way to see a code again, so a
 * lost list means voiding the batch and asking for a new one.
 */
export async function issueCodes(ctx: AppContext, batchId: string, adminId: string): Promise<{ codes: string[]; batch: { vendor: string; valueRaffs: number; expiresAt: string | null } }> {
  return ctx.db.transaction(async (tx) => {
    const [batch] = await tx
      .update(voucherBatches)
      .set({ codesIssuedAt: sql`now()`, codesIssuedByAdminId: adminId })
      .where(and(eq(voucherBatches.id, batchId), sql`${voucherBatches.codesIssuedAt} is null`, sql`${voucherBatches.voidedAt} is null`))
      .returning()
    if (!batch) {
      const [exists] = await tx.select().from(voucherBatches).where(eq(voucherBatches.id, batchId))
      if (!exists) throw new HttpError('NOT_FOUND', 'No such batch.')
      if (exists.voidedAt) throw new HttpError('NOT_READY', 'This batch was voided.')
      throw new HttpError('ALREADY_CLAIMED', 'These codes were already handed out and cannot be shown again. Void the batch and ask for a new one if the list was lost.')
    }
    const codes = new Set<string>()
    while (codes.size < batch.codeCount) codes.add(generateCode())
    const list = [...codes]
    for (let i = 0; i < list.length; i += 500) {
      await tx.insert(vouchers).values(list.slice(i, i + 500).map((c) => ({ batchId, codeHash: hashCode(c), codeTail: c.slice(-4) })))
    }
    return {
      codes: list.map(formatCode),
      batch: { vendor: batch.vendor, valueRaffs: batch.valueRaffs, expiresAt: batch.expiresAt?.toISOString() ?? null },
    }
  })
}

export async function lookupCode(ctx: AppContext, input: string) {
  const code = normalizeCode(input)
  if (!code) throw new HttpError('INVALID_INPUT', 'That is not a code: 16 letters and numbers.')
  const [row] = await ctx.db
    .select({ v: vouchers, batch: voucherBatches, username: users.username, telegramId: users.telegramId })
    .from(vouchers)
    .innerJoin(voucherBatches, eq(voucherBatches.id, vouchers.batchId))
    .leftJoin(users, eq(users.id, vouchers.redeemedByUserId))
    .where(eq(vouchers.codeHash, hashCode(code)))
  if (!row) return { found: false as const }
  const expired = !!row.batch.expiresAt && row.batch.expiresAt.getTime() <= ctx.now()
  return {
    found: true as const,
    status: row.v.status === 'active' && (row.batch.voidedAt || expired) ? (row.batch.voidedAt ? 'void' : 'expired') : row.v.status,
    batchId: row.batch.id,
    vendor: row.batch.vendor,
    valueRaffs: row.batch.valueRaffs,
    expiresAt: row.batch.expiresAt?.toISOString() ?? null,
    redeemedAt: row.v.redeemedAt?.toISOString() ?? null,
    redeemedBy: row.v.redeemedByUserId ? { userId: row.v.redeemedByUserId, username: row.username, telegramId: row.telegramId } : null,
  }
}

export async function voidCode(ctx: AppContext, input: string, adminId: string): Promise<{ voided: boolean; tail: string }> {
  const code = normalizeCode(input)
  if (!code) throw new HttpError('INVALID_INPUT', 'That is not a code: 16 letters and numbers.')
  const rows = await ctx.db
    .update(vouchers)
    .set({ status: 'void', voidedAt: sql`now()`, voidedByAdminId: adminId })
    .where(and(eq(vouchers.codeHash, hashCode(code)), eq(vouchers.status, 'active')))
    .returning({ id: vouchers.id })
  if (!rows.length) {
    const found = await lookupCode(ctx, code)
    if (!found.found) throw new HttpError('NOT_FOUND', 'No such code.')
    throw new HttpError('NOT_READY', `This code is ${found.status} and cannot be voided.`)
  }
  return { voided: true, tail: code.slice(-4) }
}

export async function voidBatch(ctx: AppContext, batchId: string, adminId: string, reason: string): Promise<{ codesVoided: number }> {
  return ctx.db.transaction(async (tx) => {
    const [batch] = await tx
      .update(voucherBatches)
      .set({ voidedAt: sql`now()`, voidedByAdminId: adminId, voidReason: reason })
      .where(and(eq(voucherBatches.id, batchId), sql`${voucherBatches.voidedAt} is null`))
      .returning({ id: voucherBatches.id })
    if (!batch) throw new HttpError('NOT_READY', 'No such batch, or it is already voided.')
    // Redeemed codes keep their history; only unused ones are voided
    const voided = await tx
      .update(vouchers)
      .set({ status: 'void', voidedAt: sql`now()`, voidedByAdminId: adminId })
      .where(and(eq(vouchers.batchId, batchId), eq(vouchers.status, 'active')))
      .returning({ id: vouchers.id })
    return { codesVoided: voided.length }
  })
}

export async function listBatches(ctx: AppContext) {
  const rows = await ctx.db
    .select({
      b: voucherBatches,
      redeemed: sql<number>`(select count(*)::int from ${vouchers} v where v.batch_id = ${voucherBatches.id} and v.status = 'redeemed')`,
      voided: sql<number>`(select count(*)::int from ${vouchers} v where v.batch_id = ${voucherBatches.id} and v.status = 'void')`,
    })
    .from(voucherBatches)
    .orderBy(sql`${voucherBatches.createdAt} desc`)
    .limit(200)
  const now = ctx.now()
  return rows.map(({ b, redeemed, voided }) => ({
    id: b.id,
    vendor: b.vendor,
    note: b.note,
    valueRaffs: b.valueRaffs,
    count: b.codeCount,
    redeemed,
    voided,
    expiresAt: b.expiresAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
    codesIssuedAt: b.codesIssuedAt?.toISOString() ?? null,
    voidedAt: b.voidedAt?.toISOString() ?? null,
    voidReason: b.voidReason,
    status: b.voidedAt ? ('void' as const) : !b.codesIssuedAt ? ('ready' as const) : b.expiresAt && b.expiresAt.getTime() <= now ? ('expired' as const) : ('issued' as const),
  }))
}
