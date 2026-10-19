/**
 * The relay from the sales site's backend: POST /internal/<RELAY_PATH>/<operation>
 * (Apache serves it under /api). Mounted only when RELAY_SECRET and
 * RELAY_PATH are both set. The path is not the protection, the signature is
 * (@raffwin/relay): the path only keeps the routes out of casual scans, and
 * it is hidden from this process's request log (app.ts).
 *
 * Mounted before the JSON parser, because the signature covers the body
 * exactly as it was sent. Every refusal is recorded as a security event:
 * a bad or stale signature, a caller outside RELAY_ALLOWED_IPS, an amount
 * that does not add up, a reference reused with different figures.
 */
import express, { type Express, type Request, type RequestHandler, type Response } from 'express'
import {
  accountRequest,
  creditRequest,
  flagRequest,
  RELAY_OPERATIONS,
  RELAY_REFUSALS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyRelay,
  type RelayErrorBody,
  type RelayOperation,
} from '@raffwin/relay'
import type { AppContext } from '../context'
import { recordSecurityEvent } from '../lib/security-events'
import { accountFor, creditPurchase, flagPayment } from '../services/purchases'
import { requestMeta } from './middleware'

export const RELAY_MOUNT = '/internal'

export function relayPrefix(ctx: AppContext): string | null {
  const { RELAY_SECRET, RELAY_PATH } = ctx.config
  return RELAY_SECRET && RELAY_PATH ? `${RELAY_MOUNT}/${RELAY_PATH}` : null
}

function fail(res: Response, status: number, code: RelayErrorBody['error']['code'], message: string) {
  const body: RelayErrorBody = { error: { code, message } }
  res.status(status).json(body)
}

export function mountRelay(ctx: AppContext, app: Express, limiter: RequestHandler): void {
  const prefix = relayPrefix(ctx)
  if (!prefix) return
  const secrets = [ctx.config.RELAY_SECRET, ctx.config.RELAY_SECRET_PREVIOUS].filter((s): s is string => !!s)
  const allowed = new Set(ctx.config.RELAY_ALLOWED_IPS)
  const ipHeader = ctx.config.RELAY_CLIENT_IP_HEADER

  const event = (req: Request, kind: string, severity: 'medium' | 'high', details: Record<string, unknown> = {}) => {
    const meta = requestMeta(ctx, req)
    return recordSecurityEvent(ctx.db, ctx.log, {
      severity,
      category: 'relay',
      kind,
      ipHash: meta.ipHash,
      // Never the real path: it is part of what keeps the relay quiet
      route: `POST ${RELAY_MOUNT}/*/${String(req.params.op ?? '')}`,
      requestId: meta.requestId,
      details,
      actionTaken: 'blocked',
    })
  }

  const router = express.Router()
  router.use(limiter)
  router.post('/:op', express.raw({ type: () => true, limit: '4kb' }), async (req, res) => {
    const op = String(req.params.op)
    if (!(RELAY_OPERATIONS as readonly string[]).includes(op)) return fail(res, 404, 'invalid', 'Not found')
    const operation = op as RelayOperation

    if (allowed.size) {
      const ip = (ipHeader ? req.get(ipHeader) : req.ip)?.trim() ?? ''
      if (!allowed.has(ip)) {
        await event(req, 'relay_ip_denied', 'high', { ip })
        return fail(res, 401, 'unauthorised', 'Not allowed')
      }
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    const check = verifyRelay({ secrets, operation, rawBody, timestamp: req.get(TIMESTAMP_HEADER), signature: req.get(SIGNATURE_HEADER), now: ctx.now() })
    if (!check.ok) {
      // A stale timestamp on a correct signature is a replay or a clock problem; anything else is someone guessing
      await event(req, `relay_${check.reason}`, check.reason === 'stale' || check.reason === 'ahead' ? 'medium' : 'high')
      return fail(res, 401, 'unauthorised', 'Not allowed')
    }
    if (check.secretIndex > 0) ctx.log.warn({ relay: operation }, 'relay signed with the previous secret: finish the rotation (README)')

    let json: unknown
    try {
      json = JSON.parse(rawBody)
    } catch {
      return fail(res, 400, 'invalid', 'Body is not JSON')
    }

    if (operation === 'account') {
      const parsed = accountRequest.safeParse(json)
      if (!parsed.success) return fail(res, 400, 'invalid', parsed.error.issues[0]?.message ?? 'Invalid request')
      res.json(await accountFor(ctx, parsed.data.telegramId))
      return
    }

    if (operation === 'flag') {
      const parsed = flagRequest.safeParse(json)
      if (!parsed.success) return fail(res, 400, 'invalid', parsed.error.issues[0]?.message ?? 'Invalid request')
      res.json(await flagPayment(ctx, parsed.data))
      return
    }

    const parsed = creditRequest.safeParse(json)
    if (!parsed.success) return fail(res, 400, 'invalid', parsed.error.issues[0]?.message ?? 'Invalid request')
    const outcome = await creditPurchase(ctx, parsed.data)
    if (outcome.ok) {
      ctx.log.info({ relay: 'credit', reference: parsed.data.reference, status: outcome.response.status, raffs: outcome.response.raffs }, 'purchase credit')
      res.json(outcome.response)
      return
    }
    const c = parsed.data
    const details = { reference: c.reference, telegramId: c.telegramId, nairaKobo: c.nairaKobo, rateId: c.rateId, raffs: c.baseRaffs + c.bonusRaffs, why: outcome.message }
    if (outcome.refusal === 'out_of_bounds' || outcome.refusal === 'reference_conflict') await event(req, `relay_${outcome.refusal}`, 'high', details)
    else ctx.log.warn({ relay: 'credit', refusal: outcome.refusal, ...details }, 'purchase credit refused')
    fail(res, RELAY_REFUSALS[outcome.refusal], outcome.refusal, outcome.message)
  })
  app.use(prefix, router)
}
