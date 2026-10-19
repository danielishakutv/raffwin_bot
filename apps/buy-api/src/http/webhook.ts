/**
 * POST /api/paystack/webhook. Checked against the raw body (HMAC-SHA512 with
 * the secret key), recorded, answered 200 at once, then handled in the
 * background: Paystack retries a slow or failed answer, and a retry must
 * never be what decides whether a payment counts. Settling is idempotent, so
 * a retry or a replay finds the payment done.
 *
 *   charge.success                        settle it (payments.ts), then deliver
 *   refund.processed, charge.dispute.*    flag it for an admin
 *   anything else                         recorded, ignored
 */
import express, { type Router } from 'express'
import type { AppContext } from '../context'
import { webhookEvents } from '../db/schema'
import { verifyPaystackSignature } from '../lib/paystack'
import { raiseFlag } from '../services/flags'
import { settlePayment } from '../services/payments'
import { recordSecurity } from '../services/security'
import { kickCredits } from '../services/worker'
import { clientIp, requestMeta } from './middleware'

/** Work started after the 200; tests wait for it with settled() */
const inFlight = new Set<Promise<unknown>>()
export async function settled(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight])
}
function background(ctx: AppContext, work: () => Promise<unknown>) {
  const p = work()
    .catch((error: unknown) => ctx.log.error({ err: error }, 'webhook handling failed; reconciliation will find it'))
    .finally(() => inFlight.delete(p))
  inFlight.add(p)
}

interface WebhookBody {
  event?: string
  data?: { reference?: string; transaction_reference?: string; amount?: number; transaction?: { reference?: string }; metadata?: { telegram_id?: unknown } }
}

export function webhookRoutes(ctx: AppContext): Router {
  const r = express.Router()
  const allowed = new Set(ctx.config.PAYSTACK_WEBHOOK_IPS)

  r.post('/paystack/webhook', express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
    const meta = requestMeta(ctx, req)
    if (allowed.size && !allowed.has(clientIp(ctx, req) ?? '')) {
      await recordSecurity(ctx, { kind: 'webhook_ip_denied', severity: 'high', ipHash: meta.ipHash })
      res.status(401).end()
      return
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    if (!verifyPaystackSignature(raw, req.get('x-paystack-signature'), ctx.config.PAYSTACK_SECRET_KEY)) {
      await ctx.db.insert(webhookEvents).values({ event: null, reference: null, signatureOk: false, ipHash: meta.ipHash })
      await recordSecurity(ctx, { kind: 'webhook_bad_signature', severity: 'high', ipHash: meta.ipHash, details: { bytes: raw.length } })
      res.status(401).end()
      return
    }

    let body: WebhookBody
    try {
      body = JSON.parse(raw.toString('utf8')) as WebhookBody
    } catch {
      res.status(400).end()
      return
    }
    const event = typeof body.event === 'string' ? body.event.slice(0, 64) : null
    const reference = body.data?.reference ?? body.data?.transaction_reference ?? body.data?.transaction?.reference ?? null
    const ref = typeof reference === 'string' && /^[A-Za-z0-9_.=-]{1,100}$/.test(reference) ? reference : null
    await ctx.db.insert(webhookEvents).values({ event, reference: ref, signatureOk: true, ipHash: meta.ipHash })
    res.status(200).end()

    if (!ref) return
    if (event === 'charge.success') {
      background(ctx, async () => {
        const outcome = await settlePayment(ctx, ref, 'webhook')
        if (outcome === 'already') await recordSecurity(ctx, { kind: 'webhook_replay', severity: 'low', ipHash: meta.ipHash, details: { reference: ref } })
        if (outcome === 'unknown_reference') await recordSecurity(ctx, { kind: 'webhook_unknown_reference', severity: 'medium', ipHash: meta.ipHash, details: { reference: ref } })
        if (outcome === 'credit') await kickCredits(ctx)
      })
    } else if (event === 'refund.processed' || event?.startsWith('charge.dispute.')) {
      const tg = Number(body.data?.metadata?.telegram_id)
      background(ctx, () =>
        raiseFlag(ctx.db, ctx.now(), {
          reference: ref,
          kind: event === 'refund.processed' ? 'refund' : 'dispute',
          telegramId: Number.isSafeInteger(tg) && tg > 0 ? tg : null,
          nairaKobo: typeof body.data?.amount === 'number' ? body.data.amount : null,
          detail: `Paystack event ${event}. The Raffs may already be spent; decide whether to take them back.`,
        }),
      )
    }
  })
  return r
}
