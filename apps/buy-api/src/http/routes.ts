/**
 * /api for the site's own pages. The browser talks to nothing else: balances
 * and prices come from the main API through this server, re-shaped, never
 * forwarded as they arrived.
 */
import { Router } from 'express'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../context'
import { credits, quotes } from '../db/schema'
import { HttpError } from '../lib/util'
import { saveDetails, signIn, signOut, toBuyer } from '../services/auth'
import { accountOf, NO_ACCOUNT, recentQuotes, resumeCheckout, startCheckout, toPurchase } from '../services/checkout'
import { settlePayment } from '../services/payments'
import { kickCredits } from '../services/worker'
import { buyerOf, clearedSessionCookie, requestMeta, requireBuyer, sessionCookie } from './middleware'

const referenceParam = z.string().regex(/^ip_[0-9a-f]{32}$/, 'No such payment.')

/** How often the return page may make us ask Paystack about one payment */
const CHECK_EVERY_MS = 10_000

export function apiRoutes(ctx: AppContext): Router {
  const r = Router()
  const authed = requireBuyer(ctx)

  r.get('/config', (_req, res) => {
    // The login bot's numeric id (the part of its token before the colon: public, not the secret)
    res.json({ loginBotId: Number(ctx.config.LOGIN_BOT_TOKEN.split(':')[0]), quoteMinutes: ctx.config.QUOTE_MINUTES })
  })

  /* Sign-in ----------------------------------------------------------------- */

  r.post('/auth/telegram', async (req, res) => {
    const { token, buyer, expiresAt } = await signIn(ctx, req.body, requestMeta(ctx, req))
    res.setHeader('Set-Cookie', sessionCookie(token, Math.floor((expiresAt.getTime() - ctx.now()) / 1000)))
    res.json({ buyer: toBuyer(buyer) })
  })

  r.post('/auth/logout', authed, async (req, res) => {
    await signOut(ctx, req.session!.sessionId)
    res.setHeader('Set-Cookie', clearedSessionCookie)
    res.json({ ok: true })
  })

  /* The buyer ----------------------------------------------------------------- */

  r.get('/me', authed, async (req, res) => {
    const buyer = buyerOf(req)
    const account = await accountOf(ctx, buyer.telegramId)
    res.json({
      buyer: toBuyer(buyer),
      // null = the game could not be reached just now; the page says so and tries again
      account: account ? (account.exists ? { exists: true, active: account.status === 'active', balance: account.balance } : { exists: false, message: NO_ACCOUNT }) : null,
      sales: account?.sales ?? null,
      rate: account ? { nairaPerRaff: account.rate.nairaPerRaffKobo / 100, validUntil: account.rate.validUntil } : null,
    })
  })

  r.put('/me/details', authed, async (req, res) => {
    res.json({ buyer: toBuyer(await saveDetails(ctx, buyerOf(req).id, req.body)) })
  })

  /* Buying ------------------------------------------------------------------- */

  r.post('/checkout', authed, async (req, res) => {
    res.status(201).json(await startCheckout(ctx, buyerOf(req), req.body))
  })

  r.post('/checkout/:reference/resume', authed, async (req, res) => {
    res.json(await resumeCheckout(ctx, buyerOf(req), referenceParam.parse(req.params.reference)))
  })

  r.get('/purchases', authed, async (req, res) => {
    const list = await recentQuotes(ctx, buyerOf(req).id)
    const refs = list.map((q) => q.reference)
    const cs = refs.length ? await ctx.db.select().from(credits).where(inArray(credits.reference, refs)) : []
    const byRef = new Map(cs.map((c) => [c.reference, c]))
    res.json(list.map((q) => toPurchase(q, byRef.get(q.reference) ?? null, ctx.now())))
  })

  // The page Paystack sends the buyer back to polls this. If the webhook has not come yet, we ask Paystack ourselves.
  r.get('/purchases/:reference', authed, async (req, res) => {
    const reference = referenceParam.parse(req.params.reference)
    const buyer = buyerOf(req)
    const [q] = await ctx.db.select().from(quotes).where(and(eq(quotes.reference, reference), eq(quotes.buyerId, buyer.id)))
    if (!q) throw new HttpError(404, 'NOT_FOUND', 'No such payment.')
    const now = ctx.now()
    if (q.status === 'awaiting_payment' && (!q.lastCheckedAt || now - q.lastCheckedAt.getTime() > CHECK_EVERY_MS)) {
      await ctx.db.update(quotes).set({ lastCheckedAt: new Date(now) }).where(eq(quotes.id, q.id))
      if ((await settlePayment(ctx, reference, 'return')) === 'credit') await kickCredits(ctx)
    }
    const [fresh] = await ctx.db.select().from(quotes).where(eq(quotes.id, q.id))
    const [c] = await ctx.db.select().from(credits).where(eq(credits.reference, reference))
    res.json(toPurchase(fresh ?? q, c ?? null, ctx.now()))
  })

  return r
}
