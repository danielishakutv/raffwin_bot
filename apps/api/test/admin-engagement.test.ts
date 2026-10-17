/**
 * Admin API for the engagement work (17 Oct): browser sign-in with a code
 * from the bot, feature switches, broadcasts and the outbox, raffle alerts,
 * and the player fields (phone, bot reach). The test schema is shared with the
 * other files, so every check looks at this file's own admins, players and
 * rows; each sign-in test uses its own client IP (X-Forwarded-For) so the
 * per-IP limit of one test never trips another.
 */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, like, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FEATURE_KEYS, type FeatureKey, type LiveSnapshot } from '@raffwin/shared'
import type {
  AdminBroadcast,
  AdminEngagement,
  AdminFeature,
  AdminFeatureOverride,
  AdminNotification,
  AdminOverview,
  AdminUserDetail,
  AdminUserSummary,
} from '@raffwin/shared/admin-types'
import type { Page } from '@raffwin/shared'
import { hashPassword, issueTicket } from '../src/admin/session'
import type { SendOptions, SendTelegram } from '../src/context'
import { adminSessions, adminUsers, adminWebLogins, broadcasts, notifications, securityEvents, users, type AdminRole } from '../src/db/schema'
import { getGlobalFlags, setGlobal } from '../src/services/features'
import { fanOutOnce, sendPendingOnce } from '../src/services/notify'
import { getAllSettings, putSetting, SETTING_KEYS } from '../src/services/settings'
import { createRaffle, credit, member as open } from './fixtures'
import { contactProof, initData, nigerianPhone, telegramId, testApp } from './helpers'

const MASTER = 'browser-master-password-2026'
const APP_URL = 'https://raffwintest.example/'
const { http, db, ctx } = testApp({ ADMIN_MASTER_PASSWORD_HASH: await hashPassword(MASTER), PUBLIC_APP_URL: APP_URL })

/* Fixtures ------------------------------------------------------------------- */

interface SentCall {
  chatId: number
  text: string
  opts?: SendOptions
}

/** A fake bot on ctx: records every message; `fail` makes Telegram refuse */
function fakeBot() {
  const calls: SentCall[] = []
  let id = 900
  const state = { fail: null as unknown }
  const send: SendTelegram = async (chatId, text, opts) => {
    calls.push({ chatId, text, opts })
    if (state.fail) throw state.fail
    return { messageId: (id += 1) }
  }
  ctx.sendTelegram = send
  return { calls, state }
}

let ipSeq = Math.floor(Math.random() * 200) * 1000
/** A client IP of its own (the app trusts X-Forwarded-For from loopback, as behind Apache) */
function clientIp(): string {
  ipSeq += 1
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`
}

interface AdminAccount {
  id: string
  username: string
  password: string
  telegramId: number | null
  telegramUsername: string
}

async function adminAccount(opts: { role?: AdminRole; bound?: boolean } = {}): Promise<AdminAccount> {
  const tg = telegramId()
  const password = `pw-${randomUUID()}`
  const username = `web_${tg}`
  const telegramUsername = `adaweb${tg}`
  const [row] = await db
    .insert(adminUsers)
    .values({
      name: 'Web Admin',
      username,
      telegramUsername,
      telegramId: opts.bound === false ? null : tg,
      role: opts.role ?? 'super_admin',
      passwordHash: await hashPassword(password),
    })
    .returning({ id: adminUsers.id })
  return { id: row!.id, username, password, telegramId: opts.bound === false ? null : tg, telegramUsername }
}

interface Session {
  id: string
  telegramId: number
  token: string
}

/** Signed in the Telegram way: a bot ticket plus this account's initData */
async function session(role: AdminRole): Promise<Session> {
  const a = await adminAccount({ role })
  const ticket = await issueTicket(ctx, a.id, a.telegramId!)
  const res = await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: a.telegramId! }) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { id: a.id, telegramId: a.telegramId!, token: res.body.token as string }
}

const bearer = (s: Session | string) => ({ authorization: `Bearer ${typeof s === 'string' ? s : s.token}` })
const get = (s: Session, path: string) => http.get(path).set(bearer(s))
const post = (s: Session, path: string, body: object = {}) => http.post(path).set(bearer(s)).send(body)
const put = (s: Session, path: string, body: object) => http.put(path).set(bearer(s)).send(body)

const start = (ip: string, body: { master: string; username: string; password: string }) =>
  http.post('/admin/v1/auth/web/start').set('x-forwarded-for', ip).send(body)
const verify = (ip: string, challengeId: string, code: string) =>
  http.post('/admin/v1/auth/web/verify').set('x-forwarded-for', ip).send({ challengeId, code })

function codeIn(call: SentCall | undefined): string {
  const m = /<b>(\d{6})<\/b>/.exec(call?.text ?? '')
  if (!m?.[1]) throw new Error(`no code in ${call?.text}`)
  return m[1]
}

async function webEvents(since: Date, kindPrefix = 'admin_web_') {
  return db
    .select()
    .from(securityEvents)
    .where(and(gte(securityEvents.occurredAt, since), like(securityEvents.kind, `${kindPrefix}%`)))
}

/** A player who shared their phone (needed to enter while require_phone_for_entry is on) */
async function member(opts?: Parameters<typeof open>[1]) {
  const m = await open(http, opts)
  const res = await m.put('/v1/phone', { contactProof: contactProof(m.telegramId, nigerianPhone().slice(1)) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return m
}

/* Isolation ---------------------------------------------------------------------- */

const flagsBefore = new Map<FeatureKey, boolean>()
let settingsBefore: Record<string, unknown> = {}

/** Nothing from another test left to fan out or send (updates only; nothing is deleted) */
async function settleOutbox() {
  await db
    .update(broadcasts)
    .set({ status: 'cancelled', finishedAt: sql`now()` })
    .where(inArray(broadcasts.status, ['fanning_out', 'sending']))
  await db
    .update(notifications)
    .set({ status: 'skipped', error: 'test cleanup', lockedAt: null })
    .where(inArray(notifications.status, ['pending', 'sending']))
}

beforeAll(async () => {
  const flags = await getGlobalFlags(db)
  for (const k of FEATURE_KEYS) flagsBefore.set(k, flags[k])
  settingsBefore = await getAllSettings(db)
  await settleOutbox()
})

afterEach(async () => {
  ctx.sendTelegram = undefined
  await settleOutbox()
})

afterAll(async () => {
  // Later files expect the switches and settings as they found them
  await db.transaction(async (tx) => {
    for (const [k, v] of flagsBefore) await setGlobal(tx, k, v, null)
    for (const k of SETTING_KEYS) await putSetting(tx, k, settingsBefore[k] as never, null)
  })
})

/* Browser sign-in ------------------------------------------------------------------ */

describe('browser admin sign-in', () => {
  it('accepts the three secrets, sends a code to the bound Telegram, and opens a browser session with it', async () => {
    const bot = fakeBot()
    const a = await adminAccount()
    const ip = clientIp()
    const since = new Date(Date.now() - 1000)

    const started = await start(ip, { master: MASTER, username: a.username.toUpperCase(), password: a.password })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    expect(started.body.sentTo).toBe(`@${a.telegramUsername.slice(0, 3)}***`)
    expect(started.body.expiresAt).toBeGreaterThan(Date.now() + 4 * 60_000)
    expect(bot.calls).toHaveLength(1)
    expect(bot.calls[0]?.chatId).toBe(a.telegramId)
    expect(bot.calls[0]?.opts?.html).toBe(true)
    expect(bot.calls[0]?.text).toMatch(/^Browser admin sign-in code: <b>\d{6}<\/b>\nValid 5 minutes\./)
    // The code itself is never stored, only its hash
    const [row] = await db.select().from(adminWebLogins).where(eq(adminWebLogins.id, started.body.challengeId))
    expect(row?.codeHash).not.toContain(codeIn(bot.calls[0]))

    const verified = await verify(ip, started.body.challengeId, codeIn(bot.calls[0]))
    expect(verified.status, JSON.stringify(verified.body)).toBe(200)
    expect(verified.body).toMatchObject({ idleMinutes: 120, admin: { id: a.id, role: 'super_admin', channel: 'browser' } })

    const me = await http.get('/admin/v1/me').set(bearer(verified.body.token))
    expect(me.status).toBe(200)
    expect(me.body.channel).toBe('browser')
    const [s] = await db.select().from(adminSessions).where(eq(adminSessions.adminId, a.id))
    expect(s?.channel).toBe('browser')

    // A code works once
    expect((await verify(ip, started.body.challengeId, codeIn(bot.calls[0]))).status).toBe(401)
    // Resume is the Mini App's way back in, not the browser's
    const resume = await http.post('/admin/v1/auth/resume').set(bearer(verified.body.token)).send({ initData: initData({ id: a.telegramId! }) })
    expect(resume.status).toBe(400)

    const audit = await db.execute<{ action: string; after: Record<string, unknown> }>(
      sql`select action, after from audit_log where admin_id = ${a.id} and action like 'admin.%' and action <> 'admin.request' order by seq`,
    )
    expect(audit.rows.map((r) => r.action)).toEqual(['admin.web.challenge', 'admin.session.start', 'admin.web.failed'])
    expect(audit.rows[1]?.after).toMatchObject({ channel: 'browser' })
    // Someone holding all three secrets is recorded for the other admins to see
    expect((await webEvents(since, 'admin_web_code_sent')).length).toBe(1)
  })

  it('gives one answer whatever was wrong, records each, and counts the admin failures', async () => {
    const bot = fakeBot()
    const a = await adminAccount()
    const ip = clientIp()
    const since = new Date(Date.now() - 1000)
    const wrongMaster = await start(ip, { master: 'nope', username: a.username, password: a.password })
    const wrongPassword = await start(ip, { master: MASTER, username: a.username, password: 'nope' })
    const unknown = await start(ip, { master: MASTER, username: 'nobody_here', password: 'my-secret-password' })
    for (const res of [wrongMaster, wrongPassword, unknown]) {
      expect(res.status).toBe(401)
      expect(res.body.error).toMatchObject({ code: 'AUTH_INVALID', message: 'Those details are not right.' })
    }
    expect(bot.calls).toHaveLength(0)
    const kinds = (await webEvents(since)).map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['admin_web_login_master_password', 'admin_web_login_password', 'admin_web_login_unknown_username']))
    // An unknown username is kept only as a salted hash: it might be a password typed in the wrong box
    const leaked = await db.execute(sql`select 1 from security_events where details::text like '%nobody_here%'`)
    expect(leaked.rows).toHaveLength(0)
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, a.id))
    expect(row?.failedLogins).toBe(2)
    const audit = await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where admin_id = ${a.id} and action = 'admin.web.failed'`)
    expect(audit.rows[0]?.n).toBe(2)
  })

  it('takes a wrong code four times, burns the challenge on the fifth, and refuses an expired one', async () => {
    const bot = fakeBot()
    const a = await adminAccount()
    const ip = clientIp()
    const first = await start(ip, { master: MASTER, username: a.username, password: a.password })
    const code = codeIn(bot.calls[0])
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 1; i <= 4; i++) {
      const res = await verify(ip, first.body.challengeId, wrong)
      expect(res.status).toBe(401)
      expect(res.body.error.message).toBe('That code is not right.')
    }
    const fifth = await verify(ip, first.body.challengeId, wrong)
    expect(fifth.body.error.message).toMatch(/last try/)
    const burned = await verify(ip, first.body.challengeId, code)
    expect(burned.status).toBe(401)
    expect(burned.body.error.message).toMatch(/expired or was already used/)

    // A new start: the code expires after 5 minutes
    const ip2 = clientIp()
    const second = await start(ip2, { master: MASTER, username: a.username, password: a.password })
    await db.update(adminWebLogins).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(adminWebLogins.id, second.body.challengeId))
    expect((await verify(ip2, second.body.challengeId, codeIn(bot.calls[1]))).status).toBe(401)
  })

  it('only the newest code works', async () => {
    const bot = fakeBot()
    const a = await adminAccount()
    const ip = clientIp()
    const one = await start(ip, { master: MASTER, username: a.username, password: a.password })
    const two = await start(ip, { master: MASTER, username: a.username, password: a.password })
    expect((await verify(ip, one.body.challengeId, codeIn(bot.calls[0]))).status).toBe(401)
    expect((await verify(ip, two.body.challengeId, codeIn(bot.calls[1]))).status).toBe(200)
  })

  it('locks an admin username for an hour after 5 failures, even with the right secrets after', async () => {
    const bot = fakeBot()
    const a = await adminAccount()
    const since = new Date(Date.now() - 1000)
    for (let i = 0; i < 5; i++) {
      expect((await start(clientIp(), { master: MASTER, username: a.username, password: `wrong-${i}` })).status).toBe(401)
    }
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, a.id))
    expect(row?.lockedUntil?.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000)
    expect((await webEvents(since)).some((e) => e.severity === 'critical')).toBe(true)

    const right = await start(clientIp(), { master: MASTER, username: a.username, password: a.password })
    expect(right.status).toBe(429)
    expect(right.body.error.code).toBe('RATE_LIMITED')
    expect(bot.calls).toHaveLength(0)
    expect((await webEvents(since, 'admin_web_login_locked')).length).toBe(1)
  })

  it('locks an unknown username the same way, so a lock says nothing about who exists', async () => {
    fakeBot()
    const name = `ghost_${telegramId()}`
    for (let i = 0; i < 5; i++) {
      expect((await start(clientIp(), { master: MASTER, username: name, password: 'x' })).status).toBe(401)
    }
    const sixth = await start(clientIp(), { master: MASTER, username: name, password: 'x' })
    expect(sixth.status).toBe(429)
    const real = await adminAccount()
    for (let i = 0; i < 5; i++) await start(clientIp(), { master: MASTER, username: real.username, password: 'x' })
    const realSixth = await start(clientIp(), { master: MASTER, username: real.username, password: 'x' })
    expect(realSixth.body).toMatchObject({ error: { code: sixth.body.error.code, message: sixth.body.error.message } })
  })

  it('refuses everyone from an IP with 10 admin_web events in the last hour', async () => {
    const bot = fakeBot()
    const a = await adminAccount()
    const ip = clientIp()
    for (let i = 0; i < 10; i++) {
      expect((await start(ip, { master: MASTER, username: `ghost_${telegramId()}`, password: 'x' })).status).toBe(401)
    }
    const right = await start(ip, { master: MASTER, username: a.username, password: a.password })
    expect(right.status).toBe(429)
    expect(right.body.error.message).toMatch(/from this connection/)
    expect(bot.calls).toHaveLength(0)
    // The same secrets from elsewhere still work
    expect((await start(clientIp(), { master: MASTER, username: a.username, password: a.password })).status).toBe(200)
  })

  it('concurrent wrong passwords from many IPs: at most 5 are evaluated, and the right one after them is locked out', async () => {
    const bot = fakeBot()
    const a = await adminAccount()
    // Each attempt checks the lock and records its failure in one transaction, so these queue rather than all reading "4 failures"
    const burst = Promise.all(Array.from({ length: 8 }, (_, i) => start(clientIp(), { master: MASTER, username: a.username, password: `wrong-${i}` })))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const right = start(clientIp(), { master: MASTER, username: a.username, password: a.password })
    const [wrong, last] = await Promise.all([burst, right])
    const statuses = wrong.map((r) => r.status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(5)
    expect(statuses.filter((s) => s === 429)).toHaveLength(3)
    expect(last.status, JSON.stringify(last.body)).toBe(429)
    expect(last.body.error.message).toBe('Too many failed sign-ins for this admin. Wait an hour and try again, or sign in from the bot.')
    expect(bot.calls).toHaveLength(0)
  })

  it('30 concurrent attempts from one IP: at most 10 are evaluated', async () => {
    fakeBot()
    const ip = clientIp()
    const res = await Promise.all(
      Array.from({ length: 30 }, () => start(ip, { master: MASTER, username: `ghost_${telegramId()}`, password: 'x' })),
    )
    expect(res.filter((r) => r.status === 401)).toHaveLength(10)
    const limited = res.filter((r) => r.status === 429)
    expect(limited).toHaveLength(20)
    expect(limited.every((r) => /from this connection/.test(r.body.error.message))).toBe(true)
  })

  it('counts an IPv6 /64 as one connection', async () => {
    const bot = fakeBot()
    const a = await adminAccount()
    ipSeq += 1
    const net = `2001:db8:${(ipSeq >> 16) & 0xffff}:${(ipSeq & 0xffff).toString(16)}`
    for (let i = 1; i <= 10; i++) {
      expect((await start(`${net}::${i.toString(16)}`, { master: MASTER, username: `ghost_${telegramId()}`, password: 'x' })).status).toBe(401)
    }
    // Another address in the same /64, written out in full
    const same = await start(`${net}:0:0:0:beef`, { master: MASTER, username: a.username, password: a.password })
    expect(same.status).toBe(429)
    expect(same.body.error.message).toMatch(/from this connection/)
    expect(bot.calls).toHaveLength(0)
    // The next /64 over is a different connection
    const next = `2001:db8:${(ipSeq >> 16) & 0xffff}:${((ipSeq + 1) & 0xffff).toString(16)}::1`
    expect((await start(next, { master: MASTER, username: a.username, password: a.password })).status).toBe(200)
  })

  it('the lock comes from the failure count alone, not from admin_users.locked_until', async () => {
    fakeBot()
    const a = await adminAccount()
    await db.update(adminUsers).set({ failedLogins: 4, lockedUntil: new Date(Date.now() + 3_600_000) }).where(eq(adminUsers.id, a.id))
    expect((await start(clientIp(), { master: MASTER, username: a.username, password: 'nope' })).status).toBe(401)
    expect((await start(clientIp(), { master: MASTER, username: a.username, password: a.password })).status).toBe(200)
  })

  it('sends at most 5 codes per admin an hour', async () => {
    const bot = fakeBot()
    const a = await adminAccount()
    for (let i = 0; i < 5; i++) {
      expect((await start(clientIp(), { master: MASTER, username: a.username, password: a.password })).status).toBe(200)
    }
    const sixth = await start(clientIp(), { master: MASTER, username: a.username, password: a.password })
    expect(sixth.status).toBe(429)
    expect(sixth.body.error.code).toBe('RATE_LIMITED')
    expect(bot.calls).toHaveLength(5)
  })

  it('10 wrong codes for one admin in an hour, across challenges, close browser sign-in for that admin', async () => {
    const bot = fakeBot()
    const a = await adminAccount()
    const since = new Date(Date.now() - 1000)
    const wrongFor = (call: SentCall | undefined) => (codeIn(call) === '000000' ? '111111' : '000000')
    const begin = async () => {
      const res = await start(clientIp(), { master: MASTER, username: a.username, password: a.password })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return res.body.challengeId as string
    }
    const first = await begin()
    for (let i = 0; i < 5; i++) expect((await verify(clientIp(), first, wrongFor(bot.calls[0]))).status).toBe(401)
    const second = await begin()
    for (let i = 0; i < 4; i++) expect((await verify(clientIp(), second, wrongFor(bot.calls[1]))).status).toBe(401)
    const third = await begin()
    const tenth = await verify(clientIp(), third, wrongFor(bot.calls[2]))
    expect(tenth.status).toBe(429)
    expect(tenth.body.error.code).toBe('RATE_LIMITED')
    expect((await webEvents(since, 'admin_web_code_wrong_code')).filter((e) => e.severity === 'critical')).toHaveLength(1)

    // Neither the right code nor a new one gets through for the hour
    expect((await verify(clientIp(), third, codeIn(bot.calls[2]))).status).toBe(429)
    expect((await start(clientIp(), { master: MASTER, username: a.username, password: a.password })).status).toBe(429)
    expect(bot.calls).toHaveLength(3)
    const sessions = await db.select().from(adminSessions).where(eq(adminSessions.adminId, a.id))
    expect(sessions).toHaveLength(0)
  })

  it('asks an admin who never signed in from the bot to do that first; no code is sent', async () => {
    const bot = fakeBot()
    const a = await adminAccount({ bound: false })
    const res = await start(clientIp(), { master: MASTER, username: a.username, password: a.password })
    expect(res.status).toBe(401)
    expect(res.body.error.message).toBe('Sign in once from the bot in Telegram first, so a code can reach you.')
    expect(bot.calls).toHaveLength(0)
    // Without the right password the same admin gets only the generic answer
    const wrong = await start(clientIp(), { master: MASTER, username: a.username, password: 'nope' })
    expect(wrong.body.error.message).toBe('Those details are not right.')
  })

  it('says so when the bot cannot deliver the code, and when this server cannot send at all', async () => {
    const bot = fakeBot()
    bot.state.fail = { error_code: 403, description: 'Forbidden: bot was blocked by the user' }
    const a = await adminAccount()
    const res = await start(clientIp(), { master: MASTER, username: a.username, password: a.password })
    expect(res.status).toBe(500)
    expect(res.body.error.message).toMatch(/could not message your Telegram account/)
    ctx.sendTelegram = undefined
    const off = await start(clientIp(), { master: MASTER, username: a.username, password: a.password })
    expect(off.status).toBe(409)
    expect(off.body.error.code).toBe('NOT_READY')
  })

  it('a disabled admin gets the generic answer', async () => {
    const bot = fakeBot()
    const a = await adminAccount()
    await db.update(adminUsers).set({ status: 'disabled' }).where(eq(adminUsers.id, a.id))
    const res = await start(clientIp(), { master: MASTER, username: a.username, password: a.password })
    expect(res.status).toBe(401)
    expect(res.body.error.message).toBe('Those details are not right.')
    expect(bot.calls).toHaveLength(0)
  })

  it('Telegram sessions say so in /me', async () => {
    const s = await session('viewer')
    expect((await get(s, '/admin/v1/me')).body.channel).toBe('telegram')
  })
})

/* Features ------------------------------------------------------------------------- */

describe('feature switches in the admin', () => {
  it('lists every feature; a viewer can read but not switch', async () => {
    const viewer = await session('viewer')
    const list = (await get(viewer, '/admin/v1/features')).body as AdminFeature[]
    expect(list.map((f) => f.key)).toEqual(FEATURE_KEYS)
    expect((await put(viewer, '/admin/v1/features/daily_streak', { enabled: true })).status).toBe(403)
    expect((await post(viewer, '/admin/v1/features/daily_streak/overrides', { user: '@x', enabled: true, note: 'test' })).status).toBe(403)
    expect((await put(viewer, '/admin/v1/features/not_a_feature', { enabled: true })).status).toBe(403)
  })

  it('global switch and per-player override reach /v1/live, announced once, audited', async () => {
    const boss = await session('super_admin')
    const p = await member()
    await db.transaction((tx) => setGlobal(tx, 'daily_streak', false, null))

    const on = await put(boss, '/admin/v1/features/daily_streak', { enabled: true, announce: true, reason: 'launch' })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect(on.body).toMatchObject({ key: 'daily_streak', enabled: true, updatedBy: 'Web Admin' })
    const [b] = await db.select().from(broadcasts).where(and(eq(broadcasts.refType, 'feature'), eq(broadcasts.refId, 'daily_streak'))).orderBy(desc(broadcasts.createdAt)).limit(1)
    expect(b).toMatchObject({ kind: 'feature', status: 'fanning_out', createdByAdminId: boss.id })
    expect(b?.text).toMatch(/daily streaks/)
    expect(((await p.get('/v1/live')).body as LiveSnapshot).features.daily_streak).toBe(true)

    // Announcing a feature that is already on is refused, not sent twice
    expect((await put(boss, '/admin/v1/features/daily_streak', { enabled: true, announce: true })).status).toBe(400)

    const o = await post(boss, '/admin/v1/features/daily_streak/overrides', { user: `@${p.username}`, enabled: false, note: 'abuse review' })
    expect(o.status, JSON.stringify(o.body)).toBe(201)
    expect((o.body as AdminFeatureOverride).username).toBe(p.username)
    expect(((await p.get('/v1/live')).body as LiveSnapshot).features.daily_streak).toBe(false)
    const listed = (await get(boss, '/admin/v1/features/daily_streak/overrides')).body as AdminFeatureOverride[]
    expect(listed.map((x) => x.id)).toContain(o.body.id)
    expect(((await get(boss, '/admin/v1/features')).body as AdminFeature[]).find((f) => f.key === 'daily_streak')?.overrides.off).toBeGreaterThanOrEqual(1)

    expect((await post(boss, `/admin/v1/features/overrides/${o.body.id}/clear`, { reason: 'review done' })).status).toBe(204)
    expect(((await p.get('/v1/live')).body as LiveSnapshot).features.daily_streak).toBe(true)
    expect((await post(boss, `/admin/v1/features/overrides/${o.body.id}/clear`, { reason: 'again please' })).status).toBe(404)

    const audit = await db.execute<{ action: string }>(
      sql`select action from audit_log where admin_id = ${boss.id} and action like 'feature.%' order by seq`,
    )
    expect(audit.rows.map((r) => r.action)).toEqual(['feature.global', 'feature.override.set', 'feature.override.clear'])
  })

  it('an override can switch a feature on for one player while it is off for everyone, and tell them', async () => {
    const boss = await session('super_admin')
    const p = await member()
    const other = await member()
    await db.transaction((tx) => setGlobal(tx, 'raffs_transfer', false, null))
    const o = await post(boss, '/admin/v1/features/raffs_transfer/overrides', { user: String(p.telegramId), enabled: true, note: 'beta tester', notify: true })
    expect(o.status, JSON.stringify(o.body)).toBe(201)
    expect(((await p.get('/v1/live')).body as LiveSnapshot).features.raffs_transfer).toBe(true)
    expect(((await other.get('/v1/live')).body as LiveSnapshot).features.raffs_transfer).toBe(false)
    const [n] = await db.select().from(notifications).where(and(eq(notifications.userId, p.userId), eq(notifications.kind, 'feature')))
    expect(n?.text).toMatch(/send Raffs to a friend/)
    expect(n?.buttons?.[0]?.[0]?.webApp).toBe(APP_URL)

    expect((await post(boss, '/admin/v1/features/raffs_transfer/overrides', { user: '@no_such_player_x', enabled: true, note: 'nobody' })).status).toBe(404)
    // A Telegram username works too, when the Raffle Win username differs
    const [o2] = await db.select({ tg: users.tgUsername }).from(users).where(eq(users.id, other.userId))
    await db.update(users).set({ username: `rw_${telegramId()}` }).where(eq(users.id, other.userId))
    const byTg = await post(boss, '/admin/v1/features/raffs_transfer/overrides', { user: `@${o2?.tg?.toUpperCase()}`, enabled: true, note: 'by telegram name' })
    expect(byTg.status, JSON.stringify(byTg.body)).toBe(201)
    expect(byTg.body.userId).toBe(other.userId)
    // Telling a player something was turned off is not offered
    expect((await post(boss, '/admin/v1/features/raffs_transfer/overrides', { user: p.username, enabled: false, note: 'off again', notify: true })).status).toBe(400)
  })
})

/* Messages --------------------------------------------------------------------------- */

describe('broadcasts and the outbox', () => {
  it('sends a notice to named players: fan-out, send, counts, outbox list', async () => {
    const boss = await session('super_admin')
    const bot = fakeBot()
    const a = await member()
    const b = await member()

    const unknown = await post(boss, '/admin/v1/broadcasts', { text: 'Hello there', audience: { type: 'users', users: [a.username, '@nobody_at_all_x'] } })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.message).toMatch(/@nobody_at_all_x/)

    const res = await post(boss, '/admin/v1/broadcasts', {
      title: 'Delivery update',
      text: 'Prizes for last week <ship> on Monday.',
      audience: { type: 'users', users: [`@${a.username}`, String(b.telegramId)] },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body as AdminBroadcast).toMatchObject({ kind: 'announcement', status: 'fanning_out', audienceLabel: '2 named players', createdBy: 'Web Admin' })

    await fanOutOnce(ctx)
    const counts = await sendPendingOnce(ctx, { max: 100, gapMs: 0 })
    expect(counts.sent).toBeGreaterThanOrEqual(2)
    const mine = bot.calls.filter((c) => c.chatId === a.telegramId || c.chatId === b.telegramId)
    expect(mine).toHaveLength(2)
    expect(mine[0]?.text).toBe('<b>Delivery update</b>\n\nPrizes for last week &lt;ship&gt; on Monday.')
    expect(mine[0]?.opts?.buttons?.[0]?.[0]?.webApp).toBe(APP_URL)
    await fanOutOnce(ctx)

    const list = (await get(boss, '/admin/v1/broadcasts')).body as AdminBroadcast[]
    expect(list.find((x) => x.id === res.body.id)).toMatchObject({ status: 'done', total: 2, sent: 2, failed: 0, pending: 0 })

    const outbox = (await get(boss, `/admin/v1/notifications?kind=announcement&status=sent&limit=100`)).body as Page<AdminNotification>
    expect(outbox.items.filter((n) => n.username === a.username || n.username === b.username)).toHaveLength(2)
    expect((await get(boss, '/admin/v1/notifications?status=bogus')).status).toBe(400)
  })

  it('cancels a broadcast: no more sends, its waiting messages skipped', async () => {
    const boss = await session('super_admin')
    const a = await member()
    const res = await post(boss, '/admin/v1/broadcasts', { text: 'Wrong message', audience: { type: 'users', users: [a.username] } })
    await fanOutOnce(ctx)
    const cancelled = await post(boss, `/admin/v1/broadcasts/${res.body.id}/cancel`)
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
    // Stopped, not failed: the waiting message counts as skipped
    expect(cancelled.body).toMatchObject({ status: 'cancelled', pending: 0, failed: 0, skipped: 1 })
    const [n] = await db.select().from(notifications).where(eq(notifications.broadcastId, res.body.id))
    expect(n).toMatchObject({ status: 'skipped', error: 'cancelled' })
    expect((await post(boss, `/admin/v1/broadcasts/${res.body.id}/cancel`)).status).toBe(400)
  })

  it('counts failed and skipped apart: Telegram refusing is a failure, a player who blocked the bot meanwhile is skipped', async () => {
    const boss = await session('super_admin')
    const ok = await member()
    const away = await member()
    const refuses = await member()
    const res = await post(boss, '/admin/v1/broadcasts', { text: 'Counts', audience: { type: 'users', users: [ok.username, away.username, refuses.username] } })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    await fanOutOnce(ctx)
    // Blocked after being queued: the sender skips them without calling Telegram
    await db.update(users).set({ botBlockedAt: new Date() }).where(eq(users.id, away.userId))
    const calls: number[] = []
    ctx.sendTelegram = async (chatId) => {
      calls.push(chatId)
      if (chatId === refuses.telegramId) throw { error_code: 403, description: 'Forbidden: bot was blocked by the user' }
      return { messageId: 1 }
    }
    await sendPendingOnce(ctx, { max: 100, gapMs: 0 })
    await fanOutOnce(ctx)
    expect(calls).not.toContain(away.telegramId)

    const b = (await get(boss, `/admin/v1/broadcasts`)).body as AdminBroadcast[]
    expect(b.find((x) => x.id === res.body.id)).toMatchObject({ status: 'done', total: 3, sent: 1, failed: 1, skipped: 1, pending: 0 })
    const rows = await db.select().from(notifications).where(eq(notifications.broadcastId, res.body.id))
    expect(rows.find((n) => n.userId === away.userId)).toMatchObject({ status: 'skipped', error: 'blocked' })
    expect(rows.find((n) => n.userId === refuses.userId)?.status).toBe('failed')
  })

  it('a test goes to the admin only: queued to their player account, or sent directly without one', async () => {
    const boss = await session('super_admin')
    const bot = fakeBot()
    const direct = await post(boss, '/admin/v1/broadcasts', { text: 'How does this look?', audience: { type: 'all' }, test: true })
    expect(direct.status, JSON.stringify(direct.body)).toBe(201)
    expect(direct.body).toMatchObject({ status: 'done', total: 1, sent: 1 })
    expect(bot.calls).toEqual([expect.objectContaining({ chatId: boss.telegramId, text: 'How does this look?' })])

    // The same admin opens the app as a player: tests now go through the outbox like everything else
    await http.post('/v1/auth/telegram').send({ initData: initData({ id: boss.telegramId }) })
    const queued = await post(boss, '/admin/v1/broadcasts', { title: 'Hi', text: 'How does this look?', audience: { type: 'all' }, test: true })
    expect(queued.body).toMatchObject({ status: 'sending', total: 1, pending: 1, audienceLabel: 'Test: your own Telegram' })
    await sendPendingOnce(ctx, { max: 100, gapMs: 0 })
    expect(bot.calls.filter((c) => c.chatId === boss.telegramId)).toHaveLength(2)
    const [row] = await db.select().from(broadcasts).where(eq(broadcasts.id, queued.body.id))
    expect(row?.refType).toBe('test')
  })

  it('only a super admin sends; every role reads', async () => {
    const viewer = await session('viewer')
    expect((await post(viewer, '/admin/v1/broadcasts', { text: 'Hello all', audience: { type: 'all' } })).status).toBe(403)
    expect((await get(viewer, '/admin/v1/broadcasts')).status).toBe(200)
    expect((await get(viewer, '/admin/v1/notifications')).status).toBe(200)
  })

  it('engagement settings: everyone reads, a super admin writes, audited', async () => {
    const viewer = await session('viewer')
    const boss = await session('super_admin')
    const before = (await get(viewer, '/admin/v1/engagement')).body as AdminEngagement
    expect(before).toMatchObject({ reminderMinHours: expect.any(Number), comebackRaffs: expect.any(Number), outbox: expect.any(Object) })
    expect(Array.isArray(before.reminderTexts)).toBe(true)
    const body = {
      reminderMinHours: 7,
      reminderMaxHours: 9,
      maxRemindersPerSpell: 5,
      quietStartHour: 21,
      quietEndHour: 8,
      comebackAfterHours: 72,
      comebackRaffs: 0,
      comebackCooldownDays: 10,
      streakRewards: [1, 2, 3],
      transferMinRaffs: 5,
      transferDailyMaxRaffs: 500,
    }
    expect((await put(viewer, '/admin/v1/engagement', body)).status).toBe(403)
    expect((await put(boss, '/admin/v1/engagement', { ...body, comebackRaffs: 2 })).status).toBe(400)
    const saved = await put(boss, '/admin/v1/engagement', body)
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body).toMatchObject(body)
    const audit = await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where admin_id = ${boss.id} and action = 'settings.engagement'`)
    expect(audit.rows[0]?.n).toBe(1)
  })
})

/* Raffle alerts ------------------------------------------------------------------------ */

describe('raffle alerts', () => {
  function raffleInput() {
    return {
      prizeName: 'Infinix Hot 40',
      model: '256GB',
      category: 'Phones',
      kind: 'phone',
      marketPriceNaira: 190_000,
      entryPriceRaffs: 25,
      entriesTarget: 300,
      deadline: '2030-01-15T17:00:00.000Z',
      prizes: [
        { position: 1, prizeItem: 'Infinix Hot 40', prizeType: 'physical' },
        { position: 2, prizeItem: '1,000 Raffs credit', prizeType: 'raffs_credit', raffsValue: 1000 },
      ],
    }
  }

  it('opening a raffle queues one alert to everyone; unpublishing stops it; re-opening alerts again', async () => {
    const boss = await session('super_admin')
    const created = await post(boss, '/admin/v1/raffles', raffleInput())
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const id = created.body.id as string
    expect((await post(boss, `/admin/v1/raffles/${id}/open`)).status).toBe(200)
    const alerts = () => db.select().from(broadcasts).where(and(eq(broadcasts.refType, 'raffle'), eq(broadcasts.refId, id))).orderBy(broadcasts.createdAt)
    const [first] = await alerts()
    expect(first).toMatchObject({ kind: 'raffle_new', title: 'New raffle: Infinix Hot 40', openButton: true, status: 'fanning_out', audience: { type: 'all' } })
    expect(first?.text).toBe('One entry: 25 Raffs. 2 prizes to win.\nEntries close Tue 15 Jan, 6:00 pm (Lagos time).\n\nTap below to enter.')

    expect((await post(boss, `/admin/v1/raffles/${id}/unpublish`, { reason: 'Wrong photo' })).status).toBe(200)
    expect((await alerts())[0]?.status).toBe('cancelled')
    expect((await post(boss, `/admin/v1/raffles/${id}/open`)).status).toBe(200)
    const after = await alerts()
    expect(after.map((b) => b.status)).toEqual(['cancelled', 'fanning_out'])
  })

  it('players who switched new raffle alerts off are left out', async () => {
    const boss = await session('super_admin')
    const keen = await member()
    const quiet = await member()
    await post(boss, '/admin/v1/features/new_raffle_alerts/overrides', { user: quiet.username, enabled: false, note: 'asked us to stop' })
    const raffle = await createRaffle(db, { status: 'draft', deadline: new Date(Date.now() + 2 * 86_400_000) })
    expect((await post(boss, `/admin/v1/raffles/${raffle.id}/open`)).status).toBe(200)
    await fanOutOnce(ctx, 5000, 100)
    const queued = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(and(eq(notifications.kind, 'raffle_new'), inArray(notifications.userId, [keen.userId, quiet.userId]), sql`${notifications.broadcastId} in (select id from broadcasts where ref_id = ${raffle.id})`))
    expect(queued.map((q) => q.userId)).toEqual([keen.userId])
  })

  it('cancelling a raffle tells its entrants they were refunded, and nobody else', async () => {
    const boss = await session('super_admin')
    const entrant = await member()
    const bystander = await member()
    const raffle = await createRaffle(db, { entryPriceRaffs: 40 })
    await credit(db, entrant.userId, 200)
    const entered = await entrant.post('/v1/entries', { raffleId: raffle.id, qty: 2, idempotencyKey: randomUUID() })
    expect(entered.status, JSON.stringify(entered.body)).toBe(201)

    const cancel = await post(boss, `/admin/v1/raffles/${raffle.id}/cancel`, { reason: 'Supplier fell through' })
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200)
    expect(cancel.body.result).toMatchObject({ raffsRefunded: 80, playersNotified: 1 })
    const [b] = await db.select().from(broadcasts).where(and(eq(broadcasts.kind, 'raffle_cancelled'), eq(broadcasts.refId, raffle.id)))
    expect(b?.audience).toEqual({ type: 'users', userIds: [entrant.userId] })
    expect(b?.text).toMatch(/refunded to your Raffle Win balance, in full/)

    const bot = fakeBot()
    await fanOutOnce(ctx)
    await sendPendingOnce(ctx, { max: 100, gapMs: 0 })
    expect(bot.calls.filter((c) => c.chatId === entrant.telegramId).map((c) => c.text)).toEqual([expect.stringMatching(/^<b>Raffle cancelled: Tecno Spark 20<\/b>/)])
    expect(bot.calls.filter((c) => c.chatId === bystander.telegramId)).toHaveLength(0)
  })
})

/* Players and overview -------------------------------------------------------------- */

describe('players: phones, bot reach, engagement', () => {
  it('filters, shows phone and bot state, and the detail cards', async () => {
    const viewer = await session('viewer')
    const withPhone = await member()
    const noPhone = await open(http)
    await db.update(users).set({ botBlockedAt: new Date() }).where(eq(users.id, noPhone.userId))

    const search = async (filter: string, q: string) => (await get(viewer, `/admin/v1/users?filter=${filter}&q=${q}`)).body as AdminUserSummary[]
    expect((await search('no_phone', noPhone.username)).map((u) => u.id)).toEqual([noPhone.userId])
    expect(await search('no_phone', withPhone.username)).toEqual([])
    expect((await search('with_phone', withPhone.username))[0]).toMatchObject({ phoneVerified: true, botBlocked: false })
    expect((await search('blocked', noPhone.username))[0]).toMatchObject({ phoneVerified: false, botBlocked: true })
    expect((await get(viewer, '/admin/v1/users?filter=bogus')).status).toBe(400)

    const detail = (await get(viewer, `/admin/v1/users/${withPhone.userId}`)).body as AdminUserDetail
    expect(detail.engagement).toMatchObject({ remindersOn: true, botBlockedAt: null, streak: { current: 0, best: 0, lastClaimedDay: null }, comebackOffers: [] })
    expect(detail.features.map((f) => f.key)).toEqual(FEATURE_KEYS)
    expect(detail.features.every((f) => f.effective === (f.override ?? f.global))).toBe(true)
    expect(detail.features.every((f) => f.overrideId === null)).toBe(true)
    expect(Array.isArray(detail.notifications)).toBe(true)
    expect(detail.delivery).toBeNull()

    const o = (await get(viewer, '/admin/v1/overview')).body as AdminOverview
    expect(o.phones.withPhone).toBeGreaterThanOrEqual(1)
    expect(o.phones.withPhone + o.phones.withoutPhone).toBe(o.users.total)
    expect(o.bot.blocked).toBeGreaterThanOrEqual(1)
    expect(o.bot).toMatchObject({ reachable: expect.any(Number), sentLast24h: expect.any(Number), pending: expect.any(Number) })
  })

  it("the detail carries the live override's id, and clearing by it works once", async () => {
    const boss = await session('super_admin')
    const p = await member()
    const detailOf = async () => ((await get(boss, `/admin/v1/users/${p.userId}`)).body as AdminUserDetail).features.find((f) => f.key === 'daily_streak')

    const o = await post(boss, '/admin/v1/features/daily_streak/overrides', { user: String(p.telegramId), enabled: true, note: 'tester' })
    expect(o.status, JSON.stringify(o.body)).toBe(201)
    expect(await detailOf()).toMatchObject({ override: true, overrideId: o.body.id, effective: true })

    // Replacing the override hands out the new row's id
    const o2 = await post(boss, '/admin/v1/features/daily_streak/overrides', { user: String(p.telegramId), enabled: false, note: 'changed my mind' })
    expect(o2.status, JSON.stringify(o2.body)).toBe(201)
    const f = await detailOf()
    expect(f).toMatchObject({ override: false, overrideId: o2.body.id })

    expect((await post(boss, `/admin/v1/features/overrides/${f?.overrideId}/clear`, { reason: 'done testing' })).status).toBe(204)
    expect(await detailOf()).toMatchObject({ override: null, overrideId: null })
    // Cleared already (another admin, a stale screen): NOT_FOUND
    const again = await post(boss, `/admin/v1/features/overrides/${f?.overrideId}/clear`, { reason: 'again please' })
    expect(again.status).toBe(404)
    expect(again.body.error.code).toBe('NOT_FOUND')
  })

  it("shows a drawn prize winner's phone", async () => {
    const viewer = await session('viewer')
    const winner = await member()
    const raffle = await createRaffle(db)
    await db.execute(sql`update raffle_prizes set winner_user_id = ${winner.userId}, winner_ticket = 1 where raffle_id = ${raffle.id} and position = 1`)
    const [w] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, winner.userId))
    const r = (await get(viewer, `/admin/v1/raffles/${raffle.id}`)).body
    expect(r.prizes[0]).toMatchObject({ winnerUsername: winner.username, winnerPhone: w?.phone })
    expect(r.prizes[1].winnerPhone).toBeNull()
  })
})
