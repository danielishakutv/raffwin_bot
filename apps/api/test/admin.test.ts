import { randomUUID } from 'node:crypto'
import { and, eq, gte, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { AdminApproval, AdminOverview, AdminRaffle, AdminUserDetail } from '@raffwin/shared/admin-types'
import { verifyChain } from '../src/admin/audit'
import { hashPassword, issueTicket } from '../src/admin/session'
import { recordSecurityEvent } from '../src/lib/security-events'
import { adminSessions, adminUsers, raffles, securityEvents, type AdminRole } from '../src/db/schema'
import { createRaffle, credit, member } from './fixtures'
import { initData, telegramId, testApp } from './helpers'

const { http, db, ctx, clock } = testApp()

interface Admin {
  id: string
  telegramId: number
  token: string
}

/** A bound admin (as after their first bot sign-in), straight into the database. */
async function insertAdmin(role: AdminRole) {
  const tg = telegramId()
  const [row] = await db
    .insert(adminUsers)
    .values({ telegramId: tg, telegramUsername: `tg${tg}`, username: `u${tg}`, name: `${role} admin`, role, passwordHash: await hashPassword('pw') })
    .returning({ id: adminUsers.id })
  return { id: row?.id as string, telegramId: tg }
}

/** Signs in the way the admin screen does: a bot ticket plus this account's initData. */
async function makeAdmin(role: AdminRole): Promise<Admin> {
  const a = await insertAdmin(role)
  const ticket = await issueTicket(ctx, a.id, a.telegramId)
  const res = await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: a.telegramId }) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { ...a, token: res.body.token as string }
}

const auth = (a: Admin) => ({ authorization: `Bearer ${a.token}` })
const get = (a: Admin, path: string) => http.get(path).set(auth(a))
const write = (a: Admin, path: string, body: object = {}) => http.post(path).set(auth(a)).send(body)
const put = (a: Admin, path: string, body: object) => http.put(path).set(auth(a)).send(body)

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

describe('admin sessions from bot tickets', () => {
  it('opens a session from a fresh ticket and knows who you are', async () => {
    const a = await makeAdmin('viewer')
    const me = await get(a, '/admin/v1/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ role: 'viewer', telegramId: a.telegramId })
    expect(me.body.permissions).not.toContain('raffles.write')
  })

  it('shows the admin entry only to admins, but the entry alone opens nothing', async () => {
    const a = await insertAdmin('viewer')
    const login = await http.post('/v1/auth/telegram').send({ initData: initData({ id: a.telegramId }) })
    const boot = await http.get('/v1/bootstrap').set('authorization', `Bearer ${login.body.accessToken}`)
    expect(boot.body.profile.isAdmin).toBe(true)
    expect((await http.get('/admin/v1/me').set('authorization', `Bearer ${login.body.accessToken}`)).status).toBe(401)
    const player = await member(http)
    expect((await player.get('/v1/bootstrap')).body.profile.isAdmin).toBe(false)
  })

  it('accepts a ticket once only', async () => {
    const a = await insertAdmin('viewer')
    const ticket = await issueTicket(ctx, a.id, a.telegramId)
    const body = { ticket, initData: initData({ id: a.telegramId }) }
    expect((await http.post('/admin/v1/auth/ticket').send(body)).status).toBe(200)
    expect((await http.post('/admin/v1/auth/ticket').send(body)).status).toBe(401)
  })

  it('refuses a ticket from another Telegram account, or with forged initData', async () => {
    const since = new Date(Date.now() - 1000)
    const a = await insertAdmin('super_admin')
    const ticket = await issueTicket(ctx, a.id, a.telegramId)
    const stolen = await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: telegramId() }) })
    expect(stolen.status).toBe(401)
    const t2 = await issueTicket(ctx, a.id, a.telegramId)
    const forged = initData({ id: a.telegramId }, { token: '42:a-different-bot-token-a-different-bot' })
    expect((await http.post('/admin/v1/auth/ticket').send({ ticket: t2, initData: forged })).status).toBe(401)
    const events = await db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.kind, 'admin_ticket_other_account'), gte(securityEvents.occurredAt, since)))
    expect(events.length).toBe(1)
  })

  it('refuses an expired ticket', async () => {
    const a = await insertAdmin('viewer')
    const ticket = await issueTicket(ctx, a.id, a.telegramId)
    clock.advance(6 * 60)
    try {
      expect((await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: a.telegramId }) })).status).toBe(401)
    } finally {
      clock.advance(-6 * 60)
    }
  })

  it('needs the bearer token, and ends idle and logged-out sessions', async () => {
    expect((await http.get('/admin/v1/me')).status).toBe(401)
    const a = await makeAdmin('viewer')
    await db.update(adminSessions).set({ lastSeenAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(adminSessions.adminId, a.id))
    expect((await get(a, '/admin/v1/me')).status).toBe(401)
    const b = await makeAdmin('viewer')
    expect((await write(b, '/admin/v1/auth/logout')).status).toBe(204)
    expect((await get(b, '/admin/v1/me')).status).toBe(401)
  })

  it('audits every request, reads included', async () => {
    const a = await makeAdmin('viewer')
    await get(a, '/admin/v1/overview')
    await new Promise((r) => setTimeout(r, 300)) // the audit row is written just after the response
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from audit_log where admin_id = ${a.id} and action = 'admin.request' and target_id = 'GET /admin/v1/overview'`,
    )
    expect(rows.rows[0]?.n).toBe(1)
  })
})

describe('admin management', () => {
  it('lets a super admin add an admin with a one-time password, and nobody else', async () => {
    const boss = await makeAdmin('super_admin')
    const handle = `chidi_${randomUUID().slice(0, 6)}`
    const res = await write(boss, '/admin/v1/admins', { name: 'Chidi Okafor', username: handle, telegramUsername: `@${handle.toUpperCase()}`, role: 'finance' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.password).toMatch(/^[A-Za-z2-9]{16}$/)
    expect(res.body.admin).toMatchObject({ username: handle, telegramUsername: handle, telegramBound: false, role: 'finance' })
    const list = (await get(boss, '/admin/v1/admins')).body as { username: string }[]
    expect(list.map((x) => x.username)).toContain(handle)
    const fin = await makeAdmin('finance')
    expect((await write(fin, '/admin/v1/admins', { name: 'X Y', username: 'xyz', telegramUsername: 'xyxyx', role: 'viewer' })).status).toBe(403)
  })

  it('disabling an admin ends their sessions', async () => {
    const boss = await makeAdmin('super_admin')
    const other = await makeAdmin('viewer')
    expect((await write(boss, `/admin/v1/admins/${other.id}/disable`)).body.status).toBe('disabled')
    expect((await get(other, '/admin/v1/me')).status).toBe(401)
    expect((await write(boss, `/admin/v1/admins/${boss.id}/disable`)).status).toBe(400)
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

    const detail = (await get(boss, `/admin/v1/users/${player.userId}`)).body as AdminUserDetail
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
    expect((await get(boss, '/admin/v1/settings')).body.baseStarsPerRaff).toBe(0.8)
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
    const byName = (await get(v, `/admin/v1/users?q=${player.username}`)).body
    expect(byName.map((u: { id: string }) => u.id)).toContain(player.userId)
    const byTg = (await get(v, `/admin/v1/users?q=${player.telegramId}`)).body
    expect(byTg[0].id).toBe(player.userId)
  })
})

describe('overview, security events and the audit log', () => {
  it('reports a consistent ledger', async () => {
    const v = await makeAdmin('viewer')
    const o = (await get(v, '/admin/v1/overview')).body as AdminOverview
    expect(o.ledgerConsistent).toBe(true)
    expect(o.rate.baseStarsPerRaff).toBeGreaterThan(0)
    expect(Math.abs(o.rate.movePct)).toBeGreaterThanOrEqual(3)
    expect(Math.abs(o.rate.movePct)).toBeLessThanOrEqual(15)
  })

  it('pages security events without repeats', async () => {
    const v = await makeAdmin('viewer')
    // Enough events of its own that paging is exercised whatever ran before
    for (let i = 0; i < 15; i += 1) {
      await recordSecurityEvent(db, ctx.log, { severity: 'low', category: 'auth', kind: 'paging_fixture', ipHash: null, route: 'test' })
    }
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 50; i += 1) {
      const path: string = `/admin/v1/security-events?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = (await get(v, path)).body as { items: { id: string }[]; nextCursor: string | null }
      seen.push(...page.items.map((e) => e.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen.length).toBeGreaterThan(7)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('keeps an intact hash chain, and detects tampering', async () => {
    const v = await makeAdmin('viewer')
    expect((await get(v, '/admin/v1/audit-log/verify')).body).toMatchObject({ ok: true, brokenAt: null })

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
