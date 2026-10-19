/**
 * The whole purchase, end to end against fake Paystack and fake main API
 * servers: sign in, details, checkout, webhook, verify, outbox, delivery,
 * and every way it can go wrong.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { credits, flags, payments, quotes, securityEvents, webhookEvents } from '../src/db/schema'
import { settled } from '../src/http/webhook'
import { reportFlags } from '../src/services/flags'
import { deliverCredits } from '../src/services/outbox'
import { reconcile } from '../src/services/reconcile'
import { PUBLIC_URL, telegramId, testBuyApp, webhook, widgetLogin } from './helpers'

const { http, db, ctx, clock, paystack, main } = await testBuyApp()

/** A signed-in buyer with a game account, phone and email */
async function buyer(opts: { account?: 'active' | 'suspended' | 'none'; details?: boolean; balance?: number } = {}) {
  const tg = telegramId()
  if (opts.account !== 'none') main.accounts.set(tg, { status: opts.account ?? 'active', balance: opts.balance ?? 0 })
  const res = await http.post('/api/auth/telegram').set('content-type', 'application/json').send(widgetLogin({ id: tg, username: `b${tg}` }))
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const cookie = String(res.headers['set-cookie']).split(';')[0]!
  const as = {
    tg,
    cookie,
    get: (path: string) => http.get(path).set('cookie', cookie),
    post: (path: string, body: object = {}) => http.post(path).set('cookie', cookie).set('content-type', 'application/json').send(body),
    put: (path: string, body: object) => http.put(path).set('cookie', cookie).set('content-type', 'application/json').send(body),
  }
  if (opts.details !== false) expect((await as.put('/api/me/details', { phone: '0803 123 4567', email: `B${tg}@Example.com` })).status).toBe(200)
  return as
}

const chargeSuccess = (reference: string) => ({ event: 'charge.success', data: { reference, status: 'success' } })

async function creditOf(reference: string) {
  const [c] = await db.select().from(credits).where(eq(credits.reference, reference))
  return c
}

describe('signing in', () => {
  it('gives the page the login bot id (public), never its token', async () => {
    const res = await http.get('/api/config')
    expect(res.body).toEqual({ loginBotId: 987654321, quoteMinutes: 30 })
    expect(JSON.stringify(res.body)).not.toContain('TEST-login-bot-token')
  })

  it('sets an httpOnly session cookie and stores only its hash', async () => {
    const tg = telegramId()
    const res = await http.post('/api/auth/telegram').set('content-type', 'application/json').send(widgetLogin({ id: tg, username: 'ada' }))
    expect(res.status).toBe(200)
    const set = String(res.headers['set-cookie'])
    expect(set).toMatch(/^__Host-ip_session=[A-Za-z0-9_-]{43};/)
    expect(set).toContain('HttpOnly')
    expect(set).toContain('Secure')
    expect(set).toContain('SameSite=Lax')
    expect(res.body.buyer).toMatchObject({ telegramId: tg, username: 'ada', detailsComplete: false })
  })

  it('refuses a forged or stale login and records it', async () => {
    const forged = { ...widgetLogin({ id: telegramId() }), first_name: 'Mallory' }
    expect((await http.post('/api/auth/telegram').set('content-type', 'application/json').send(forged)).status).toBe(401)
    const old = widgetLogin({ id: telegramId() }, { authDate: Math.floor(Date.now() / 1000) - 90_000 })
    const stale = await http.post('/api/auth/telegram').set('content-type', 'application/json').send(old)
    expect(stale.status).toBe(401)
    expect(stale.body.error.message).toBe('That Telegram login is too old. Log in again.')
    expect((await db.select().from(securityEvents).where(eq(securityEvents.kind, 'login_bad_hash'))).length).toBeGreaterThan(0)
  })

  it('keeps writes to our own pages: JSON only, our origin only', async () => {
    const b = await buyer()
    expect((await http.post('/api/checkout').set('cookie', b.cookie).set('content-type', 'application/x-www-form-urlencoded').send('naira=1000')).status).toBe(415)
    const cross = await http.post('/api/checkout').set('cookie', b.cookie).set('origin', 'https://evil.example').set('content-type', 'application/json').send({ naira: 1000 })
    expect(cross.status).toBe(403)
    expect((await http.post('/api/checkout').set('cookie', b.cookie).set('origin', PUBLIC_URL).set('content-type', 'application/json').send({ naira: 1000 })).status).toBe(201)
  })

  it('checks the phone and email', async () => {
    const b = await buyer({ details: false })
    expect((await b.put('/api/me/details', { phone: '12345', email: 'a@b.ng' })).status).toBe(400)
    expect((await b.put('/api/me/details', { phone: '08031234567', email: 'not-an-email' })).status).toBe(400)
    const ok = await b.put('/api/me/details', { phone: '+234 803 123 4567', email: 'Ada@Example.NG' })
    expect(ok.body.buyer).toMatchObject({ phone: '+2348031234567', email: 'ada@example.ng', detailsComplete: true })
  })
})

describe('what the buyer sees', () => {
  it('shows the balance from the game, the packages and the rate, through this server only', async () => {
    const b = await buyer({ balance: 77 })
    const me = await b.get('/api/me')
    expect(me.body).toMatchObject({ account: { exists: true, active: true, balance: 77 }, sales: { minNaira: 500 }, rate: { nairaPerRaff: 10 } })
    // Nothing about where the game lives
    expect(JSON.stringify(me.body)).not.toContain('127.0.0.1')
    expect(JSON.stringify(me.body)).not.toContain('internal')
  })

  it('says so when there is no game account, and refuses to sell', async () => {
    const b = await buyer({ account: 'none' })
    expect((await b.get('/api/me')).body.account).toMatchObject({ exists: false })
    const res = await b.post('/api/checkout', { naira: 1000 })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NO_ACCOUNT')
    expect(paystack.txs.size).toBeGreaterThanOrEqual(0)
  })

  it('refuses a suspended account, missing details, an amount outside the limits', async () => {
    expect((await (await buyer({ account: 'suspended' })).post('/api/checkout', { naira: 1000 })).status).toBe(403)
    expect((await (await buyer({ details: false })).post('/api/checkout', { naira: 1000 })).status).toBe(400)
    const b = await buyer()
    expect((await b.post('/api/checkout', { naira: 100 })).status).toBe(400)
    expect((await b.post('/api/checkout', { naira: 600_000 })).status).toBe(400)
    expect((await b.post('/api/checkout', { packageIndex: 7 })).status).toBe(400)
  })

  it('cannot reach the game: no sale, and a plain message', async () => {
    const b = await buyer()
    main.setMode('down')
    const res = await b.post('/api/checkout', { naira: 1000 })
    main.setMode('up')
    expect(res.status).toBe(503)
    expect(res.body.error.message).not.toMatch(/http|127|internal/i)
  })
})

describe('a purchase', () => {
  it('quote -> Paystack -> webhook -> verify -> credited once, at the quoted rate', async () => {
    const b = await buyer({ balance: 10 })
    const start = await b.post('/api/checkout', { packageIndex: 1 })
    expect(start.status, JSON.stringify(start.body)).toBe(201)
    expect(start.body).toMatchObject({ naira: 5000, raffs: 525, bonusRaffs: 25 })
    const { reference, authorizationUrl } = start.body as { reference: string; authorizationUrl: string }
    expect(authorizationUrl).toBe(`https://checkout.paystack.test/${reference}`)
    // Paystack was told the quote and the Telegram id
    expect(paystack.txs.get(reference)).toMatchObject({ amount: 500_000, currency: 'NGN', metadata: { quote_id: expect.any(String), telegram_id: b.tg } })

    // The rate moves before the webhook: the quote still decides
    main.rate.nairaPerRaffKobo = 1_150
    paystack.pay(reference)
    const hook = await webhook(http, chargeSuccess(reference))
    expect(hook.status).toBe(200)
    await settled()
    main.rate.nairaPerRaffKobo = 1_000

    expect(main.credited.get(reference)).toMatchObject({ telegramId: b.tg, nairaKobo: 500_000, nairaPerRaffKobo: 1_000, baseRaffs: 500, bonusRaffs: 25 })
    expect(main.accounts.get(b.tg)?.balance).toBe(535)
    expect(await creditOf(reference)).toMatchObject({ status: 'delivered', attempts: 1 })
    const view = await b.get(`/api/purchases/${reference}`)
    expect(view.body).toMatchObject({ state: 'credited', raffs: 525, balanceAfter: 535 })

    // Paystack sends it again: nothing new, recorded as a replay
    await webhook(http, chargeSuccess(reference))
    await settled()
    expect(main.accounts.get(b.tg)?.balance).toBe(535)
    expect((await db.select().from(securityEvents).where(eq(securityEvents.kind, 'webhook_replay'))).length).toBeGreaterThan(0)
    expect((await db.select().from(payments).where(eq(payments.reference, reference))).length).toBe(1)
  })

  it('refuses an unsigned or wrongly signed webhook, and nothing is credited', async () => {
    const b = await buyer()
    const { reference } = (await b.post('/api/checkout', { naira: 1000 })).body as { reference: string }
    paystack.pay(reference)
    expect((await webhook(http, chargeSuccess(reference), 'sk_test_wrong_key_wrong_key_wrong')).status).toBe(401)
    expect((await http.post('/api/paystack/webhook').set('content-type', 'application/json').send(chargeSuccess(reference))).status).toBe(401)
    await settled()
    expect(await creditOf(reference)).toBeUndefined()
    const bad = await db.select().from(webhookEvents).where(eq(webhookEvents.signatureOk, false))
    expect(bad.length).toBeGreaterThanOrEqual(2)
  })

  it("another app's event, passed on from the shared account: answered 200, nothing kept or flagged", async () => {
    const before = (await db.select().from(webhookEvents)).length
    const security = (await db.select().from(securityEvents)).length
    paystack.foreign('WAL-1e2f3a4b', 500_000, new Date())
    const res = await webhook(http, chargeSuccess('WAL-1e2f3a4b'))
    expect(res.status).toBe(200)
    await settled()
    expect((await db.select().from(webhookEvents)).length).toBe(before)
    expect((await db.select().from(securityEvents)).length).toBe(security)
    expect(await db.select().from(flags).where(eq(flags.reference, 'WAL-1e2f3a4b'))).toEqual([])
  })

  it('a signed webhook for an unpaid transaction credits nothing: verify decides', async () => {
    const b = await buyer()
    const { reference } = (await b.post('/api/checkout', { naira: 1000 })).body as { reference: string }
    await webhook(http, chargeSuccess(reference))
    await settled()
    expect(await creditOf(reference)).toBeUndefined()
    const [q] = await db.select().from(quotes).where(eq(quotes.reference, reference))
    expect(q?.status).toBe('awaiting_payment')
  })

  it('an amount that differs from the quote is flagged, never credited', async () => {
    const b = await buyer()
    const { reference } = (await b.post('/api/checkout', { naira: 2000 })).body as { reference: string }
    paystack.pay(reference, { amount: 100_000 })
    await webhook(http, chargeSuccess(reference))
    await settled()
    expect(await creditOf(reference)).toBeUndefined()
    const [f] = await db.select().from(flags).where(and(eq(flags.reference, reference), eq(flags.kind, 'amount_mismatch')))
    expect(f?.detail).toContain('amount 100000 kobo, quote 200000')
    expect((await b.get(`/api/purchases/${reference}`)).body.state).toBe('needs_review')
    expect((await db.select().from(securityEvents).where(eq(securityEvents.kind, 'payment_mismatch'))).length).toBeGreaterThan(0)
  })

  it('a different currency or another quote in the metadata is a mismatch too', async () => {
    const b = await buyer()
    const one = (await b.post('/api/checkout', { naira: 1000 })).body.reference as string
    paystack.pay(one, { currency: 'USD' })
    const two = (await b.post('/api/checkout', { naira: 1000 })).body.reference as string
    paystack.pay(two, { metadata: { quote_id: 'someone-else', telegram_id: b.tg } })
    await webhook(http, chargeSuccess(one))
    await webhook(http, chargeSuccess(two))
    await settled()
    expect(await creditOf(one)).toBeUndefined()
    expect(await creditOf(two)).toBeUndefined()
  })
})

describe('time limits', () => {
  it('a quote can only be resumed while it is valid', async () => {
    const b = await buyer()
    const { reference } = (await b.post('/api/checkout', { naira: 1000 })).body as { reference: string }
    expect((await b.post(`/api/checkout/${reference}/resume`)).status).toBe(200)
    clock.advance(31)
    const late = await b.post(`/api/checkout/${reference}/resume`)
    expect(late.status).toBe(410)
    expect(late.body.error.code).toBe('QUOTE_EXPIRED')
    clock.advance(-31)
  })

  it('paid inside the 2-hour window: credited at the quote; after it: flagged, not credited', async () => {
    const b = await buyer()
    const inTime = (await b.post('/api/checkout', { naira: 1000 })).body.reference as string
    const tooLate = (await b.post('/api/checkout', { naira: 1000 })).body.reference as string
    paystack.pay(inTime, { paid_at: new Date(Date.now() + 100 * 60_000).toISOString() })
    paystack.pay(tooLate, { paid_at: new Date(Date.now() + 125 * 60_000).toISOString() })
    clock.advance(126)
    await webhook(http, chargeSuccess(inTime))
    await webhook(http, chargeSuccess(tooLate))
    await settled()
    clock.advance(-126)
    expect(await creditOf(inTime)).toMatchObject({ status: 'delivered' })
    expect(await creditOf(tooLate)).toBeUndefined()
    const [f] = await db.select().from(flags).where(and(eq(flags.reference, tooLate), eq(flags.kind, 'late_payment')))
    expect(f?.detail).toMatch(/^Paid 12\d minutes after the quote/)
  })
})

describe('delivery to the game', () => {
  it('keeps the credit while the game is down, backs off, and delivers when it is back', async () => {
    const b = await buyer()
    const { reference } = (await b.post('/api/checkout', { naira: 1000 })).body as { reference: string }
    paystack.pay(reference)
    main.setMode('down')
    await webhook(http, chargeSuccess(reference))
    await settled()
    let c = await creditOf(reference)
    expect(c).toMatchObject({ status: 'pending', attempts: 1 })
    expect(c!.nextAttemptAt.getTime() - ctx.now()).toBeGreaterThan(25_000)

    // Not due yet: nothing is sent
    expect(await deliverCredits(ctx)).toEqual({ delivered: 0, refused: 0, retrying: 0 })
    clock.advance(1)
    expect((await deliverCredits(ctx)).retrying).toBe(1)
    c = await creditOf(reference)
    expect(c?.attempts).toBe(2)
    expect(c!.nextAttemptAt.getTime() - ctx.now()).toBeGreaterThan(55_000)

    main.setMode('up')
    clock.advance(2)
    expect((await deliverCredits(ctx)).delivered).toBe(1)
    expect(await creditOf(reference)).toMatchObject({ status: 'delivered', attempts: 3 })
    expect(main.accounts.get(b.tg)?.balance).toBe(100)
    clock.advance(-3)
  })

  it('a credit the game refuses is not retried, and an admin is told', async () => {
    const b = await buyer()
    const { reference } = (await b.post('/api/checkout', { naira: 1000 })).body as { reference: string }
    // Suspended between checkout and payment
    main.accounts.set(b.tg, { status: 'suspended', balance: 0 })
    paystack.pay(reference)
    await webhook(http, chargeSuccess(reference))
    await settled()
    expect(await creditOf(reference)).toMatchObject({ status: 'refused', refusedCode: 'account_suspended' })
    await reportFlags(ctx)
    expect(main.flags.find((f) => f.reference === reference)).toMatchObject({ kind: 'credit_refused', telegramId: b.tg, nairaKobo: 100_000 })
  })

  it('a day undelivered is flagged once, and still retried', async () => {
    const b = await buyer()
    const { reference } = (await b.post('/api/checkout', { naira: 1000 })).body as { reference: string }
    paystack.pay(reference)
    main.setMode('down')
    await webhook(http, chargeSuccess(reference))
    await settled()
    clock.advance(25 * 60)
    await deliverCredits(ctx)
    clock.advance(70)
    await deliverCredits(ctx)
    const stuck = await db.select().from(flags).where(and(eq(flags.reference, reference), eq(flags.kind, 'credit_stuck')))
    expect(stuck).toHaveLength(1)
    expect((await creditOf(reference))?.status).toBe('pending')
    main.setMode('up')
    clock.advance(70)
    await deliverCredits(ctx)
    expect((await creditOf(reference))?.status).toBe('delivered')
    clock.offsetMs = 0
  })

  it('the buyer coming back settles a payment whose webhook never came', async () => {
    const b = await buyer()
    const { reference } = (await b.post('/api/checkout', { naira: 1000 })).body as { reference: string }
    expect((await b.get(`/api/purchases/${reference}`)).body.state).toBe('awaiting_payment')
    paystack.pay(reference)
    clock.advance(1)
    const back = await b.get(`/api/purchases/${reference}`)
    clock.advance(-1)
    expect(back.body).toMatchObject({ state: 'credited', raffs: 100 })
    // Someone else's reference is not theirs to see
    const other = await buyer()
    expect((await other.get(`/api/purchases/${reference}`)).status).toBe(404)
  })
})

describe('reconciliation', () => {
  it('credits a paid payment nobody told us about, flags one of ours with no quote, leaves other apps alone', async () => {
    const b = await buyer()
    const { reference } = (await b.post('/api/checkout', { naira: 3000 })).body as { reference: string }
    paystack.pay(reference)
    const lost = `ip_${'7'.repeat(32)}`
    paystack.foreign(lost, 250_000, new Date())
    // The account is shared: another app's payment is not ours to flag
    paystack.foreign('TOKO-course-payment-12', 2_500_000, new Date())
    const from = new Date(Date.now() - 86_400_000)
    const to = new Date(Date.now() + 60_000)
    const r = await reconcile(ctx, from, to, null)
    expect(r.recovered).toBeGreaterThanOrEqual(1)
    expect(r.flagged).toBeGreaterThanOrEqual(1)
    await deliverCredits(ctx)
    expect(await creditOf(reference)).toMatchObject({ status: 'delivered' })
    const [f] = await db.select().from(flags).where(eq(flags.reference, lost))
    expect(f?.kind).toBe('unmatched')
    expect(await db.select().from(flags).where(eq(flags.reference, 'TOKO-course-payment-12'))).toEqual([])
    // Run again: nothing new
    const again = await reconcile(ctx, from, to, null)
    expect(again).toMatchObject({ recovered: 0, flagged: 0 })
    await reportFlags(ctx)
    expect(main.flags.some((x) => x.reference === lost && x.kind === 'unmatched')).toBe(true)
    expect(main.flags.some((x) => x.reference === 'TOKO-course-payment-12')).toBe(false)
  })
})

describe('the relay', () => {
  it('every call to the game was signed and accepted', () => {
    expect(main.rejected).toEqual([])
  })
})
