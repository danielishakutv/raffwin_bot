/**
 * Maker-checker. A sensitive action is stored as a pending approval; it runs
 * only when a different admin with approvals.decide approves it, inside the
 * same transaction that marks it approved. The database also refuses
 * decided_by = requested_by (approvals_two_people).
 */
import { desc, eq, inArray, sql } from 'drizzle-orm'
import type { AdminApproval } from '@raffwin/shared/admin-types'
import type { AppContext } from '../context'
import { adminUsers, approvals, APPROVAL_ACTIONS, entries, raffles, referralEarnings, users } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { post, type Tx } from '../services/ledger'
import { stopDrawReminders } from '../services/draw-reminders'
import { createBatch } from '../services/vouchers'
import { enqueue, openAppButton } from '../services/notify'
import { putSetting, type RateSettings, type SalesSettings } from '../services/settings'
import { appendAudit } from './audit'
import { announceRaffleCancelled } from './messages'
import { can } from './permissions'
import { applyRisk, isRiskAction, tellRiskDecision } from './risk'

const EXPIRY_HOURS = 72
type Action = (typeof APPROVAL_ACTIONS)[number]

export interface Payloads {
  rate_base_change: { rate: RateSettings; previous: RateSettings }
  sales_options_change: { sales: SalesSettings; previous: SalesSettings }
  voucher_batch_create: { vendor: string; note: string; valueRaffs: number; count: number; expiresAt: string | null }
  balance_adjustment: { userId: string; username: string | null; raffs: number }
  /** The same signed amount for every player listed; applied to all of them or none */
  balance_adjustment_bulk: { users: { userId: string; username: string | null }[]; raffs: number }
  raffle_cancel: { raffleId: string; prizeName: string; entriesCount: number }
  /** As it stood when asked; execute reads it again and refunds only if it is still open */
  raffle_delete: { raffleId: string; prizeName: string; status: string; entriesCount: number }
  admin_risk_flag: { adminId: string; name: string }
  admin_risk_clear: { adminId: string; name: string }
}

export function summarise(action: Action, payload: Record<string, unknown>): string {
  switch (action) {
    case 'rate_base_change': {
      const p = payload as unknown as Payloads['rate_base_change']
      // Asked for before 19 Oct, in Stars: it can only be rejected (execute refuses it)
      if (!p.rate) return 'Change the base rate in Stars (no longer used: reject this and ask again in naira)'
      return `Change the rate from ${rateText(p.previous)} to ${rateText(p.rate)}`
    }
    case 'sales_options_change': {
      const p = payload as unknown as Payloads['sales_options_change']
      return `Change sales options to ${salesText(p.sales)} (was ${salesText(p.previous)})`
    }
    case 'voucher_batch_create': {
      const p = payload as unknown as Payloads['voucher_batch_create']
      const total = (p.valueRaffs * p.count).toLocaleString('en-NG')
      const until = p.expiresAt ? `, valid until ${p.expiresAt.slice(0, 10)}` : ''
      return `${p.count.toLocaleString('en-NG')} voucher codes of ${p.valueRaffs.toLocaleString('en-NG')} Raffs for ${p.vendor} (${total} Raffs in all${until})`
    }
    case 'balance_adjustment': {
      const p = payload as unknown as Payloads['balance_adjustment']
      return `${p.raffs > 0 ? 'Credit' : 'Debit'} ${Math.abs(p.raffs).toLocaleString('en-NG')} Raffs ${p.raffs > 0 ? 'to' : 'from'} @${p.username ?? p.userId}`
    }
    case 'balance_adjustment_bulk': {
      const p = payload as unknown as Payloads['balance_adjustment_bulk']
      const n = p.users.length
      const each = Math.abs(p.raffs).toLocaleString('en-NG')
      const total = (Math.abs(p.raffs) * n).toLocaleString('en-NG')
      const names = p.users.slice(0, 5).map((u) => `@${u.username ?? u.userId}`).join(', ')
      const more = n > 5 ? ` and ${(n - 5).toLocaleString('en-NG')} more` : ''
      return `${p.raffs > 0 ? 'Credit' : 'Debit'} ${each} Raffs each ${p.raffs > 0 ? 'to' : 'from'} ${n.toLocaleString('en-NG')} player${n === 1 ? '' : 's'} (${total} Raffs in all): ${names}${more}`
    }
    case 'raffle_cancel': {
      const p = payload as unknown as Payloads['raffle_cancel']
      return `Cancel "${p.prizeName}" and refund ${p.entriesCount} entr${p.entriesCount === 1 ? 'y' : 'ies'}`
    }
    case 'raffle_delete': {
      const p = payload as unknown as Payloads['raffle_delete']
      const refund = p.status === 'open' && p.entriesCount > 0
      return refund
        ? `Delete "${p.prizeName}" and refund ${p.entriesCount} entr${p.entriesCount === 1 ? 'y' : 'ies'}`
        : `Delete "${p.prizeName}" (${p.status}); its history is kept`
    }
    case 'admin_risk_flag': {
      const p = payload as unknown as Payloads['admin_risk_flag']
      return `Mark ${p.name} at risk: signed out everywhere, trusted devices removed, full checks on every sign-in`
    }
    case 'admin_risk_clear': {
      const p = payload as unknown as Payloads['admin_risk_clear']
      return `Clear the at-risk mark on ${p.name}`
    }
  }
}

const naira = (n: number) => `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`
function rateText(r: RateSettings): string {
  const move = r.moveMaxPct === 0 ? 'fixed' : `moving ${r.moveMinPct}-${r.moveMaxPct}% an hour`
  return `${naira(r.nairaPerRaffKobo / 100)} per Raff, ${move}`
}
function salesText(s: SalesSettings): string {
  const packs = s.packages.map((p) => `${naira(p.naira)}${p.bonusPercent ? ` +${p.bonusPercent}%` : ''}`).join(', ')
  return `packages ${packs || 'none'}; ${naira(s.minNaira)} to ${naira(s.maxNaira)}`
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

/**
 * A super admin's version of requestApproval: the action runs at once, in one
 * transaction, and is still written to the approvals history (status
 * approved, no second admin) and the audit log as done directly.
 */
export async function executeDirect<A extends Action>(
  ctx: AppContext,
  adminId: string,
  action: A,
  payload: Payloads[A],
  reason: string,
): Promise<AdminApproval> {
  // Two admins, always: there is no one-person path to mark an admin at risk or clear it
  if (isRiskAction(action)) throw new HttpError('FORBIDDEN', 'This needs a second admin to agree.')
  let id: string
  try {
    id = await ctx.db.transaction(async (tx) => {
      const result = await execute(ctx, tx, action, payload as never, adminId, new Date(ctx.now()))
      const [row] = await tx
        .insert(approvals)
        .values({
          action,
          payload,
          reason,
          status: 'approved',
          requestedByAdminId: adminId,
          decidedAt: new Date(ctx.now()),
          result: { ...result, direct: true },
          expiresAt: new Date(ctx.now()),
        })
        .returning({ id: approvals.id })
      if (!row) throw new Error('approval insert returned no row')
      await appendAudit(tx, {
        adminId,
        action: `direct.${action}`,
        targetType: 'approval',
        targetId: row.id,
        after: { payload, reason, result },
      })
      return row.id
    })
  } catch (error) {
    if (error instanceof HttpError) throw error
    const message = error instanceof Error ? error.message : String(error)
    ctx.log.error({ err: error, action }, 'direct action failed')
    throw new HttpError('INVALID_INPUT', `That did not work: ${message}`)
  }
  return (await listApprovals(ctx, { id }))[0] as AdminApproval
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
    requestedByAdminId: a.requestedByAdminId,
    decidedBy: decidedBy ?? (a.status === 'approved' ? 'done directly (super admin)' : null),
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
  if (!decider || decider.status !== 'active') throw new HttpError('FORBIDDEN', 'Your role cannot decide approvals.')

  let decided: { action: Action; payload: Record<string, unknown>; approved: boolean } | null = null
  try {
    await ctx.db.transaction(async (tx) => {
      const [a] = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).for('update')
      if (!a) throw new HttpError('NOT_FOUND', 'No such approval.')
      // Marking an admin at risk (or clearing it) is agreed by any second admin, never by the one it is about
      if (isRiskAction(a.action)) {
        if ((a.payload as { adminId?: string }).adminId === deciderId) {
          throw new HttpError('FORBIDDEN', 'Two other admins decide this; it is about you.')
        }
      } else if (!can(decider.role, 'approvals.decide')) {
        throw new HttpError('FORBIDDEN', 'Your role cannot decide approvals.')
      }
      if (a.status !== 'pending') throw new HttpError('INVALID_INPUT', `This request is already ${a.status}.`)
      if (a.expiresAt.getTime() <= ctx.now()) throw new HttpError('INVALID_INPUT', 'This request has expired. Ask for it again.')
      if (a.requestedByAdminId === deciderId) {
        throw new HttpError('FORBIDDEN', 'A second admin has to decide this; you asked for it.')
      }
      const result = verdict === 'approve' ? await execute(ctx, tx, a.action, a.payload as never, deciderId, new Date(ctx.now()), a.reason, { approvalId: a.id, requesterId: a.requestedByAdminId }) : null
      decided = { action: a.action, payload: a.payload as Record<string, unknown>, approved: verdict === 'approve' }
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
  const done = decided as { action: Action; payload: Record<string, unknown>; approved: boolean } | null
  if (done?.approved && isRiskAction(done.action)) await tellRiskDecision(ctx, done.action, String(done.payload.adminId))
  return (await listApprovals(ctx, { id: approvalId }))[0] as AdminApproval
}

async function execute(
  ctx: AppContext,
  tx: Tx,
  action: Action,
  payload: Payloads[Action],
  adminId: string,
  at: Date,
  reason = '',
  /** The approval being carried out (null when a super admin acts directly) and who asked for it */
  origin: { approvalId: string | null; requesterId: string } = { approvalId: null, requesterId: adminId },
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'rate_base_change': {
      const p = payload as Payloads['rate_base_change']
      if (!p.rate) throw new HttpError('NOT_READY', 'This was asked for in Stars, which are no longer used. Reject it and ask again in naira.')
      await putSetting(tx, 'rate.base_naira_per_raff_kobo', p.rate.nairaPerRaffKobo, adminId)
      await putSetting(tx, 'rate.move_min_pct', p.rate.moveMinPct, adminId)
      await putSetting(tx, 'rate.move_max_pct', p.rate.moveMaxPct, adminId)
      // The new base applies from the next hourly quote; the current hour's quote stands
      return { appliesFrom: 'next hour' }
    }
    case 'voucher_batch_create': {
      const p = payload as Payloads['voucher_batch_create']
      const batchId = await createBatch(tx, { ...p, requestedByAdminId: origin.requesterId, approvalId: origin.approvalId })
      return { batchId, next: 'Issue the codes from the Vouchers tab: they are shown once.' }
    }
    case 'sales_options_change': {
      const p = payload as Payloads['sales_options_change']
      await putSetting(tx, 'sales.packages', p.sales.packages, adminId)
      await putSetting(tx, 'sales.min_naira', p.sales.minNaira, adminId)
      await putSetting(tx, 'sales.max_naira', p.sales.maxNaira, adminId)
      return { appliesFrom: 'now' }
    }
    case 'balance_adjustment': {
      const p = payload as Payloads['balance_adjustment']
      const [u] = await tx.select({ id: users.id, telegramId: users.telegramId }).from(users).where(eq(users.id, p.userId)).for('update')
      if (!u) throw new Error('user no longer exists')
      const row = await post(tx, {
        userId: p.userId,
        type: 'adjustment',
        raffs: p.raffs,
        note: p.raffs > 0 ? 'Credit from Raffle Win support' : 'Correction by Raffle Win support',
        referenceType: 'approval',
      })
      // A credit is announced by the bot, queued with the credit itself so one never lands without the other
      const told = p.raffs > 0 ? await tellCredit(ctx, tx, u, p.raffs, row.id, row.balanceAfter) : false
      return { ledgerId: row.id, balanceAfter: row.balanceAfter, playerTold: told }
    }
    case 'balance_adjustment_bulk': {
      const p = payload as Payloads['balance_adjustment_bulk']
      return bulkAdjust(ctx, tx, p)
    }
    case 'raffle_cancel': {
      const p = payload as Payloads['raffle_cancel']
      return cancelRaffle(tx, p.raffleId, adminId, at)
    }
    case 'raffle_delete': {
      const p = payload as Payloads['raffle_delete']
      return deleteRaffle(tx, p.raffleId, adminId, at)
    }
    case 'admin_risk_flag':
    case 'admin_risk_clear': {
      const p = payload as Payloads['admin_risk_flag']
      return applyRisk(tx, action, p.adminId, reason, at)
    }
  }
}

/**
 * One amount for many players, in one transaction: every player gets it or
 * nobody does. Users are locked in id order (the order cancelRaffle uses) so
 * this cannot deadlock with a refund. A debit never takes anyone below zero;
 * it is refused naming who is short, and nothing changes.
 */
async function bulkAdjust(ctx: AppContext, tx: Tx, p: Payloads['balance_adjustment_bulk']): Promise<Record<string, unknown>> {
  const ids = [...new Set(p.users.map((u) => u.userId))].sort()
  const locked = await tx
    .select({ id: users.id, telegramId: users.telegramId, username: users.username, balance: users.balanceCache })
    .from(users)
    .where(inArray(users.id, ids))
    .orderBy(users.id)
    .for('update')
  if (locked.length !== ids.length) {
    throw new HttpError('NOT_FOUND', `${ids.length - locked.length} of the selected players no longer exist. Ask again without them.`)
  }
  if (p.raffs < 0) {
    const short = locked.filter((u) => u.balance + p.raffs < 0)
    if (short.length) {
      const names = short.slice(0, 10).map((u) => `@${u.username ?? u.id} (${u.balance.toLocaleString('en-NG')})`).join(', ')
      const more = short.length > 10 ? ` and ${short.length - 10} more` : ''
      throw new HttpError(
        'INSUFFICIENT_FUNDS',
        `${short.length} player${short.length === 1 ? ' has' : 's have'} less than ${Math.abs(p.raffs).toLocaleString('en-NG')} Raffs: ${names}${more}. Nothing was changed; take them off the list and ask again.`,
      )
    }
  }
  let told = 0
  for (const u of locked) {
    const row = await post(tx, {
      userId: u.id,
      type: 'adjustment',
      raffs: p.raffs,
      note: p.raffs > 0 ? 'Credit from Raffle Win support' : 'Correction by Raffle Win support',
      referenceType: 'approval',
    })
    if (p.raffs > 0 && (await tellCredit(ctx, tx, u, p.raffs, row.id, row.balanceAfter))) told += 1
  }
  return { players: locked.length, raffsEach: p.raffs, raffsTotal: p.raffs * locked.length, playersTold: told }
}

/** "You received 500 Raffs from Raffle Win", to the player's bot chat (sent by the outbox). */
async function tellCredit(ctx: AppContext, tx: Tx, user: { id: string; telegramId: number }, raffs: number, ledgerId: string, balance: number): Promise<boolean> {
  const amount = `${raffs.toLocaleString('en-NG')} ${raffs === 1 ? 'Raff' : 'Raffs'}`
  const button = openAppButton(ctx, 'Open my wallet', 'wallet')
  const queued = await enqueue(tx, {
    userId: user.id,
    telegramId: user.telegramId,
    kind: 'credit',
    text: `<b>You received ${amount} from Raffle Win</b>\n\nThey are already in your balance, which is now ${balance.toLocaleString('en-NG')} Raffs. Use them to enter a raffle.`,
    buttons: button ? [[button]] : null,
    dedupeKey: `credit:${ledgerId}`,
  })
  return queued === 'queued'
}

/**
 * Cancels a raffle and refunds every entry in full. The referrer's 10% on
 * each refunded entry is reversed. Lock order: raffle, then users by id.
 * In the same transaction, the bot is told to message every entrant that the
 * raffle was cancelled and their Raffs refunded (and its new-raffle alert stops).
 * `notReached` = the draw found too few entries (services/draw.ts, no admin):
 * the refund lines and the message say so instead of "was cancelled".
 */
export async function cancelRaffle(
  tx: Tx,
  raffleId: string,
  adminId: string | null,
  at: Date,
  notReached?: { sold: number; need: number },
): Promise<Record<string, unknown>> {
  const why = notReached ? `did not reach ${notReached.need} entries` : 'was cancelled'
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
      note: `Refund: ${raffle.prizeName} ${why}`,
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
      note: `Referral reversed: ${raffle.prizeName} ${why}`,
      referenceType: 'entry',
      referenceId: r.entryId,
    })
    await tx.update(referralEarnings).set({ reversedAt: sql`now()`, reversalLedgerId: row.id }).where(eq(referralEarnings.id, r.id))
    reversed += r.raffs
  }
  await tx.update(raffles).set({ status: 'cancelled', cancelledAt: sql`now()`, updatedAt: sql`now()` }).where(eq(raffles.id, raffleId))
  await stopDrawReminders(tx, raffleId, at)
  const entrants = [...new Set(list.map((e) => e.userId))]
  const broadcastId = await announceRaffleCancelled(tx, raffle, entrants, adminId, at, notReached)
  return { entriesRefunded: list.length, raffsRefunded: refunded, referralRaffsReversed: reversed, playersNotified: broadcastId ? entrants.length : 0 }
}

/**
 * Deletes a raffle from the admin list and the public raffles, keeping every
 * row behind it (raffles_no_delete refuses a real DELETE). A raffle still open
 * for entries is first cancelled with cancelRaffle, so every entry is refunded
 * in full and the entrants told by the bot; drafts, drawn and cancelled raffles
 * are only marked. Past its deadline an open raffle belongs to the draw, so it
 * is refused until the draw has settled it.
 */
export async function deleteRaffle(tx: Tx, raffleId: string, adminId: string | null, at: Date): Promise<Record<string, unknown>> {
  const [raffle] = await tx.select().from(raffles).where(eq(raffles.id, raffleId)).for('update')
  if (!raffle) throw new HttpError('NOT_FOUND', 'No such raffle.')
  if (raffle.deletedAt) throw new HttpError('INVALID_INPUT', 'This raffle is already deleted.')
  if (raffle.status === 'drawing' || (raffle.status === 'open' && raffle.deadline.getTime() <= at.getTime())) {
    throw new HttpError('INVALID_INPUT', 'Entries have closed and the draw is running. Delete it once it has been drawn or refunded.')
  }
  const refund = raffle.status === 'open' ? await cancelRaffle(tx, raffleId, adminId, at) : null
  await tx.update(raffles).set({ deletedAt: at, deletedByAdminId: adminId, updatedAt: sql`now()` }).where(eq(raffles.id, raffleId))
  return { statusBefore: raffle.status, ...(refund ?? { entriesRefunded: 0, raffsRefunded: 0 }) }
}
