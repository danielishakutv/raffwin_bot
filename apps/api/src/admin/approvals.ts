/**
 * Maker-checker. A sensitive action is stored as a pending approval; it runs
 * only when a different admin with approvals.decide approves it, inside the
 * same transaction that marks it approved. The database also refuses
 * decided_by = requested_by (approvals_two_people).
 */
import { desc, eq, sql } from 'drizzle-orm'
import type { AdminApproval } from '@raffwin/shared/admin-types'
import type { AppContext } from '../context'
import { adminUsers, approvals, APPROVAL_ACTIONS, entries, raffles, referralEarnings, users } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { post, type Tx } from '../services/ledger'
import { putSetting } from '../services/settings'
import { appendAudit } from './audit'
import { can } from './permissions'

const EXPIRY_HOURS = 72
type Action = (typeof APPROVAL_ACTIONS)[number]

export interface Payloads {
  rate_base_change: { starsPerRaffMicro: number; previousMicro: number }
  balance_adjustment: { userId: string; username: string | null; raffs: number }
  raffle_cancel: { raffleId: string; prizeName: string; entriesCount: number }
}

export function summarise(action: Action, payload: Record<string, unknown>): string {
  switch (action) {
    case 'rate_base_change': {
      const p = payload as unknown as Payloads['rate_base_change']
      return `Change the base rate from ${p.previousMicro / 1e6} to ${p.starsPerRaffMicro / 1e6} Stars per Raff`
    }
    case 'balance_adjustment': {
      const p = payload as unknown as Payloads['balance_adjustment']
      return `${p.raffs > 0 ? 'Credit' : 'Debit'} ${Math.abs(p.raffs).toLocaleString('en-NG')} Raffs ${p.raffs > 0 ? 'to' : 'from'} @${p.username ?? p.userId}`
    }
    case 'raffle_cancel': {
      const p = payload as unknown as Payloads['raffle_cancel']
      return `Cancel "${p.prizeName}" and refund ${p.entriesCount} entr${p.entriesCount === 1 ? 'y' : 'ies'}`
    }
  }
}

export async function requestApproval<A extends Action>(
  ctx: AppContext,
  adminId: string,
  action: A,
  payload: Payloads[A],
  reason: string,
): Promise<AdminApproval> {
  const row = await ctx.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(approvals)
      .values({
        action,
        payload,
        reason,
        requestedByAdminId: adminId,
        expiresAt: new Date(ctx.now() + EXPIRY_HOURS * 3_600_000),
      })
      .returning()
    if (!created) throw new Error('approval insert returned no row')
    await appendAudit(tx, { adminId, action: `approval.request.${action}`, targetType: 'approval', targetId: created.id, after: { payload, reason } })
    return created
  })
  return (await listApprovals(ctx, { id: row.id }))[0] as AdminApproval
}

export async function listApprovals(ctx: AppContext, filter: { status?: string; id?: string } = {}): Promise<AdminApproval[]> {
  // Outer columns named explicitly (see referrals.people for why)
  const requester = sql<string>`(select a.name from ${adminUsers} a where a.id = "approvals"."requested_by_admin_id")`
  const decider = sql<string | null>`(select a.name from ${adminUsers} a where a.id = "approvals"."decided_by_admin_id")`
  const rows = await ctx.db
    .select({ a: approvals, requestedBy: requester, decidedBy: decider })
    .from(approvals)
    .where(
      filter.id
        ? eq(approvals.id, filter.id)
        : filter.status
          ? eq(approvals.status, filter.status as 'pending')
          : undefined,
    )
    .orderBy(desc(approvals.createdAt))
    .limit(200)
  return rows.map(({ a, requestedBy, decidedBy }) => ({
    id: a.id,
    action: a.action,
    summary: summarise(a.action, a.payload as Record<string, unknown>),
    payload: a.payload as Record<string, unknown>,
    reason: a.reason,
    status: a.status,
    requestedBy,
    decidedBy,
    decidedAt: a.decidedAt?.toISOString() ?? null,
    result: a.result,
    expiresAt: a.expiresAt.toISOString(),
    createdAt: a.createdAt.toISOString(),
  }))
}

export async function decide(
  ctx: AppContext,
  deciderId: string,
  approvalId: string,
  verdict: 'approve' | 'reject',
  note: string,
): Promise<AdminApproval> {
  const [decider] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, deciderId))
  if (!decider || !can(decider.role, 'approvals.decide')) throw new HttpError('FORBIDDEN', 'Your role cannot decide approvals.')

  try {
    await ctx.db.transaction(async (tx) => {
      const [a] = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).for('update')
      if (!a) throw new HttpError('NOT_FOUND', 'No such approval.')
      if (a.status !== 'pending') throw new HttpError('INVALID_INPUT', `This request is already ${a.status}.`)
      if (a.expiresAt.getTime() <= ctx.now()) throw new HttpError('INVALID_INPUT', 'This request has expired. Ask for it again.')
      if (a.requestedByAdminId === deciderId) {
        throw new HttpError('FORBIDDEN', 'A second admin has to decide this; you asked for it.')
      }
      const result = verdict === 'approve' ? await execute(tx, a.action, a.payload as never, deciderId) : null
      await tx
        .update(approvals)
        .set({
          status: verdict === 'approve' ? 'approved' : 'rejected',
          decidedByAdminId: deciderId,
          decidedAt: new Date(ctx.now()),
          result: verdict === 'approve' ? result : { note },
        })
        .where(eq(approvals.id, a.id))
      await appendAudit(tx, {
        adminId: deciderId,
        action: `approval.${verdict}.${a.action}`,
        targetType: 'approval',
        targetId: a.id,
        after: { result, note },
      })
    })
  } catch (error) {
    if (error instanceof HttpError) throw error
    // The action itself failed: record why on the approval, then report it
    const message = error instanceof Error ? error.message : String(error)
    ctx.log.error({ err: error, approvalId }, 'approved action failed')
    await ctx.db
      .update(approvals)
      .set({ status: 'failed', decidedByAdminId: deciderId, decidedAt: new Date(ctx.now()), result: { error: message } })
      .where(eq(approvals.id, approvalId))
    throw new HttpError('SERVER_ERROR', `The approved action failed: ${message}`)
  }
  return (await listApprovals(ctx, { id: approvalId }))[0] as AdminApproval
}

async function execute(tx: Tx, action: Action, payload: Payloads[Action], adminId: string): Promise<Record<string, unknown>> {
  switch (action) {
    case 'rate_base_change': {
      const p = payload as Payloads['rate_base_change']
      await putSetting(tx, 'rate.base_stars_per_raff_micro', p.starsPerRaffMicro, adminId)
      // The new base applies from the next hourly quote; the current hour's quote stands
      return { appliesFrom: 'next hour' }
    }
    case 'balance_adjustment': {
      const p = payload as Payloads['balance_adjustment']
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, p.userId)).for('update')
      if (!u) throw new Error('user no longer exists')
      const row = await post(tx, {
        userId: p.userId,
        type: 'adjustment',
        raffs: p.raffs,
        note: p.raffs > 0 ? 'Credit from Raffle Win support' : 'Correction by Raffle Win support',
        referenceType: 'approval',
      })
      return { ledgerId: row.id, balanceAfter: row.balanceAfter }
    }
    case 'raffle_cancel': {
      const p = payload as Payloads['raffle_cancel']
      return cancelRaffle(tx, p.raffleId)
    }
  }
}

/**
 * Cancels a raffle and refunds every entry in full. The referrer's 10% on
 * each refunded entry is reversed. Lock order: raffle, then users by id.
 */
async function cancelRaffle(tx: Tx, raffleId: string): Promise<Record<string, unknown>> {
  const [raffle] = await tx.select().from(raffles).where(eq(raffles.id, raffleId)).for('update')
  if (!raffle) throw new Error('raffle no longer exists')
  if (raffle.status === 'drawn' || raffle.status === 'cancelled') throw new Error(`raffle is already ${raffle.status}`)

  const list = await tx.select().from(entries).where(eq(entries.raffleId, raffleId))
  const earnings = await tx.select().from(referralEarnings).where(sql`${referralEarnings.entryId} in (select id from ${entries} where raffle_id = ${raffleId})`)
  const userIds = [...new Set([...list.map((e) => e.userId), ...earnings.map((r) => r.referrerUserId)])].sort()
  if (userIds.length) await tx.execute(sql`select id from ${users} where id in (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)}) order by id for update`)

  let refunded = 0
  for (const e of list) {
    await post(tx, {
      userId: e.userId,
      type: 'refund',
      raffs: e.raffsSpent,
      note: `Refund: ${raffle.prizeName} was cancelled`,
      referenceType: 'entry',
      referenceId: e.id,
    })
    refunded += e.raffsSpent
  }
  let reversed = 0
  for (const r of earnings.filter((x) => !x.reversedAt)) {
    const row = await post(tx, {
      userId: r.referrerUserId,
      type: 'referral_reversal',
      raffs: -r.raffs,
      note: `Referral reversed: ${raffle.prizeName} was cancelled`,
      referenceType: 'entry',
      referenceId: r.entryId,
    })
    await tx.update(referralEarnings).set({ reversedAt: sql`now()`, reversalLedgerId: row.id }).where(eq(referralEarnings.id, r.id))
    reversed += r.raffs
  }
  await tx.update(raffles).set({ status: 'cancelled', cancelledAt: sql`now()`, updatedAt: sql`now()` }).where(eq(raffles.id, raffleId))
  return { entriesRefunded: list.length, raffsRefunded: refunded, referralRaffsReversed: reversed }
}
