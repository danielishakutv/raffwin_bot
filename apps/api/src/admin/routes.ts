/**
 * /admin/v1 - served same-origin from the app host (Apache proxies
 * /admin/v1 to the API), so admin requests never cross origins.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import {
  adjustmentBody,
  decisionBody,
  expenseBody,
  limitsBody,
  raffleBody,
  rateBaseBody,
  reasonBody,
} from '@raffwin/shared/admin-schemas'
import { cursorQuery } from '@raffwin/shared/schemas'
import type { AdminMe } from '@raffwin/shared/admin-types'
import type { AppContext } from '../context'
import { eq } from 'drizzle-orm'
import { raffles, users } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { requestMeta } from '../http/middleware'
import { getSetting } from '../services/settings'
import { decide, executeDirect, listApprovals, requestApproval } from './approvals'
import { verifyChain } from './audit'
import * as ops from './operations'
import { permissionsOf } from './permissions'
import { adminOf, auditEveryRequest, exchangeTicket, idleMinutesFor, logout, requireAdmin, requirePermission, resumeSession } from './session'
import * as admins from './admins'
import * as finance from './finance'
import type { Period } from './finance'

const uuid = z.string().uuid()

function idParam(req: Request): string {
  const parsed = uuid.safeParse(req.params.id)
  if (!parsed.success) throw new HttpError('NOT_FOUND', 'Not found.')
  return parsed.data
}

function toMe(user: ReturnType<typeof adminOf>['user']): AdminMe {
  return { id: user.id, name: user.name, telegramId: user.telegramId, role: user.role, permissions: permissionsOf(user.role) }
}

function me(req: Request): AdminMe {
  return toMe(adminOf(req).user)
}

export function adminRoutes(ctx: AppContext): Router {
  const r = Router()
  const authed = requireAdmin(ctx)
  const perm = (p: Parameters<typeof requirePermission>[1]) => requirePermission(ctx, p)
  const adminId = (req: Request) => adminOf(req).user.id
  const isSuper = (req: Request) => adminOf(req).user.role === 'super_admin'
  /** Super admins act at once (still recorded); everyone else queues it for a second admin */
  const askOrRun = async <A extends Parameters<typeof requestApproval>[2]>(
    req: Request,
    res: import('express').Response,
    action: A,
    payload: Parameters<typeof requestApproval<A>>[3],
    reason: string,
  ) => {
    if (isSuper(req)) res.status(200).json(await executeDirect(ctx, adminId(req), action, payload, reason))
    else res.status(202).json(await requestApproval(ctx, adminId(req), action, payload, reason))
  }

  /* Session ---------------------------------------------------------------- */

  // Every admin request, reads included, goes to the audit log
  r.use(auditEveryRequest(ctx))

  // One-time ticket from the bot's admin sign-in + this Mini App's initData -> bearer token
  r.post('/auth/ticket', async (req, res) => {
    const { admin, token, expiresAt } = await exchangeTicket(ctx, req)
    res.json({ token, expiresAt, idleMinutes: idleMinutesFor(ctx, admin.role), admin: toMe(admin) })
  })
  // Reopened Mini App with a stored token: fresh initData from the bound account carries the session on
  r.post('/auth/resume', authed, async (req, res) => {
    const { expiresAt } = await resumeSession(ctx, req)
    const token = (req.get('authorization') ?? '').slice(7).trim()
    res.json({ token, expiresAt, idleMinutes: idleMinutesFor(ctx, adminOf(req).user.role), admin: me(req) })
  })
  r.post('/auth/logout', authed, async (req, res) => {
    await logout(ctx, req)
    res.status(204).end()
  })
  r.get('/me', authed, (req, res) => {
    res.json(me(req))
  })
  // Change your own password: the current one is required; your other sessions end
  r.post('/me/password', authed, async (req, res) => {
    await admins.changeOwnPassword(ctx, adminOf(req).user.id, adminOf(req).sessionId, admins.passwordBody.parse(req.body))
    res.json({ ok: true })
  })

  /* Overview --------------------------------------------------------------- */

  r.get('/overview', authed, perm('overview.read'), async (_req, res) => {
    res.json(await ops.overview(ctx))
  })

  /* Raffles ---------------------------------------------------------------- */

  r.get('/raffles', authed, perm('raffles.read'), async (req, res) => {
    const status = z.enum(['draft', 'open', 'drawing', 'drawn', 'cancelled']).optional().parse(req.query.status || undefined)
    res.json(await ops.listRaffles(ctx, status))
  })
  r.get('/raffles/:id', authed, perm('raffles.read'), async (req, res) => {
    res.json(await ops.getRaffle(ctx, idParam(req)))
  })
  r.post('/raffles', authed, perm('raffles.write'), async (req, res) => {
    res.status(201).json(await ops.createRaffle(ctx, adminId(req), raffleBody.parse(req.body)))
  })
  r.put('/raffles/:id', authed, perm('raffles.write'), async (req, res) => {
    res.json(await ops.updateRaffle(ctx, adminId(req), idParam(req), raffleBody.parse(req.body), isSuper(req)))
  })
  r.post('/raffles/:id/open', authed, perm('raffles.write'), async (req, res) => {
    res.json(await ops.openRaffle(ctx, adminId(req), idParam(req)))
  })
  // Back to draft (hidden from players); only while nobody has entered
  r.post('/raffles/:id/unpublish', authed, perm('raffles.write'), async (req, res) => {
    const { reason } = reasonBody.parse(req.body)
    res.json(await ops.unpublishRaffle(ctx, adminId(req), idParam(req), reason))
  })
  r.post('/raffles/:id/cancel', authed, perm('raffles.cancel.request'), async (req, res) => {
    const { reason } = reasonBody.parse(req.body)
    const id = idParam(req)
    const [raffle] = await ctx.db.select().from(raffles).where(eq(raffles.id, id))
    if (!raffle) throw new HttpError('NOT_FOUND', 'No such raffle.')
    if (raffle.status === 'drawn' || raffle.status === 'cancelled') {
      throw new HttpError('INVALID_INPUT', `This raffle is already ${raffle.status}.`)
    }
    await askOrRun(req, res, 'raffle_cancel', { raffleId: id, prizeName: raffle.prizeName, entriesCount: raffle.entriesCount }, reason)
  })

  /* Users ------------------------------------------------------------------ */

  r.get('/users', authed, perm('users.read'), async (req, res) => {
    const q = z.string().max(100).default('').parse(req.query.q ?? '')
    res.json(await ops.searchUsers(ctx, q))
  })
  r.get('/users/:id', authed, perm('users.read'), async (req, res) => {
    res.json(await ops.userDetail(ctx, idParam(req)))
  })
  r.post('/users/:id/suspend', authed, perm('users.suspend'), async (req, res) => {
    const { reason } = reasonBody.parse(req.body)
    res.json(await ops.setUserStatus(ctx, adminId(req), idParam(req), 'suspended', reason))
  })
  r.post('/users/:id/reinstate', authed, perm('users.suspend'), async (req, res) => {
    const { reason } = reasonBody.parse(req.body)
    res.json(await ops.setUserStatus(ctx, adminId(req), idParam(req), 'active', reason))
  })
  r.post('/users/:id/referrer', authed, perm('users.referrer.assign'), async (req, res) => {
    const body = reasonBody.extend({ referrer: z.string().trim().min(2).max(40) }).parse(req.body)
    res.json(await ops.assignReferrer(ctx, adminId(req), idParam(req), body))
  })
  r.post('/users/:id/adjust', authed, perm('users.adjust.request'), async (req, res) => {
    const body = adjustmentBody.parse(req.body)
    const id = idParam(req)
    const [u] = await ctx.db.select({ username: users.username }).from(users).where(eq(users.id, id))
    if (!u) throw new HttpError('NOT_FOUND', 'No such user.')
    await askOrRun(req, res, 'balance_adjustment', { userId: id, username: u.username, raffs: body.raffs }, body.reason)
  })

  /* Settings --------------------------------------------------------------- */

  r.get('/settings', authed, perm('settings.read'), async (_req, res) => {
    res.json(await ops.getSettingsView(ctx))
  })
  r.put('/settings/limits', authed, perm('settings.limits.write'), async (req, res) => {
    res.json(await ops.putLimits(ctx, adminId(req), limitsBody.parse(req.body)))
  })
  r.post('/settings/rate-base', authed, perm('settings.rate.request'), async (req, res) => {
    const body = rateBaseBody.parse(req.body)
    const previousMicro = await getSetting(ctx.db, 'rate.base_stars_per_raff_micro')
    await askOrRun(req, res, 'rate_base_change', { starsPerRaffMicro: Math.round(body.starsPerRaff * 1e6), previousMicro }, body.reason)
  })

  /* Approvals -------------------------------------------------------------- */

  r.get('/approvals', authed, perm('approvals.read'), async (req, res) => {
    const status = z.enum(['pending', 'approved', 'rejected', 'failed']).optional().parse(req.query.status || undefined)
    res.json(await listApprovals(ctx, { status }))
  })
  r.post('/approvals/:id/approve', authed, perm('approvals.decide'), async (req, res) => {
    const { note } = decisionBody.parse(req.body ?? {})
    res.json(await decide(ctx, adminId(req), idParam(req), 'approve', note))
  })
  r.post('/approvals/:id/reject', authed, perm('approvals.decide'), async (req, res) => {
    const { note } = decisionBody.parse(req.body ?? {})
    res.json(await decide(ctx, adminId(req), idParam(req), 'reject', note))
  })

  /* Finance (super_admin and finance) --------------------------------------- */

  const periodOf = (req: Request): Period => {
    const q = z
      .object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() })
      .parse({ from: req.query.from || undefined, to: req.query.to || undefined })
    return { from: q.from ? new Date(q.from) : null, to: q.to ? new Date(q.to) : null }
  }
  r.get('/finance', authed, perm('finance.read'), async (req, res) => {
    res.json(await finance.report(ctx, periodOf(req)))
  })
  r.get('/finance/expenses', authed, perm('finance.read'), async (req, res) => {
    res.json(await finance.listExpenses(ctx, periodOf(req)))
  })
  r.post('/finance/expenses', authed, perm('finance.write'), async (req, res) => {
    res.status(201).json(await finance.addExpense(ctx, adminId(req), expenseBody.parse(req.body)))
  })
  r.post('/finance/expenses/:id/void', authed, perm('finance.write'), async (req, res) => {
    const { reason } = reasonBody.parse(req.body)
    res.json(await finance.voidExpense(ctx, adminId(req), idParam(req), reason))
  })

  /* Admins (super_admin) ---------------------------------------------------- */

  r.get('/admins', authed, perm('admins.manage'), async (_req, res) => {
    res.json(await admins.list(ctx))
  })
  r.post('/admins', authed, perm('admins.manage'), async (req, res) => {
    res.status(201).json(await admins.create(ctx, adminId(req), admins.createBody.parse(req.body)))
  })
  r.post('/admins/:id/reset-password', authed, perm('admins.manage'), async (req, res) => {
    res.json(await admins.resetPassword(ctx, adminId(req), idParam(req)))
  })
  r.post('/admins/:id/disable', authed, perm('admins.manage'), async (req, res) => {
    res.json(await admins.setStatus(ctx, adminId(req), idParam(req), 'disabled'))
  })
  r.post('/admins/:id/enable', authed, perm('admins.manage'), async (req, res) => {
    res.json(await admins.setStatus(ctx, adminId(req), idParam(req), 'active'))
  })

  /* Security and audit ----------------------------------------------------- */

  r.get('/security-events', authed, perm('security.read'), async (req, res) => {
    const base = cursorQuery.parse(req.query)
    const severity = z.enum(['low', 'medium', 'high', 'critical']).optional().parse(req.query.severity || undefined)
    const category = z.string().max(20).optional().parse(req.query.category || undefined)
    res.json(await ops.listSecurityEvents(ctx, { ...base, severity, category }))
  })
  r.get('/audit-log', authed, perm('audit.read'), async (req, res) => {
    res.json(await ops.listAudit(ctx, cursorQuery.parse(req.query)))
  })
  r.get('/audit-log/verify', authed, perm('audit.read'), async (req, res) => {
    const result = await verifyChain(ctx.db)
    if (!result.ok) {
      ctx.log.error({ result, requestId: requestMeta(ctx, req).requestId }, 'audit chain broken')
    }
    res.json(result)
  })

  return r
}
