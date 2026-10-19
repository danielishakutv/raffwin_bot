/**
 * The sales backend under test, with Paystack and the main API played by
 * small HTTP servers on this machine. Calls really go over HTTP and relay
 * requests are really signed and checked (@raffwin/relay), so the contract
 * is tested end to end; the main API's own side is tested in apps/api.
 */
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { pino } from 'pino'
import supertest from 'supertest'
import { afterAll, inject } from 'vitest'
import { creditRequest, flagRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRelay, type CreditRequest, type FlagRequest, type RelayOperation } from '@raffwin/relay'
import { createApp } from '../src/app'
import { loadConfig, type Config } from '../src/config'
import type { AppContext } from '../src/context'
import { createDb } from '../src/db/client'
import { createMainApi } from '../src/lib/main-api'
import { Paystack, paystackSignature } from '../src/lib/paystack'
import { signTelegramLogin } from '../src/lib/telegram-login'

export const LOGIN_BOT_TOKEN = '987654321:TEST-login-bot-token-for-widget-only'
export const PAYSTACK_KEY = 'sk_test_0123456789abcdefghijklmnop'
export const RELAY_SECRET = 'buy-relay-secret-'.padEnd(64, 'q')
export const RELAY_PATH = 'r3lAyPaTh0123456789abcdefgh'

export class Clock {
  offsetMs = 0
  now = () => Date.now() + this.offsetMs
  advance(minutes: number) {
    this.offsetMs += minutes * 60_000
  }
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

/* Paystack --------------------------------------------------------------------- */

export interface FakeTx {
  id: number
  reference: string
  status: string
  amount: number
  currency: string
  paid_at: string | null
  channel: string | null
  metadata: Record<string, unknown>
  createdAt: number
}

export function fakePaystack() {
  const txs = new Map<string, FakeTx>()
  let nextId = 5_000_000
  let down = false
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    if (req.get('authorization') !== `Bearer ${PAYSTACK_KEY}`) return void res.status(401).json({ status: false, message: 'Invalid key' })
    if (down) return void res.status(503).json({ status: false, message: 'down' })
    next()
  })
  app.post('/transaction/initialize', (req, res) => {
    const b = req.body as { reference: string; amount: number; currency: string; metadata: Record<string, unknown>; email: string; callback_url: string }
    if (txs.has(b.reference)) return void res.status(400).json({ status: false, message: 'Duplicate Transaction Reference' })
    txs.set(b.reference, { id: nextId++, reference: b.reference, status: 'abandoned', amount: b.amount, currency: b.currency, paid_at: null, channel: null, metadata: b.metadata, createdAt: Date.now() })
    res.json({ status: true, message: 'Authorization URL created', data: { authorization_url: `https://checkout.paystack.test/${b.reference}`, access_code: 'ac_test', reference: b.reference } })
  })
  app.get('/transaction/verify/:reference', (req, res) => {
    const t = txs.get(req.params.reference)
    if (!t) return void res.status(400).json({ status: false, message: 'Transaction reference not found' })
    res.json({ status: true, message: 'Verification successful', data: t })
  })
  app.get('/transaction', (req, res) => {
    const from = Date.parse(String(req.query.from))
    const to = Date.parse(String(req.query.to))
    const list = [...txs.values()].filter((t) => t.status === 'success' && t.paid_at && Date.parse(t.paid_at) >= from && Date.parse(t.paid_at) < to)
    res.json({ status: true, data: list, meta: { pageCount: 1 } })
  })
  return {
    app,
    txs,
    setDown: (v: boolean) => (down = v),
    /** The buyer paid at Paystack: what verify will say from now on */
    pay(reference: string, change: Partial<FakeTx> = {}) {
      const t = txs.get(reference)
      if (!t) throw new Error(`no transaction ${reference}`)
      Object.assign(t, { status: 'success', paid_at: new Date().toISOString(), channel: 'card' }, change)
      return t
    },
    /** A successful payment Paystack knows and we never made */
    foreign(reference: string, amount: number, paidAt: Date) {
      txs.set(reference, { id: nextId++, reference, status: 'success', amount, currency: 'NGN', paid_at: paidAt.toISOString(), channel: 'bank', metadata: {}, createdAt: Date.now() })
    },
  }
}

/* The main API ------------------------------------------------------------------ */

export function fakeMain(now: () => number) {
  const accounts = new Map<number, { status: 'active' | 'suspended'; balance: number }>()
  const credited = new Map<string, CreditRequest & { creditId: string }>()
  const flags: FlagRequest[] = []
  const rejected: string[] = []
  let mode: 'up' | 'down' = 'up'
  const rate = { id: randomUUID(), nairaPerRaffKobo: 1_000, baseNairaPerRaffKobo: 1_000, validUntil: new Date(now() + 3_600_000).toISOString() }
  const sales = {
    packages: [
      { naira: 1_000, bonusPercent: 0, label: null },
      { naira: 5_000, bonusPercent: 5, label: 'Popular' },
    ],
    minNaira: 500,
    maxNaira: 500_000,
  }
  const app = express()
  app.post(`/internal/${RELAY_PATH}/:op`, express.raw({ type: () => true }), (req, res) => {
    const op = req.params.op as RelayOperation
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    const check = verifyRelay({ secrets: [RELAY_SECRET], operation: op, rawBody: raw, timestamp: req.get(TIMESTAMP_HEADER), signature: req.get(SIGNATURE_HEADER), now: now() })
    if (!check.ok) {
      rejected.push(check.reason)
      return void res.status(401).json({ error: { code: 'unauthorised', message: 'Not allowed' } })
    }
    if (mode === 'down') return void res.status(502).json({ error: { code: 'internal', message: 'down' } })
    const body = JSON.parse(raw) as Record<string, unknown>
    if (op === 'account') {
      const a = accounts.get(body.telegramId as number)
      return void res.json(a ? { exists: true, status: a.status, balance: a.balance, rate, sales } : { exists: false, rate, sales })
    }
    if (op === 'flag') {
      flags.push(flagRequest.parse(body))
      return void res.json({ recorded: true })
    }
    const c = creditRequest.parse(body)
    const a = accounts.get(c.telegramId)
    if (!a) return void res.status(404).json({ error: { code: 'no_account', message: 'No player with this Telegram id' } })
    if (a.status !== 'active') return void res.status(403).json({ error: { code: 'account_suspended', message: 'The player is suspended' } })
    const seen = credited.get(c.reference)
    if (seen) return void res.json({ status: 'already_credited', creditId: seen.creditId, raffs: c.baseRaffs + c.bonusRaffs, balance: a.balance })
    const creditId = randomUUID()
    credited.set(c.reference, { ...c, creditId })
    a.balance += c.baseRaffs + c.bonusRaffs
    res.json({ status: 'credited', creditId, raffs: c.baseRaffs + c.bonusRaffs, balance: a.balance })
  })
  return { app, accounts, credited, flags, rejected, rate, sales, setMode: (m: 'up' | 'down') => (mode = m) }
}

/* The app ---------------------------------------------------------------------- */

export const PUBLIC_URL = 'https://buy.example.test'

export async function testBuyApp(overrides: Partial<Record<keyof Config, string>> = {}) {
  const clock = new Clock()
  const paystack = fakePaystack()
  const main = fakeMain(clock.now)
  const ps = await listen(paystack.app)
  const mn = await listen(main.app)
  const handle = createDb(inject('testDatabaseUrl'), { searchPath: inject('testSchema'), max: 4 })
  afterAll(async () => {
    await handle.close()
    await ps.close()
    await mn.close()
  })
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: inject('testDatabaseUrl'),
    PUBLIC_URL,
    IP_HASH_SALT: 'buy-test-salt-salt',
    LOGIN_BOT_TOKEN,
    LOGIN_BOT_USERNAME: 'instaplay_test_login_bot',
    PAYSTACK_SECRET_KEY: PAYSTACK_KEY,
    PAYSTACK_API_URL: ps.url,
    MAIN_API_URL: mn.url,
    RELAY_SECRET,
    RELAY_PATH,
    WORKERS: 'off',
    ...overrides,
  })
  const ctx: AppContext = {
    config,
    db: handle.db,
    log: pino({ level: 'silent' }),
    now: clock.now,
    paystack: new Paystack(config.PAYSTACK_SECRET_KEY, config.PAYSTACK_API_URL),
    mainApi: createMainApi(config, clock.now),
  }
  const app = createApp(ctx, { rateLimits: { global: 10_000, login: 10_000, checkout: 10_000 } })
  const http = supertest(app)
  return { ctx, clock, http, db: handle.db, paystack, main }
}

let nextTg = 8_000_000_000 + Math.floor(Math.random() * 1_000_000) * 100
export const telegramId = () => ++nextTg

/** What the Telegram Login Widget hands the page, signed with the login bot's token */
export function widgetLogin(user: { id: number; username?: string; first_name?: string }, opts: { authDate?: number; token?: string } = {}): Record<string, string> {
  const fields: Record<string, string> = {
    id: String(user.id),
    first_name: user.first_name ?? 'Ada',
    ...(user.username ? { username: user.username } : {}),
    auth_date: String(opts.authDate ?? Math.floor(Date.now() / 1000)),
  }
  return { ...fields, hash: signTelegramLogin(fields, opts.token ?? LOGIN_BOT_TOKEN) }
}

/** A webhook exactly as Paystack posts it */
export function webhook(http: supertest.Agent | ReturnType<typeof supertest>, body: unknown, key = PAYSTACK_KEY) {
  const raw = JSON.stringify(body)
  return http.post('/api/paystack/webhook').set('content-type', 'application/json').set('x-paystack-signature', paystackSignature(raw, key)).send(raw)
}
