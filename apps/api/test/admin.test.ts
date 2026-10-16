import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import supertest from 'supertest'
import { describe, expect, it } from 'vitest'
import type { AdminApproval, AdminOverview, AdminRaffle, AdminUserDetail } from '@raffwin/shared/admin-types'
import { verifyChain } from '../src/admin/audit'
import { hashPassword } from '../src/admin/session'
import { adminSessions, adminUsers, raffles, type AdminRole } from '../src/db/schema'
import { encrypt, newTotpSecret, parseDataKey, totpCode, totpStep } from '../src/lib/admin-crypto'
import { createRaffle, credit, member } from './fixtures'
import { TEST_ADMIN_DATA_KEY, testApp } from './helpers'

const { app, http, db } = testApp()

interface Admin {
  id: string
  email: string
  password: string
  secret: string
  agent: ReturnType<typeof supertest.agent>
}

/** The current TOTP code. Each test admin signs in once, so its code is never reused by accident. */
function nextCode(secret: string) {
  return totpCode(secret, totpStep(Date.now()))
}

async function makeAdmin(role: AdminRole): Promise<Admin> {
  const email = `${role}.${randomUUID().slice(0, 8)}@example.com`
  const password = `pw-${randomUUID()}`
  const secret = newTotpSecret()
  const [row] = await db
    .insert(adminUsers)
    .values({
      email,
      name: `${role} admin`,
      role,
      passwordHash: await hashPassword(password),
      totpSecretEnc: encrypt(secret, parseDataKey(TEST_ADMIN_DATA_KEY)),
    })
    .returning({ id: adminUsers.id })
  const agent = supertest.agent(app)
  const res = await agent.post('/admin/v1/auth/login').send({ email, password, code: nextCode(secret) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { id: row?.id as string, email, password, secret, agent }
}

/** Writes need the CSRF header; this sets it. */
const write = (a: Admin, path: string, body: object = {}) => a.agent.post(path).set('x-raffwin-admin', '1').send(body)
const put = (a: Admin, path: string, body: object) => a.agent.put(path).set('x-raffwin-admin', '1').send(body)

function raffleInput(overrides: Record<string, unknown> = {}) {
  return {
    prizeName: 'Samsung Galaxy A15',
    model: '128GB',
    category: 'Phones',
    kind: 'phone',
    marketPriceNaira: 210_000,
    entryPriceRaffs: 50,
    entriesTarget: 500,
    deadline: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    description: 'Brand new, sealed.',
    rules: ['Three winners'],
    prizes: [
      { position: 1, prizeItem: 'Samsung Galaxy A15', prizeType: 'physical' },
      { position: 2, prizeItem: '10,000 Raffs credit', prizeType: 'raffs_credit', raffsValue: 10_000 },
      { position: 3, prizeItem: '2,000 Raffs credit', prizeType: 'raffs_credit', raffsValue: 2_000 },
    ],
    ...overrides,
  }
}

describe('admin sign-in', () => {
  it('signs in with password and code, and knows who you are', async () => {
    const a = await makeAdmin('viewer')
    const meRes = await a.agent.get('/admin/v1/me')
    expect(meRes.status).toBe(200)
    expect(meRes.body).toMatchObject({ email: a.email, role: 'viewer' })
    expect(meRes.body.permissions).toContain('raffles.read')
    expect(meRes.body.permissions).not.toContain('raffles.write')
  })

  it('sets a strict, HttpOnly cookie scoped to /admin', async () => {
    const email = `cookie.${randomUUID().slice(0, 6)}@example.com`
    const secret = newTotpSecret()
    const password = 'correct horse battery staple'
    await db.insert(adminUsers).values({
      email,
      name: 'Cookie',
      role: 'viewer',
      passwordHash: await hashPassword(password),
      totpSecretEnc: encrypt(secret, parseDataKey(TEST_ADMIN_DATA_KEY)),
    })
    const res = await http.post('/admin/v1/auth/login').send({ email, password, code: nextCode(secret) })
    const cookie = String(res.headers['set-cookie'])
    expect(cookie).toMatch(/rw_admin=/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Strict/i)
    expect(cookie).toMatch(/Path=\/admin/)
  })

  it('gives one generic error for a wrong password, code or email', async () => {
    const a = await makeAdmin('viewer')
    const bad = [
      { email: a.email, password: 'wrong', code: nextCode(a.secret) },
      { email: a.email, password: a.password, code: '000000' },
      { email: 'nobody@example.com', password: a.password, code: nextCode(a.secret) },
    ]
    for (const body of bad) {
      const res = await http.post('/admin/v1/auth/login').send(body)
      expect(res.status).toBe(401)
      expect(res.body.error.message).toBe('Email, password or code is wrong.')
    }
  })

  it('refuses the same code twice', async () => {
    const a = await makeAdmin('viewer')
    // makeAdmin used this step's code; the next step is inside the +/-1 window and still unused
    const code = totpCode(a.secret, totpStep(Date.now()) + 1)
    expect((await http.post('/admin/v1/auth/login').send({ email: a.email, password: a.password, code })).status).toBe(200)
    expect((await http.post('/admin/v1/auth/login').send({ email: a.email, password: a.password, code })).status).toBe(401)
  })

  it('locks the account after 5 failures', async () => {
    const a = await makeAdmin('viewer')
    for (let i = 0; i < 5; i += 1) {
      await http.post('/admin/v1/auth/login').send({ email: a.email, password: 'nope', code: '123456' })
    }
    const res = await http.post('/admin/v1/auth/login').send({ email: a.email, password: a.password, code: nextCode(a.secret) })
    expect(res.status).toBe(429)
    expect(res.body.error.message).toMatch(/Try again in \d+ minute/)
  })

  it('ends an idle session and a logged-out one', async () => {
    const a = await makeAdmin('viewer')
    await db.update(adminSessions).set({ lastSeenAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(adminSessions.adminId, a.id))
    expect((await a.agent.get('/admin/v1/me')).status).toBe(401)

    const b = await makeAdmin('viewer')
    expect((await write(b, '/admin/v1/auth/logout')).status).toBe(204)
    expect((await b.agent.get('/admin/v1/me')).status).toBe(401)
  })

  it('refuses writes without the admin header (CSRF)', async () => {
    const a = await makeAdmin('super_admin')
    const res = await a.agent.post('/admin/v1/raffles').send(raffleInput())
    expect(res.status).toBe(401)
    expect(res.body.error.message).toMatch(/missing admin header/)
  })
})

describe('roles', () => {
  it('stops a viewer from writing', async () => {
    const v = await makeAdmin('viewer')
    const res = await write(v, '/admin/v1/raffles', raffleInput())
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })
})

describe('raffle management', () => {
  it('drafts are invisible to players until opened, then fixed', async () => {
    const m = await makeAdmin('raffle_manager')
    const created = await write(m, '/admin/v1/raffles', raffleInput())
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const raffle = created.body as AdminRaffle
    expect(raffle).toMatchObject({ status: 'draft', entryPriceRaffs: 50 })
    expect(raffle.prizes).toHaveLength(3)

    const player = await member(http)
    expect((await player.get(`/v1/raffles/${raffle.id}`)).status).toBe(404)

    const edited = await put(m, `/admin/v1/raffles/${raffle.id}`, raffleInput({ entryPriceRaffs: 60 }))
    expect(edited.body.entryPriceRaffs).toBe(60)

    const opened = await write(m, `/admin/v1/raffles/${raffle.id}/open`)
    expect(opened.body.status).toBe('open')
    expect((await player.get(`/v1/raffles/${raffle.id}`)).body.entryPriceRaffs).toBe(60)

    const late = await put(m, `/admin/v1/raffles/${raffle.id}`, raffleInput({ entryPriceRaffs: 1 }))
    expect(late.status).toBe(400)
    expect(late.body.error.message).toMatch(/Only drafts can be edited/)
  })

  it('validates the raffle form', async () => {
    const m = await makeAdmin('raffle_manager')
    const res = await write(m, '/admin/v1/raffles', raffleInput({ prizes: [], entryPriceRaffs: 0 }))
    expect(res.status).toBe(400)
    expect(Object.keys(res.body.error.fields)).toEqual(expect.arrayContaining(['entryPriceRaffs', 'prizes']))
  })

  it('will not open a raffle that closes within the hour', async () => {
    const m = await makeAdmin('raffle_manager')
    const created = await write(m, '/admin/v1/raffles', raffleInput({ deadline: new Date(Date.now() + 10 * 60_000).toISOString() }))
    const res = await write(m, `/admin/v1/raffles/${created.body.id}/open`)
    expect(res.status).toBe(400)
  })
})

describe('maker-checker', () => {
  it('cancels a raffle only with a second admin, refunding entries and reversing referral pay', async () => {
    const manager = await makeAdmin('raffle_manager')
    const finance = await makeAdmin('finance')
    const boss = await makeAdmin('super_admin')

    const referrer = await member(http)
    const player = await member(http, { startParam: `ref_${referrer.referralCode}` })
    await credit(db, player.userId, 1000)
    const raffle = await createRaffle(db, { entryPriceRaffs: 100 })
    await player.post('/v1/entries', { raffleId: raffle.id, qty: 3, idempotencyKey: randomUUID() })
    expect((await player.get('/v1/bootstrap')).body.balance).toBe(700)
    expect((await referrer.get('/v1/bootstrap')).body.balance).toBe(30)

    const asked = await write(manager, `/admin/v1/raffles/${raffle.id}/cancel`, { reason: 'Supplier fell through' })
    expect(asked.status).toBe(202)
    const approval = asked.body as AdminApproval
    expect(approval).toMatchObject({ status: 'pending', action: 'raffle_cancel' })
    expect(approval.summary).toMatch(/refund 3 entries/)

    // Nothing has happened yet
    const [still] = await db.select().from(raffles).where(eq(raffles.id, raffle.id))
    expect(still?.status).toBe('open')

    // A super_admin cannot approve their own request
    const selfAsk = await write(boss, `/admin/v1/users/${player.userId}/adjust`, { raffs: 5, reason: 'goodwill credit' })
    const selfApprove = await write(boss, `/admin/v1/approvals/${selfAsk.body.id}/approve`)
    expect(selfApprove.status).toBe(403)

    const ok = await write(finance, `/admin/v1/approvals/${approval.id}/approve`, { note: 'Confirmed with supplier' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body).toMatchObject({ status: 'approved', result: { entriesRefunded: 1, raffsRefunded: 300, referralRaffsReversed: 30 } })

    expect((await player.get('/v1/bootstrap')).body.balance).toBe(1000)
    expect((await referrer.get('/v1/bootstrap')).body.balance).toBe(0)
    const [after] = await db.select().from(raffles).where(eq(raffles.id, raffle.id))
    expect(after?.status).toBe('cancelled')

    const twice = await write(boss, `/admin/v1/approvals/${approval.id}/approve`)
    expect(twice.status).toBe(400)
  })

  it('credits a player only once a second admin approves', async () => {
    const finance = await makeAdmin('finance')
    const boss = await makeAdmin('super_admin')
    const player = await member(http)
    const asked = await write(finance, `/admin/v1/users/${player.userId}/adjust`, { raffs: 250, reason: 'Failed payment refund' })
    expect(asked.status).toBe(202)
    expect((await player.get('/v1/bootstrap')).body.balance).toBe(0)

    const ok = await write(boss, `/admin/v1/approvals/${asked.body.id}/approve`)
    expect(ok.body.status).toBe('approved')
    const boot = (await player.get('/v1/bootstrap')).body
    expect(boot.balance).toBe(250)
    expect(boot.transactions[0]).toMatchObject({ type: 'adjustment', raffs: 250 })

    const detail = (await boss.agent.get(`/admin/v1/users/${player.userId}`)).body as AdminUserDetail
    expect(detail.ledgerBalance).toBe(detail.user.balance)
  })

  it('rejects without side effects', async () => {
    const finance = await makeAdmin('finance')
    const boss = await makeAdmin('super_admin')
    const player = await member(http)
    const asked = await write(finance, `/admin/v1/users/${player.userId}/adjust`, { raffs: 999, reason: 'typo request' })
    const no = await write(boss, `/admin/v1/approvals/${asked.body.id}/reject`, { note: 'wrong amount' })
    expect(no.body.status).toBe('rejected')
    expect((await player.get('/v1/bootstrap')).body.balance).toBe(0)
  })

  it('changes the rate base from the next hour once approved', async () => {
    const finance = await makeAdmin('finance')
    const boss = await makeAdmin('super_admin')
    const asked = await write(finance, '/admin/v1/settings/rate-base', { starsPerRaff: 0.8, reason: 'Fragment payout dropped' })
    expect(asked.body.summary).toBe('Change the base rate from 0.5 to 0.8 Stars per Raff')
    await write(boss, `/admin/v1/approvals/${asked.body.id}/approve`)
    expect((await boss.agent.get('/admin/v1/settings')).body.baseStarsPerRaff).toBe(0.8)
    // put it back for the other tests
    const back = await write(boss, '/admin/v1/settings/rate-base', { starsPerRaff: 0.5, reason: 'restore test base' })
    await write(finance, `/admin/v1/approvals/${back.body.id}/approve`)
  })
})

describe('user management', () => {
  it('suspending a player signs them out at once', async () => {
    const support = await makeAdmin('support')
    const player = await member(http)
    expect((await player.get('/v1/bootstrap')).status).toBe(200)
    const res = await write(support, `/admin/v1/users/${player.userId}/suspend`, { reason: 'Multiple accounts' })
    expect(res.body.user.status).toBe('suspended')
    expect((await player.get('/v1/bootstrap')).status).toBe(401)
  })

  it('finds players by username or Telegram id', async () => {
    const v = await makeAdmin('viewer')
    const player = await member(http)
    const byName = (await v.agent.get(`/admin/v1/users?q=${player.username}`)).body
    expect(byName.map((u: { id: string }) => u.id)).toContain(player.userId)
    const byTg = (await v.agent.get(`/admin/v1/users?q=${player.telegramId}`)).body
    expect(byTg[0].id).toBe(player.userId)
  })
})

describe('overview, security events and the audit log', () => {
  it('reports a consistent ledger', async () => {
    const v = await makeAdmin('viewer')
    const o = (await v.agent.get('/admin/v1/overview')).body as AdminOverview
    expect(o.ledgerConsistent).toBe(true)
    expect(o.rate.baseStarsPerRaff).toBeGreaterThan(0)
    expect(Math.abs(o.rate.movePct)).toBeGreaterThanOrEqual(3)
    expect(Math.abs(o.rate.movePct)).toBeLessThanOrEqual(15)
  })

  it('pages security events without repeats', async () => {
    const v = await makeAdmin('viewer')
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 50; i += 1) {
      const path: string = `/admin/v1/security-events?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = (await v.agent.get(path)).body as { items: { id: string }[]; nextCursor: string | null }
      seen.push(...page.items.map((e) => e.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen.length).toBeGreaterThan(7)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('keeps an intact hash chain, and detects tampering', async () => {
    const v = await makeAdmin('viewer')
    expect((await v.agent.get('/admin/v1/audit-log/verify')).body).toMatchObject({ ok: true, brokenAt: null })

    // The append-only trigger normally stops this; switch it off to prove the chain catches it
    await db.execute(sql`alter table audit_log disable trigger audit_log_append_only`)
    try {
      const [row] = (await db.execute<{ seq: number }>(sql`select seq from audit_log order by seq limit 1 offset 1`)).rows
      await db.execute(sql`update audit_log set action = 'innocent.looking' where seq = ${row?.seq}`)
      const check = await verifyChain(db)
      expect(check).toMatchObject({ ok: false, brokenAt: Number(row?.seq) })
    } finally {
      await db.execute(sql`alter table audit_log enable trigger audit_log_append_only`)
    }
  })
})
