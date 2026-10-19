/**
 * Marking an admin account at risk (decision of 19 Oct). Any admin can ask,
 * whatever their role, but nothing happens until a second admin agrees: the
 * request is an approval (admin_risk_flag) that a different admin approves.
 * Neither of the two can be the admin concerned, and a super admin cannot do
 * it alone (there is no direct path for these two actions).
 *
 * Marked at risk:
 *   - every session of that admin ends and every trusted device is revoked;
 *   - no device can be trusted again, so every sign-in takes the full checks
 *     (master password, username, password, and the bot's ticket or code);
 *   - a super admin loses the longer idle limit and the kept session.
 * Clearing it (admin_risk_clear) takes two admins in the same way; devices
 * stay revoked and are trusted again only by a new full sign-in.
 */
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AdminApproval, AdminTeamMember } from '@raffwin/shared/admin-types'
import type { AppContext } from '../context'
import { adminSessions, adminUsers, approvals } from '../db/schema'
import { HttpError } from '../lib/http-error'
import type { Tx } from '../services/ledger'
import { listApprovals, requestApproval } from './approvals'
import { appendAudit } from './audit'
import { revokeAllDevices } from './devices'

export const RISK_ACTIONS = ['admin_risk_flag', 'admin_risk_clear'] as const
export type RiskAction = (typeof RISK_ACTIONS)[number]
export const isRiskAction = (action: string): action is RiskAction => (RISK_ACTIONS as readonly string[]).includes(action)

export const riskBody = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) })

/** The admins, as every admin may see them for this purpose: no secrets, no contact details. */
export async function team(ctx: AppContext, meId: string): Promise<AdminTeamMember[]> {
  const rows = await ctx.db
    .select({ id: adminUsers.id, name: adminUsers.name, role: adminUsers.role, status: adminUsers.status, riskFlaggedAt: adminUsers.riskFlaggedAt, riskReason: adminUsers.riskReason })
    .from(adminUsers)
    .orderBy(adminUsers.createdAt)
  const pending = (await listApprovals(ctx, { status: 'pending' })).filter((a) => isRiskAction(a.action) && Date.parse(a.expiresAt) > ctx.now())
  return rows.map((r) => {
    const p = pending.find((a) => (a.payload as { adminId?: string }).adminId === r.id) ?? null
    return {
      id: r.id,
      name: r.name,
      role: r.role,
      status: r.status,
      atRisk: r.riskFlaggedAt !== null,
      riskFlaggedAt: r.riskFlaggedAt?.toISOString() ?? null,
      riskReason: r.riskReason,
      isMe: r.id === meId,
      pending: p ? { approvalId: p.id, action: p.action as RiskAction, requestedBy: p.requestedBy, reason: p.reason, requestedByMe: p.requestedByAdminId === meId } : null,
    }
  })
}

/** First of the two admins: records the request. The second agrees in Approvals. */
export async function requestRisk(ctx: AppContext, byAdminId: string, targetId: string, action: RiskAction, reason: string): Promise<AdminApproval> {
  if (targetId === byAdminId) throw new HttpError('FORBIDDEN', 'Two other admins decide this; it cannot be asked for by the admin it is about.')
  const [target] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, targetId))
  if (!target) throw new HttpError('NOT_FOUND', 'No such admin.')
  if (action === 'admin_risk_flag' && target.riskFlaggedAt) throw new HttpError('INVALID_INPUT', `${target.name} is already marked at risk.`)
  if (action === 'admin_risk_clear' && !target.riskFlaggedAt) throw new HttpError('INVALID_INPUT', `${target.name} is not marked at risk.`)
  const [open] = await ctx.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.status, 'pending'),
        sql`${approvals.action} in ('admin_risk_flag', 'admin_risk_clear')`,
        sql`${approvals.payload}->>'adminId' = ${targetId}`,
        sql`${approvals.expiresAt} > ${new Date(ctx.now()).toISOString()}::timestamptz`,
      ),
    )
  if (open) throw new HttpError('INVALID_INPUT', `A request about ${target.name} is already waiting for a second admin in Approvals.`)
  return requestApproval(ctx, byAdminId, action, { adminId: target.id, name: target.name }, reason)
}

/** Runs inside the approving transaction (approvals.execute). */
export async function applyRisk(tx: Tx, action: RiskAction, targetId: string, reason: string, at: Date): Promise<Record<string, unknown>> {
  const [target] = await tx.select().from(adminUsers).where(eq(adminUsers.id, targetId)).for('update')
  if (!target) throw new Error('admin no longer exists')
  if (action === 'admin_risk_clear') {
    if (!target.riskFlaggedAt) throw new Error(`${target.name} is not marked at risk`)
    await tx.update(adminUsers).set({ riskFlaggedAt: null, riskReason: null, updatedAt: sql`now()` }).where(eq(adminUsers.id, targetId))
    return { cleared: true }
  }
  if (target.riskFlaggedAt) throw new Error(`${target.name} is already marked at risk`)
  await tx.update(adminUsers).set({ riskFlaggedAt: at, riskReason: reason, updatedAt: sql`now()` }).where(eq(adminUsers.id, targetId))
  const sessions = await tx
    .update(adminSessions)
    .set({ revokedAt: at })
    .where(and(eq(adminSessions.adminId, targetId), sql`${adminSessions.revokedAt} is null`))
    .returning({ id: adminSessions.id })
  const devices = await revokeAllDevices(tx, targetId, 'marked_at_risk', at)
  await appendAudit(tx, { adminId: null, action: 'admin.marked_at_risk', targetType: 'admin', targetId, after: { reason, sessionsEnded: sessions.length, devicesRevoked: devices } })
  return { sessionsEnded: sessions.length, devicesRevoked: devices }
}

/** After the decision commits: the admin concerned hears it from the bot (best effort, logged when it fails). */
export async function tellRiskDecision(ctx: AppContext, action: RiskAction, targetId: string): Promise<void> {
  const [target] = await ctx.db.select({ telegramId: adminUsers.telegramId }).from(adminUsers).where(eq(adminUsers.id, targetId))
  if (!target?.telegramId || !ctx.sendTelegram) return
  const text =
    action === 'admin_risk_flag'
      ? 'Two Raffle Win admins have marked your admin account at risk. You have been signed out everywhere and your trusted devices removed. Every sign-in now takes the full checks until two admins clear it. If you did not expect this, change your password after your next sign-in.'
      : 'Two Raffle Win admins have cleared the at-risk mark on your admin account. Sign in once with the full checks to trust a device again.'
  try {
    await ctx.sendTelegram(target.telegramId, text)
  } catch (error) {
    ctx.log.warn({ err: error, adminId: targetId, action }, 'could not tell the admin about the at-risk decision')
  }
}
