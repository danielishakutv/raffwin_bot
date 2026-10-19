/**
 * The relay from the sales site's backend (19 Oct): signed requests only,
 * a credit is checked against a real hourly quote, and the same payment can
 * never credit twice.
 */
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { signRelay, type CreditRequest, type RelayOperation } from '@raffwin/relay'
import { adminUsers, ledger, notifications, purchases, securityEvents, users } from '../src/db/schema'
import { member as open } from './fixtures'
import { telegramId, testApp } from './helpers'

const SECRET = 'relay-secret-'.padEnd(64, 'x')
const PREVIOUS = 'relay-previous-'.padEnd(64, 'y')
const PATH = 'p7Qk2mZr9vXc4hTn8bLw6sJd'
const { http, db, ctx, clock } = testApp({ RELAY_SECRET: SECRET, RELAY_SECRET_PREVIOUS: PREVIOUS, RELAY_PATH: PATH, PUBLIC_APP_URL: 'https://raffwintest.example/' })

function relay(op: RelayOperation, body: unknown, opts: { secret?: string; now?: number; raw?: string; path?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(body)
  return http
    .post(`/internal/${opts.path ?? PATH}/${op}`)
    .set(signRelay(opts.secret ?? SECRET, op, raw, opts.now ?? ctx.now()))
    .send(raw)
}

async function account(tg: number) {
  const res = await relay('account', { telegramId: tg })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body
}

/** A credit exactly as the sales site would build it from the rate it was given */
async function goodCredit(tg: number, naira: number, bonusPercent = 0): Promise<CreditRequest> {
  const { rate } = await account(tg)
  const nairaKobo = naira * 100
  const baseRaffs = Math.floor(nairaKobo / rate.nairaPerRaffKobo)
  return {
    reference: `ps_${randomUUID().replaceAll('-', '')}`,
    source: 'paystack',
    telegramId: tg,
    quoteId: randomUUID(),
    nairaKobo,
    rateId: rate.id,
    nairaPerRaffKobo: rate.nairaPerRaffKobo,
    baseRaffs,
    bonusRaffs: Math.floor((baseRaffs * bonusPercent) / 100),
    paidAt: new Date(ctx.now()).toISOString(),
  }
}

const events = (kind: string) => db.select().from(securityEvents).where(eq(securityEvents.kind, kind))

describe('relay signatures', () => {
  it('answers a signed account request, and refuses one that is unsigned, re-signed or old', async () => {
    const tg = telegramId()
    expect(await account(tg)).toMatchObject({ exists: false, rate: { nairaPerRaffKobo: expect.any(Number), baseNairaPerRaffKobo: 1000 } })

    const unsigned = await http.post(`/internal/${PATH}/account`).set('content-type', 'application/json').send(JSON.stringify({ telegramId: tg }))
    expect(unsigned.status).toBe(401)
    expect((await relay('account', { telegramId: tg }, { secret: 'z'.repeat(64) })).status).toBe(401)
    expect((await relay('account', { telegramId: tg }, { now: ctx.now() - 301_000 })).status).toBe(401)
    expect((await events('relay_missing')).length).toBeGreaterThan(0)
    expect((await events('relay_bad_signature')).length).toBeGreaterThan(0)
    expect((await events('relay_stale')).length).toBeGreaterThan(0)
    // The recorded route never carries the secret path
    const [ev] = await events('relay_bad_signature')
    expect(ev?.route).toBe('POST /internal/*/account')
  })

  it('a signed account request cannot be replayed as a credit', async () => {
    const credit = await goodCredit(telegramId(), 1000)
    const raw = JSON.stringify(credit)
    const res = await http.post(`/internal/${PATH}/credit`).set(signRelay(SECRET, 'account', raw, ctx.now())).send(raw)
    expect(res.status).toBe(401)
  })

  it('accepts the previous secret during a rotation', async () => {
    expect((await relay('account', { telegramId: telegramId() }, { secret: PREVIOUS })).status).toBe(200)
  })

  it('is not there at a wrong path, or for an unknown operation', async () => {
    expect((await relay('account', { telegramId: 1 }, { path: 'wrong-path-wrong-path-wrong' })).status).toBe(404)
    const raw = '{}'
    expect((await http.post(`/internal/${PATH}/delete`).set(signRelay(SECRET, 'account', raw)).send(raw)).status).toBe(404)
  })

  it('reports a player, their balance and the sales options', async () => {
    const m = await open(http)
    const body = await account(m.telegramId)
    expect(body).toMatchObject({ exists: true, status: 'active', balance: 0, sales: { minNaira: 500, maxNaira: 500_000 } })
    expect(body.sales.packages).toHaveLength(4)
  })
})

describe('relay credits', () => {
  it('credits once, writes the ledger and the purchase, and the bot tells the player', async () => {
    const m = await open(http)
    const c = await goodCredit(m.telegramId, 5000, 5)
    const first = await relay('credit', c)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const raffs = c.baseRaffs + c.bonusRaffs
    expect(first.body).toMatchObject({ status: 'credited', raffs, balance: raffs })

    const [p] = await db.select().from(purchases).where(eq(purchases.reference, c.reference))
    expect(p).toMatchObject({ userId: m.userId, nairaKobo: 500_000, raffs, source: 'paystack' })
    const [entry] = await db.select().from(ledger).where(eq(ledger.id, p!.ledgerId))
    expect(entry).toMatchObject({ type: 'purchase', raffs, referenceType: 'purchase', referenceId: p!.id })
    const [msg] = await db.select().from(notifications).where(and(eq(notifications.userId, m.userId), eq(notifications.kind, 'purchase')))
    expect(msg?.text).toContain(`${raffs.toLocaleString('en-NG')} Raffs are in your balance`)
    expect(msg?.text).toContain('₦5,000')
    expect(msg?.buttons).toEqual([[{ text: 'Open my wallet', webApp: 'https://raffwintest.example/#/wallet' }]])

    // The same payment again: same answer, no second credit
    const again = await relay('credit', c)
    expect(again.body).toMatchObject({ status: 'already_credited', creditId: first.body.creditId, raffs, balance: raffs })
    expect((await m.get('/v1/bootstrap')).body.balance).toBe(raffs)

    // The same reference with other figures
    const changed = await relay('credit', { ...c, nairaKobo: 600_000, baseRaffs: Math.floor(600_000 / c.nairaPerRaffKobo) })
    expect(changed.status).toBe(409)
    expect(changed.body.error.code).toBe('reference_conflict')
    expect((await events('relay_reference_conflict')).length).toBeGreaterThan(0)
  })

  it('many deliveries of one payment at the same moment credit it once', async () => {
    const m = await open(http)
    const c = await goodCredit(m.telegramId, 1000)
    const results = await Promise.all(Array.from({ length: 6 }, () => relay('credit', c)))
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(results.filter((r) => r.body.status === 'credited')).toHaveLength(1)
    expect(await db.select().from(purchases).where(eq(purchases.reference, c.reference))).toHaveLength(1)
    expect((await m.get('/v1/bootstrap')).body.balance).toBe(c.baseRaffs)
  })

  it('refuses amounts that do not add up, whoever signed them', async () => {
    const m = await open(http)
    const c = await goodCredit(m.telegramId, 2000)
    const cases: [string, Partial<CreditRequest>][] = [
      ['a made-up rate', { nairaPerRaffKobo: c.nairaPerRaffKobo + 1, baseRaffs: Math.floor(c.nairaKobo / (c.nairaPerRaffKobo + 1)) }],
      ['an unknown quote', { rateId: randomUUID() }],
      ['more Raffs than the naira buys', { baseRaffs: c.baseRaffs + 1 }],
      ['a bonus above 15%', { bonusRaffs: Math.floor(c.baseRaffs * 0.2) }],
      ['a payment long after the quote', { paidAt: new Date(ctx.now() + 6 * 3_600_000).toISOString() }],
      ['above the maximum', { nairaKobo: 600_000_00, baseRaffs: Math.floor(600_000_00 / c.nairaPerRaffKobo) }],
    ]
    for (const [why, change] of cases) {
      const res = await relay('credit', { ...c, reference: `ps_${randomUUID().slice(0, 18)}`, ...change })
      expect(res.status, why).toBe(422)
      expect(res.body.error.code, why).toBe('out_of_bounds')
    }
    expect((await m.get('/v1/bootstrap')).body.balance).toBe(0)
    expect(await db.select().from(purchases).where(eq(purchases.userId, m.userId))).toHaveLength(0)
    expect((await events('relay_out_of_bounds')).length).toBeGreaterThanOrEqual(cases.length)
  })

  it('refuses a player who does not exist or is suspended, and malformed bodies', async () => {
    const nobody = await goodCredit(telegramId(), 1000)
    expect((await relay('credit', nobody)).status).toBe(404)

    const m = await open(http)
    const c = await goodCredit(m.telegramId, 1000)
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, m.userId))
    const res = await relay('credit', c)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('account_suspended')
    expect((await account(m.telegramId)).status).toBe('suspended')

    expect((await relay('credit', { ...c, raffs: 99 })).status).toBe(400)
    expect((await relay('credit', null, { raw: 'not json' })).status).toBe(400)
  })

  it('a quote from an earlier hour still credits within its window', async () => {
    const m = await open(http)
    const c = await goodCredit(m.telegramId, 1000)
    // The buyer took 90 minutes to pay; the rate has moved on since
    clock.advance(90 * 60)
    const res = await relay('credit', { ...c, paidAt: new Date(ctx.now()).toISOString() })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.raffs).toBe(c.baseRaffs)
    clock.advance(-90 * 60)
  })
})

describe('relay flags', () => {
  it('records a flagged payment once and tells the super and finance admins', async () => {
    const sent: [number, string][] = []
    ctx.sendTelegram = async (chatId, text) => {
      sent.push([chatId, text])
    }
    const tg = telegramId()
    await db.insert(adminUsers).values([
      { name: 'Boss', username: `boss_${tg}`, telegramUsername: `boss${tg}`, telegramId: tg, role: 'super_admin', passwordHash: 'x' },
      { name: 'Viewer', username: `view_${tg}`, telegramUsername: `view${tg}`, telegramId: tg + 1, role: 'viewer', passwordHash: 'x' },
    ])
    const flag = { reference: `ps_flag_${tg}`, kind: 'late_payment', telegramId: 42, nairaKobo: 250_000, detail: 'Paid 3 h after the quote' }
    const res = await relay('flag', flag)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ recorded: true })
    expect((await relay('flag', flag)).body).toEqual({ recorded: false })
    const ev = (await events('sales_late_payment')).filter((e) => (e.details as { reference?: string }).reference === flag.reference)
    expect(ev).toHaveLength(1)
    const toBoss = sent.filter(([id]) => id === tg)
    expect(toBoss).toHaveLength(1)
    expect(toBoss[0]![1]).toContain('Paid after the quote ran out')
    expect(toBoss[0]![1]).toContain('₦2,500')
    expect(sent.some(([id]) => id === tg + 1)).toBe(false)
    ctx.sendTelegram = undefined
  })

  it('refuses an unknown kind', async () => {
    expect((await relay('flag', { reference: 'ps_abcdef', kind: 'whatever', telegramId: null, nairaKobo: null, detail: '' })).status).toBe(400)
  })
})

describe('relay switched off or fenced', () => {
  const off = testApp()
  const fenced = testApp({ RELAY_SECRET: SECRET, RELAY_PATH: PATH, RELAY_ALLOWED_IPS: '203.0.113.7', RELAY_CLIENT_IP_HEADER: 'x-test-client-ip' })

  it('does not exist without a secret and a path', async () => {
    const raw = JSON.stringify({ telegramId: 1 })
    expect((await off.http.post(`/internal/${PATH}/account`).set(signRelay(SECRET, 'account', raw)).send(raw)).status).toBe(404)
  })

  it('takes only the allowed address when an allowlist is set', async () => {
    const raw = JSON.stringify({ telegramId: 1 })
    const from = (ip: string) => fenced.http.post(`/internal/${PATH}/account`).set(signRelay(SECRET, 'account', raw)).set('x-test-client-ip', ip).send(raw)
    expect((await from('198.51.100.1')).status).toBe(401)
    expect((await from('203.0.113.7')).status).toBe(200)
  })
})
