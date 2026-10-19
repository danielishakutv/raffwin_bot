/**
 * Checkout. The buyer picks a package or types an amount; we store a quote
 * (Telegram id, naira, the main API's rate this hour, the Raffs it buys, a
 * bonus if it is a package, an expiry) and start a Paystack payment with our
 * own unique reference and the quote in its metadata. Whatever the rate does
 * afterwards, this quote is what gets credited (services/payments.ts).
 *
 * Refused before any money moves: no game account for this Telegram id, a
 * suspended account, missing phone or email, an amount outside the admin's
 * limits, more than QUOTES_PER_HOUR checkouts in an hour.
 */
import { randomUUID } from 'node:crypto'
import { and, count, desc, eq, gte } from 'drizzle-orm'
import { z } from 'zod'
import { bonusRaffs, raffsForNaira, type AccountResponse } from '@raffwin/relay'
import type { AppContext } from '../context'
import { quotes, type BuyerRow, type QuoteRow } from '../db/schema'
import { PaystackError } from '../lib/paystack'
import { HttpError } from '../lib/util'

export const QUOTES_PER_HOUR = 20

export const checkoutBody = z.union([
  z.object({ packageIndex: z.number().int().min(0).max(7) }).strict(),
  z.object({ naira: z.number().int().min(1).max(10_000_000) }).strict(),
])

/** The buyer's game account, balance and what is on sale. Null when the main API cannot be reached. */
export async function accountOf(ctx: AppContext, telegramId: number): Promise<AccountResponse | null> {
  const r = await ctx.mainApi.account({ telegramId })
  if (r.ok) return r.data
  ctx.log.warn({ relay: 'account', ...(r.refused ? { refused: r.refused } : { error: r.error }) }, 'account lookup failed')
  return null
}

export const NO_ACCOUNT = 'We could not find a game account for this Telegram account. Open the game in Telegram first, then come back and buy.'

export async function startCheckout(ctx: AppContext, buyer: BuyerRow, body: unknown) {
  const choice = checkoutBody.parse(body)
  if (!buyer.phone || !buyer.email) throw new HttpError(400, 'DETAILS_NEEDED', 'Add your phone number and email first.')

  const since = new Date(ctx.now() - 3_600_000)
  const [recent] = await ctx.db.select({ n: count() }).from(quotes).where(and(eq(quotes.buyerId, buyer.id), gte(quotes.createdAt, since)))
  if ((recent?.n ?? 0) >= QUOTES_PER_HOUR) throw new HttpError(429, 'RATE_LIMITED', 'Too many checkouts in an hour. Wait a while and try again.')

  const account = await accountOf(ctx, buyer.telegramId)
  if (!account) throw new HttpError(503, 'UNAVAILABLE', 'We cannot reach your game account right now. Try again in a minute.')
  if (!account.exists) throw new HttpError(409, 'NO_ACCOUNT', NO_ACCOUNT)
  if (account.status !== 'active') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Your game account is suspended, so it cannot receive Raffs. Contact support in the game.')

  const { sales, rate } = account
  let naira: number
  let bonusPercent = 0
  let packageLabel: string | null = null
  if ('packageIndex' in choice) {
    const pack = sales.packages[choice.packageIndex]
    if (!pack) throw new HttpError(400, 'INVALID_INPUT', 'That package is no longer on sale. Pick again.')
    naira = pack.naira
    bonusPercent = pack.bonusPercent
    packageLabel = pack.label
  } else {
    naira = choice.naira
  }
  if (naira < sales.minNaira || naira > sales.maxNaira) {
    throw new HttpError(400, 'INVALID_INPUT', `Choose between ₦${sales.minNaira.toLocaleString('en-NG')} and ₦${sales.maxNaira.toLocaleString('en-NG')}.`)
  }

  const nairaKobo = naira * 100
  const base = raffsForNaira(nairaKobo, rate.nairaPerRaffKobo)
  if (base < 1) throw new HttpError(400, 'INVALID_INPUT', 'That amount buys less than one Raff. Choose more.')
  const bonus = bonusRaffs(base, bonusPercent)

  const id = randomUUID()
  const reference = `ip_${id.replace(/-/g, '')}`
  const created = ctx.now()
  await ctx.db.insert(quotes).values({
    id,
    buyerId: buyer.id,
    telegramId: buyer.telegramId,
    nairaKobo,
    rateId: rate.id,
    nairaPerRaffKobo: rate.nairaPerRaffKobo,
    baseRaffs: base,
    bonusRaffs: bonus,
    bonusPercent,
    packageLabel,
    reference,
    expiresAt: new Date(created + ctx.config.QUOTE_MINUTES * 60_000),
    creditUntil: new Date(created + ctx.config.CREDIT_WINDOW_MINUTES * 60_000),
  })

  let authorizationUrl: string
  try {
    ;({ authorizationUrl } = await ctx.paystack.initialize({
      email: buyer.email,
      amountKobo: nairaKobo,
      reference,
      callbackUrl: `${ctx.config.PUBLIC_URL.replace(/\/$/, '')}/paid?reference=${reference}`,
      metadata: { quote_id: id, telegram_id: buyer.telegramId, raffs: base + bonus },
    }))
  } catch (error) {
    await ctx.db.update(quotes).set({ status: 'failed', updatedAt: new Date(ctx.now()) }).where(eq(quotes.id, id))
    ctx.log.error({ err: error instanceof PaystackError ? { message: error.message, status: error.status } : error, reference }, 'paystack initialize failed')
    throw new HttpError(502, 'PAYMENT_UNAVAILABLE', 'The payment could not start. Try again in a minute.')
  }
  await ctx.db.update(quotes).set({ authorizationUrl, updatedAt: new Date(ctx.now()) }).where(eq(quotes.id, id))
  ctx.log.info({ reference, nairaKobo, raffs: base + bonus }, 'checkout started')
  return { reference, authorizationUrl, naira, raffs: base + bonus, bonusRaffs: bonus, expiresAt: new Date(created + ctx.config.QUOTE_MINUTES * 60_000).toISOString() }
}

/** Back to the Paystack page for a quote not paid yet, while it is still valid */
export async function resumeCheckout(ctx: AppContext, buyer: BuyerRow, reference: string) {
  const [q] = await ctx.db.select().from(quotes).where(and(eq(quotes.reference, reference), eq(quotes.buyerId, buyer.id)))
  if (!q) throw new HttpError(404, 'NOT_FOUND', 'No such payment.')
  if (q.status !== 'awaiting_payment') throw new HttpError(409, 'ALREADY_DONE', 'This payment is already settled.')
  if (q.expiresAt.getTime() <= ctx.now() || !q.authorizationUrl) throw new HttpError(410, 'QUOTE_EXPIRED', 'This price has expired. Start again for the current price.')
  return { authorizationUrl: q.authorizationUrl }
}

export function toPurchase(q: QuoteRow, credit: { status: string; response: unknown } | null, now: number) {
  const credited = credit?.status === 'delivered'
  return {
    reference: q.reference,
    naira: q.nairaKobo / 100,
    raffs: q.baseRaffs + q.bonusRaffs,
    bonusRaffs: q.bonusRaffs,
    createdAt: q.createdAt.toISOString(),
    // What the buyer needs to know, in their words
    state: credited
      ? 'credited'
      : q.status === 'paid'
        ? 'crediting'
        : q.status === 'late' || q.status === 'mismatch' || credit?.status === 'refused'
          ? 'needs_review'
          : q.status === 'failed'
            ? 'failed'
            : q.expiresAt.getTime() <= now
              ? 'expired'
              : 'awaiting_payment',
    balanceAfter: credited ? ((credit.response as { balance?: number } | null)?.balance ?? null) : null,
  }
}

export async function recentQuotes(ctx: AppContext, buyerId: string) {
  return ctx.db.select().from(quotes).where(eq(quotes.buyerId, buyerId)).orderBy(desc(quotes.createdAt)).limit(30)
}
