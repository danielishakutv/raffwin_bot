/**
 * /admin/v1 - served same-origin from admin.rafflewin.com.ng (Apache proxies
 * /admin/v1 to the API), so the session cookie never crosses origins.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import {
  adjustmentBody,
  decisionBody,
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
import { decide, listApprovals, requestApproval } from './approvals'
import { verifyChain } from './audit'
import * as ops from './operations'
import { permissionsOf } from './permissions'
import { adminOf, login, logout, requireAdmin, requirePermission } from './session'

const uuid = z.string().uuid()

function idParam(req: Request): string {
  const parsed = uuid.safeParse(req.params.id)
  if (!parsed.success) throw new HttpError('NOT_FOUND', 'Not found.')
  return parsed.data
}

function me(req: Request): AdminMe {
  const { user } = adminOf(req)
  return { id: user.id, email: user.email, name: user.name, role: user.role, permissions: permissionsOf(user.role) }
}

export function adminRoutes(ctx: AppContext): Router {
  const r = Router()
  const authed = requireAdmin(ctx)
  const perm = (p: Parameters<typeof requirePermission>[1]) => requirePermission(ctx, p)
  const adminId = (req: Request) => adminOf(req).user.id

  /* Session ---------------------------------------------------------------- */

  r.post('/auth/login', async (req, res) => {
    const admin = await login(ctx, req, res)
    res.json({ id: admin.id, email: admin.email, name: admin.name, role: admin.role, permissions: permissionsOf(admin.role) })
  })
  r.post('/auth/logout', authed, async (req, res) => {
    await logout(ctx, req, res)
    res.status(204).end()
  })
  r.get('/me', authed, (req, res) => {
    res.json(me(req))
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
    res.json(await ops.updateRaffle(ctx, adminId(req), idParam(req), raffleBody.parse(req.body)))
  })
  r.post('/raffles/:id/open', authed, perm('raffles.write'), async (req, res) => {
    res.json(await ops.openRaffle(ctx, adminId(req), idParam(req)))
  })
  r.post('/raffles/:id/cancel', authed, perm('raffles.cancel.request'), async (req, res) => {
    const { reason } = reasonBody.parse(req.body)
    const id = idParam(req)
    const [raffle] = await ctx.db.select().from(raffles).where(eq(raffles.id, id))
    if (!raffle) throw new HttpError('NOT_FOUND', 'No such raffle.')
    if (raffle.status === 'drawn' || raffle.status === 'cancelled') {
      throw new HttpError('INVALID_INPUT', `This raffle is already ${raffle.status}.`)
    }
    res
      .status(202)
      .json(
        await requestApproval(
          ctx,
          adminId(req),
          'raffle_cancel',
          { raffleId: id, prizeName: raffle.prizeName, entriesCount: raffle.entriesCount },
          reason,
        ),
      )
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
  r.post('/users/:id/adjust', authed, perm('users.adjust.request'), async (req, res) => {
    const body = adjustmentBody.parse(req.body)
    const id = idParam(req)
    const [u] = await ctx.db.select({ username: users.username }).from(users).where(eq(users.id, id))
    if (!u) throw new HttpError('NOT_FOUND', 'No such user.')
    res
      .status(202)
      .json(await requestApproval(ctx, adminId(req), 'balance_adjustment', { userId: id, username: u.username, raffs: body.raffs }, body.reason))
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
    res.status(202).json(
      await requestApproval(
        ctx,
        adminId(req),
        'rate_base_change',
        { starsPerRaffMicro: Math.round(body.starsPerRaff * 1e6), previousMicro },
        body.reason,
      ),
    )
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
