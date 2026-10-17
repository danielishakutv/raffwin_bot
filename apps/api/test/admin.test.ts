import { randomUUID } from 'node:crypto'
import { and, eq, gte, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { AdminApproval, AdminFinance, AdminOverview, AdminRaffle, AdminUserDetail } from '@raffwin/shared/admin-types'
import { verifyChain } from '../src/admin/audit'
import { hashPassword, issueTicket } from '../src/admin/session'
import { recordSecurityEvent } from '../src/lib/security-events'
import { adminSessions, adminUsers, raffles, securityEvents, type AdminRole } from '../src/db/schema'
import { createRaffle, credit, member as open } from './fixtures'
import { contactProof, initData, nigerianPhone, telegramId, testApp } from './helpers'

const { http, db, ctx, clock } = testApp()

/**
 * A player who has shared their phone (the onboarding step): entering a raffle
 * needs one while require_phone_for_entry is on, its default.
 */
async function member(...args: Parameters<typeof open>) {
  const m = await open(...args)
  const res = await m.put('/v1/phone', { contactProof: contactProof(m.telegramId, nigerianPhone().slice(1)) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return m
}

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

  it('keeps super admins signed in for 2 hours idle, other roles for 30 minutes', async () => {
    const boss = await makeAdmin('super_admin')
    const viewer = await makeAdmin('viewer')
    const idleFor = (a: Admin, minutes: number) =>
      db.execute(sql`update admin_sessions set last_seen_at = now() - make_interval(mins => ${minutes}) where admin_id = ${a.id}`)
    await idleFor(boss, 45)
    await idleFor(viewer, 45)
    expect((await get(viewer, '/admin/v1/me')).status).toBe(401)
    expect((await get(boss, '/admin/v1/me')).status).toBe(200)
    await idleFor(boss, 125)
    expect((await get(boss, '/admin/v1/me')).status).toBe(401)
  })

  it('resumes a stored session only with initData from the bound account', async () => {
    const boss = await makeAdmin('super_admin')
    const resumed = await write(boss, '/admin/v1/auth/resume', { initData: initData({ id: boss.telegramId }) })
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200)
    expect(resumed.body).toMatchObject({ token: boss.token, idleMinutes: 120, admin: { role: 'super_admin' } })

    const other = await write(boss, '/admin/v1/auth/resume', { initData: initData({ id: telegramId() }) })
    expect(other.status).toBe(401)
    // A token presented from another account is revoked, not just refused
    expect((await get(boss, '/admin/v1/me')).status).toBe(401)
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
    // A raffle manager may edit drafts only; open raffles are for super admins
    expect(late.status).toBe(403)
    expect(late.body.error.message).toMatch(/Only a super admin can change a raffle that is open/)
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

    // Nobody approves their own request (finance asks, then tries to approve it)
    const selfAsk = await write(finance, `/admin/v1/users/${player.userId}/adjust`, { raffs: 5, reason: 'goodwill credit' })
    expect(selfAsk.status).toBe(202)
    const selfApprove = await write(finance, `/admin/v1/approvals/${selfAsk.body.id}/approve`)
    expect(selfApprove.status).toBe(403)
    await write(boss, `/admin/v1/approvals/${selfAsk.body.id}/reject`, { note: 'test cleanup' })

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

describe('super admins act without approval', () => {
  it('cancels, adjusts and changes the rate at once, still recorded as done directly', async () => {
    const boss = await makeAdmin('super_admin')
    const player = await member(http)
    await credit(db, player.userId, 500)
    const raffle = await createRaffle(db, { entryPriceRaffs: 100 })
    await player.post('/v1/entries', { raffleId: raffle.id, qty: 2, idempotencyKey: randomUUID() })

    const cancel = await write(boss, `/admin/v1/raffles/${raffle.id}/cancel`, { reason: 'Prize unavailable' })
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200)
    expect(cancel.body).toMatchObject({ status: 'approved', decidedBy: 'done directly (super admin)', result: { raffsRefunded: 200, direct: true } })
    expect((await player.get('/v1/bootstrap')).body.balance).toBe(500)

    const adjust = await write(boss, `/admin/v1/users/${player.userId}/adjust`, { raffs: 50, reason: 'Goodwill credit' })
    expect(adjust.status).toBe(200)
    expect((await player.get('/v1/bootstrap')).body.balance).toBe(550)

    const rate = await write(boss, '/admin/v1/settings/rate-base', { starsPerRaff: 0.5, reason: 'Keep the base' })
    expect(rate.status).toBe(200)

    const history = (await get(boss, '/admin/v1/approvals?status=approved')).body as AdminApproval[]
    expect(history.some((a) => a.id === cancel.body.id)).toBe(true)
    const audit = await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where action like 'direct.%' and admin_id = ${boss.id}`)
    expect(audit.rows[0]?.n).toBe(3)
  })

  it('still queues the same actions for other roles', async () => {
    const fin = await makeAdmin('finance')
    const player = await member(http)
    const res = await write(fin, `/admin/v1/users/${player.userId}/adjust`, { raffs: 10, reason: 'needs a second admin' })
    expect(res.status).toBe(202)
    expect(res.body.status).toBe('pending')
  })
})

describe('managing open raffles', () => {
  it('lets a super admin change an open raffle, never below what is sold', async () => {
    const boss = await makeAdmin('super_admin')
    const manager = await makeAdmin('raffle_manager')
    const created = await write(boss, '/admin/v1/raffles', raffleInput())
    await write(boss, `/admin/v1/raffles/${created.body.id}/open`)
    const player = await member(http)
    await credit(db, player.userId, 1000)
    await player.post('/v1/entries', { raffleId: created.body.id, qty: 5, idempotencyKey: randomUUID() })

    const later = new Date(Date.now() + 9 * 86_400_000).toISOString()
    const edit = await put(boss, `/admin/v1/raffles/${created.body.id}`, raffleInput({ entryPriceRaffs: 70, entriesTarget: 800, deadline: later, prizes: [
      { position: 1, prizeItem: 'Samsung Galaxy A25', prizeType: 'physical', costNaira: 240_000 },
      { position: 2, prizeItem: '10,000 Raffs credit', prizeType: 'raffs_credit', raffsValue: 10_000 },
      { position: 3, prizeItem: 'Oraimo earbuds', prizeType: 'physical', costNaira: 25_000 },
    ] }))
    expect(edit.status, JSON.stringify(edit.body)).toBe(200)
    expect(edit.body).toMatchObject({ status: 'open', entryPriceRaffs: 70, entriesTarget: 800, entriesCount: 5 })
    expect(edit.body.prizes[0]).toMatchObject({ prizeItem: 'Samsung Galaxy A25', costNaira: 240_000 })

    const below = await put(boss, `/admin/v1/raffles/${created.body.id}`, raffleInput({ entriesTarget: 4 }))
    expect(below.status).toBe(400)
    expect(below.body.error.message).toMatch(/5 entries are already sold/)
    expect((await put(manager, `/admin/v1/raffles/${created.body.id}`, raffleInput())).status).toBe(403)
  })

  it('unpublishes an open raffle nobody has entered, then republishes it', async () => {
    const boss = await makeAdmin('super_admin')
    const created = await write(boss, '/admin/v1/raffles', raffleInput())
    await write(boss, `/admin/v1/raffles/${created.body.id}/open`)
    const player = await member(http)
    expect((await player.get(`/v1/raffles/${created.body.id}`)).status).toBe(200)
    const off = await write(boss, `/admin/v1/raffles/${created.body.id}/unpublish`, { reason: 'Wrong photo' })
    expect(off.body.status).toBe('draft')
    expect((await player.get(`/v1/raffles/${created.body.id}`)).status).toBe(404)
    expect((await write(boss, `/admin/v1/raffles/${created.body.id}/open`)).body.status).toBe('open')
  })

  it('refuses to unpublish once entries are sold', async () => {
    const boss = await makeAdmin('super_admin')
    const raffle = await createRaffle(db)
    const player = await member(http)
    await credit(db, player.userId, 100)
    await player.post('/v1/entries', { raffleId: raffle.id, qty: 1, idempotencyKey: randomUUID() })
    const res = await write(boss, `/admin/v1/raffles/${raffle.id}/unpublish`, { reason: 'try anyway' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/Cancel the raffle instead/)
  })
})

describe('finance', () => {
  it('reports raised, prize costs, referral pay, expenses and margin per raffle', async () => {
    const boss = await makeAdmin('super_admin')
    // Report rate: 0.5 Star per Raff x N20 per Star = N10 per Raff
    await put(boss, '/admin/v1/settings/limits', { maxEntriesPerUserPerRaffle: null, dailySpendRaffs: null, nairaPerStar: 20 })
    const created = await write(boss, '/admin/v1/raffles', raffleInput({ entryPriceRaffs: 100, prizes: [
      { position: 1, prizeItem: 'Phone', prizeType: 'physical', costNaira: 150_000 },
      { position: 2, prizeItem: '2,000 Raffs credit', prizeType: 'raffs_credit', raffsValue: 2000 },
      { position: 3, prizeItem: 'Earbuds', prizeType: 'physical', costNaira: 20_000 },
    ] }))
    await write(boss, `/admin/v1/raffles/${created.body.id}/open`)
    const referrer = await member(http)
    const player = await member(http, { startParam: `ref_${referrer.referralCode}` })
    await credit(db, player.userId, 10_000)
    await player.post('/v1/entries', { raffleId: created.body.id, qty: 50, idempotencyKey: randomUUID() })

    const exp = await write(boss, '/admin/v1/finance/expenses', { raffleId: created.body.id, category: 'delivery', amountNaira: 5_000, spentOn: new Date().toISOString(), note: 'Courier to Ojota' })
    expect(exp.status, JSON.stringify(exp.body)).toBe(201)
    const general = await write(boss, '/admin/v1/finance/expenses', { raffleId: null, category: 'operations', amountNaira: 12_000, spentOn: new Date().toISOString(), note: 'Server for October' })

    const f = (await get(boss, '/admin/v1/finance')).body as AdminFinance
    expect(f.nairaPerRaff).toBe(10)
    const row = f.raffles.find((r) => r.id === created.body.id)
    expect(row).toMatchObject({
      raisedRaffs: 5000,
      raisedNaira: 50_000,
      prizeCostNaira: 190_000,
      referralRaffs: 500,
      referralNaira: 5_000,
      expensesNaira: 5_000,
      marginNaira: 50_000 - 190_000 - 5_000 - 5_000,
    })
    expect(row?.prizes.map((p) => p.costNaira)).toEqual([150_000, 20_000, 20_000])
    expect(f.totals.generalExpensesNaira).toBeGreaterThanOrEqual(12_000)

    // A voided expense stops counting
    await write(boss, `/admin/v1/finance/expenses/${general.body.id}/void`, { reason: 'Entered twice' })
    const after = (await get(boss, '/admin/v1/finance')).body as AdminFinance
    expect(after.totals.generalExpensesNaira).toBe(f.totals.generalExpensesNaira - 12_000)
    const listed = (await get(boss, '/admin/v1/finance/expenses')).body as { id: string; voidedAt: string | null }[]
    expect(listed.find((e) => e.id === general.body.id)?.voidedAt).not.toBeNull()
  })

  it('is open to finance and super admins only', async () => {
    const fin = await makeAdmin('finance')
    const viewer = await makeAdmin('viewer')
    expect((await get(fin, '/admin/v1/finance')).status).toBe(200)
    expect((await get(viewer, '/admin/v1/finance')).status).toBe(403)
  })

  it('shows players and the total raised on the overview', async () => {
    const v = await makeAdmin('viewer')
    const o = (await get(v, '/admin/v1/overview')).body as AdminOverview
    expect(o.users.total).toBeGreaterThan(0)
    expect(o.users.activeLast7Days).toBeGreaterThan(0)
    expect(o.raised.raffs).toBeGreaterThan(0)
    expect(o.raised.naira).toBe(Math.round(o.raised.raffs * o.raised.nairaPerRaff))
  })
})

describe('assigning a referrer', () => {
  it('attaches a referrer to an account without one; later entries pay them 10%', async () => {
    const boss = await makeAdmin('super_admin')
    const referrer = await member(http)
    const friend = await member(http)
    await credit(db, friend.userId, 1000)
    const raffle = await createRaffle(db, { entryPriceRaffs: 100 })
    // An entry before the assignment pays nobody
    await friend.post('/v1/entries', { raffleId: raffle.id, qty: 1, idempotencyKey: randomUUID() })

    const res = await write(boss, `/admin/v1/users/${friend.userId}/referrer`, { referrer: `@${referrer.username}`, reason: 'Invited before the app existed' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.user.referredByUsername).toBe(referrer.username)
    expect((await referrer.get('/v1/bootstrap')).body.balance).toBe(0)

    await friend.post('/v1/entries', { raffleId: raffle.id, qty: 2, idempotencyKey: randomUUID() })
    expect((await referrer.get('/v1/bootstrap')).body.balance).toBe(20)

    const audit = await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where action = 'user.referrer.assign' and target_id = ${friend.userId}`)
    expect(audit.rows[0]?.n).toBe(1)
  })

  it('finds the referrer by Telegram id too', async () => {
    const boss = await makeAdmin('super_admin')
    const referrer = await member(http)
    const friend = await member(http)
    const res = await write(boss, `/admin/v1/users/${friend.userId}/referrer`, { referrer: String(referrer.telegramId), reason: 'by telegram id' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.user.referredByUsername).toBe(referrer.username)
  })

  it('never replaces an existing referrer, and refuses self, loops and unknown players', async () => {
    const boss = await makeAdmin('super_admin')
    const a = await member(http)
    const b = await member(http, { startParam: `ref_${a.referralCode}` })
    const c = await member(http)
    const already = await write(boss, `/admin/v1/users/${b.userId}/referrer`, { referrer: c.username, reason: 'try to steal' })
    expect(already.status).toBe(400)
    expect(already.body.error.message).toMatch(/already has a referrer/)
    expect((await write(boss, `/admin/v1/users/${c.userId}/referrer`, { referrer: c.username, reason: 'self referral' })).status).toBe(400)
    // a referred b; making b the referrer of a would loop
    const loop = await write(boss, `/admin/v1/users/${a.userId}/referrer`, { referrer: b.username, reason: 'make a loop' })
    expect(loop.body.error.message).toMatch(/cannot refer each other/)
    expect((await write(boss, `/admin/v1/users/${c.userId}/referrer`, { referrer: 'nobody_here_x', reason: 'unknown one' })).status).toBe(400)
  })

  it('is for super admins only', async () => {
    const fin = await makeAdmin('finance')
    const a = await member(http)
    const b = await member(http)
    const res = await write(fin, `/admin/v1/users/${b.userId}/referrer`, { referrer: a.username, reason: 'not allowed' })
    expect(res.status).toBe(403)
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

describe('prizes: one by default, any number in order', () => {
  const places = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ position: i + 1, prizeItem: `Prize number ${i + 1}`, prizeType: 'raffs_credit', raffsValue: 1000 - i * 10 }))

  it('runs a raffle with a single prize', async () => {
    const m = await makeAdmin('raffle_manager')
    const created = await write(m, '/admin/v1/raffles', raffleInput({ prizes: [{ position: 1, prizeItem: 'Samsung Galaxy A15', prizeType: 'physical' }] }))
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect((await write(m, `/admin/v1/raffles/${created.body.id}/open`)).body.status).toBe('open')
    const player = await member(http)
    const seen = (await player.get(`/v1/raffles/${created.body.id}`)).body as { winners: { position: number }[] }
    expect(seen.winners.map((w) => w.position)).toEqual([1])
  })

  it('keeps many prizes in place order, and refuses gaps or too few entries', async () => {
    const m = await makeAdmin('raffle_manager')
    const created = await write(m, '/admin/v1/raffles', raffleInput({ prizes: [...places(7)].reverse() }))
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect((created.body as AdminRaffle).prizes.map((p) => p.position)).toEqual([1, 2, 3, 4, 5, 6, 7])

    const gap = await write(m, '/admin/v1/raffles', raffleInput({ prizes: places(3).map((p) => (p.position === 2 ? { ...p, position: 5 } : p)) }))
    expect(gap.status).toBe(400)
    expect(gap.body.error.fields.prizes).toMatch(/no gaps/)

    const short = await write(m, '/admin/v1/raffles', raffleInput({ entriesTarget: 4, prizes: places(5) }))
    expect(short.status).toBe(400)
    expect(short.body.error.fields.entriesTarget).toMatch(/at least 5/)

    expect((await write(m, '/admin/v1/raffles', raffleInput({ prizes: places(21) }))).status).toBe(400)
  })

  it('lets a draft drop places, but an open raffle with entries only gain them', async () => {
    const boss = await makeAdmin('super_admin')
    const draft = await write(boss, '/admin/v1/raffles', raffleInput({ prizes: places(5) }))
    const trimmed = await put(boss, `/admin/v1/raffles/${draft.body.id}`, raffleInput({ prizes: places(2) }))
    expect(trimmed.status, JSON.stringify(trimmed.body)).toBe(200)
    expect((trimmed.body as AdminRaffle).prizes).toHaveLength(2)

    await write(boss, `/admin/v1/raffles/${draft.body.id}/open`)
    const player = await member(http)
    await credit(db, player.userId, 1000)
    await player.post('/v1/entries', { raffleId: draft.body.id, qty: 1, idempotencyKey: randomUUID() })

    const fewer = await put(boss, `/admin/v1/raffles/${draft.body.id}`, raffleInput({ prizes: places(1) }))
    expect(fewer.status).toBe(400)
    expect(fewer.body.error.message).toMatch(/added or edited, not removed/)
    const more = await put(boss, `/admin/v1/raffles/${draft.body.id}`, raffleInput({ prizes: places(4) }))
    expect(more.status, JSON.stringify(more.body)).toBe(200)
    expect((more.body as AdminRaffle).prizes).toHaveLength(4)
  })
})

describe('raffle photos', () => {
  // A valid 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const upload = (a: Admin, bytes: Buffer, type = 'image/png') => http.post('/admin/v1/media').set(auth(a)).set('content-type', type).send(bytes)

  it('stores an upload once, serves it publicly and shows it on the raffle', async () => {
    const m = await makeAdmin('raffle_manager')
    const first = await upload(m, png)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    expect(first.body).toMatchObject({ mime: 'image/png', sizeBytes: png.length, width: 1, height: 1 })
    expect(first.body.url).toMatch(/^\/v1\/media\/[0-9a-f-]{36}$/)
    // The same file again is the same stored image
    expect((await upload(m, png)).body.id).toBe(first.body.id)

    const served = await http.get(first.body.url).buffer(true)
    expect(served.status).toBe(200)
    expect(served.headers['content-type']).toBe('image/png')
    expect(Buffer.compare(served.body as Buffer, png)).toBe(0)

    const created = await write(m, '/admin/v1/raffles', raffleInput({ imageUrl: first.body.url }))
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    await write(m, `/admin/v1/raffles/${created.body.id}/open`)
    const player = await member(http)
    expect((await player.get(`/v1/raffles/${created.body.id}`)).body.imageUrl).toBe(first.body.url)

    // Players' live poll notices a new photo
    const live1 = (await player.get('/v1/live')).body.raffles.find((r: { id: string }) => r.id === created.body.id)
    await db.update(raffles).set({ imageUrl: null }).where(eq(raffles.id, created.body.id))
    const live2 = (await player.get('/v1/live')).body.raffles.find((r: { id: string }) => r.id === created.body.id)
    expect(live2.version).not.toBe(live1.version)
  })

  it('refuses files that are not photos, oversize files, outside links and viewers', async () => {
    const m = await makeAdmin('raffle_manager')
    expect((await upload(m, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png')).status).toBe(400)
    const big = Buffer.concat([png, Buffer.alloc(500_001)])
    expect((await upload(m, big)).status).toBe(413)
    const linked = await write(m, '/admin/v1/raffles', raffleInput({ imageUrl: 'https://example.com/a.jpg' }))
    expect(linked.status).toBe(400)
    expect(linked.body.error.fields.imageUrl).toMatch(/Upload the photo/)
    expect((await upload(await makeAdmin('viewer'), png)).status).toBe(403)
    expect((await http.get(`/v1/media/${randomUUID()}`)).status).toBe(404)
  })

  it('will not fetch a link that points inside a private network', async () => {
    const m = await makeAdmin('raffle_manager')
    for (const url of ['https://127.0.0.1/x.png', 'https://[::1]/x.png', 'https://[::ffff:127.0.0.1]/x.png', 'https://[::ffff:a9fe:a9fe]/latest', 'https://[2002:7f00:1::]/x.png', 'https://2130706433/x.png', 'https://169.254.169.254/latest', 'https://10.0.0.5/a.jpg', 'https://localhost/a.jpg']) {
      const res = await write(m, '/admin/v1/media/fetch', { url })
      expect(res.status, url).toBe(400)
      expect(res.body.error.message, url).toMatch(/private network/)
    }
    expect((await write(m, '/admin/v1/media/fetch', { url: 'http://example.com/a.jpg' })).status).toBe(400)
  })
})
