/**
 * Trusted devices and at-risk accounts (19 Oct): the full sign-in is for a
 * device's first time; a trusted device then signs in with one tap (Telegram)
 * or the admin password alone (browser). Two admins other than the one
 * concerned can mark an account at risk, which ends its sessions, revokes its
 * devices and brings the full checks back for every sign-in.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import type { AdminApproval, AdminDevice, AdminTeamMember } from '@raffwin/shared/admin-types'
import { hashPassword, issueTicket } from '../src/admin/session'
import type { SendOptions, SendTelegram } from '../src/context'
import { adminDevices, adminUsers, type AdminRole } from '../src/db/schema'
import { initData, telegramId, testApp } from './helpers'

const MASTER = 'trust-master-password-2026'
const { http, db, ctx } = testApp({ ADMIN_MASTER_PASSWORD_HASH: await hashPassword(MASTER) })

function fakeBot() {
  const calls: { chatId: number; text: string; opts?: SendOptions }[] = []
  const send: SendTelegram = async (chatId, text, opts) => {
    calls.push({ chatId, text, opts })
    return { messageId: calls.length }
  }
  ctx.sendTelegram = send
  return calls
}
afterEach(() => {
  ctx.sendTelegram = undefined
})

let ipSeq = Math.floor(Math.random() * 200) * 1000 + 500_000
function clientIp(): string {
  ipSeq += 1
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`
}

interface Admin {
  id: string
  username: string
  password: string
  telegramId: number
}

async function admin(role: AdminRole = 'super_admin'): Promise<Admin> {
  const tg = telegramId()
  const password = `pw-${randomUUID()}`
  const username = `trust_${tg}`
  const [row] = await db
    .insert(adminUsers)
    .values({ name: `Admin ${tg}`, username, telegramUsername: `trust${tg}`, telegramId: tg, role, passwordHash: await hashPassword(password) })
    .returning({ id: adminUsers.id })
  return { id: row!.id, username, password, telegramId: tg }
}

/** Full Telegram sign-in: the bot's ticket plus this account's initData */
async function ticketSignIn(a: Admin, rememberDevice = false) {
  const ticket = await issueTicket(ctx, a.id, a.telegramId)
  return http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: a.telegramId }), rememberDevice, platform: 'ios' })
}

async function token(a: Admin): Promise<string> {
  const res = await ticketSignIn(a)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.token as string
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` })

/** Full browser sign-in; returns the verify response */
async function webSignIn(a: Admin, ip: string, opts: { rememberDevice?: boolean; pad?: boolean } = {}) {
  const calls = fakeBot()
  const pad = (s: string) => (opts.pad ? `  ${s} \n` : s)
  const started = await http.post('/admin/v1/auth/web/start').set('x-forwarded-for', ip).send({ master: pad(MASTER), username: ` ${a.username} `, password: pad(a.password) })
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  const code = /<b>(\d{6})<\/b>/.exec(calls.at(-1)?.text ?? '')?.[1]
  return http.post('/admin/v1/auth/web/verify').set('x-forwarded-for', ip).send({ challengeId: started.body.challengeId, code, rememberDevice: opts.rememberDevice })
}

describe('browser sign-in and spaces', () => {
  it('a space or line break around the master password or password does not make them wrong', async () => {
    const a = await admin()
    const res = await webSignIn(a, clientIp(), { pad: true })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.deviceToken).toBeNull()
  })

  it('a changed password is stored trimmed, so the sign-ins that trim accept it', async () => {
    const a = await admin()
    const t = await token(a)
    const next = `new-password-${randomUUID().slice(0, 8)}`
    const changed = await http.post('/admin/v1/me/password').set(auth(t)).send({ current: ` ${a.password} `, next: `${next} ` })
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)
    expect((await webSignIn({ ...a, password: next }, clientIp())).status).toBe(200)
  })
})

describe('trusted devices', () => {
  it('browser: a trusted browser signs in with the password alone; 5 wrong passwords end the trust', async () => {
    const a = await admin()
    const ip = clientIp()
    const first = await webSignIn(a, ip, { rememberDevice: true })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const deviceToken = first.body.deviceToken as string
    expect(deviceToken).toMatch(/^[\w-]{43}$/)
    expect(first.body.admin.trustedDevice).toBe(true)

    const calls = fakeBot()
    const quick = await http.post('/admin/v1/auth/device/browser').set('x-forwarded-for', ip).send({ deviceToken, password: ` ${a.password}` })
    expect(quick.status, JSON.stringify(quick.body)).toBe(200)
    expect(quick.body.admin).toMatchObject({ id: a.id, channel: 'browser', trustedDevice: true })
    expect(calls).toHaveLength(0)

    const devices = (await http.get('/admin/v1/me/devices').set(auth(quick.body.token))).body as AdminDevice[]
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ channel: 'browser', current: true, revokedAt: null })

    for (let i = 4; i >= 0; i--) {
      const wrong = await http.post('/admin/v1/auth/device/browser').send({ deviceToken, password: 'not-it' })
      expect(wrong.status).toBe(401)
      expect(wrong.body.error.message).toMatch(i > 0 ? new RegExp(`${i} tr(y|ies) left`) : /no longer trusted/)
    }
    const after = await http.post('/admin/v1/auth/device/browser').send({ deviceToken, password: a.password })
    expect(after.status).toBe(401)
    expect(after.body.error.message).toMatch(/no longer trusted/)
    const [d] = await db.select().from(adminDevices).where(eq(adminDevices.adminId, a.id))
    expect(d?.revokedReason).toBe('wrong_passwords')
  })

  it('telegram: one tap from the bound account; another account, or the other channel, is refused', async () => {
    const a = await admin()
    const first = await ticketSignIn(a, true)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const deviceToken = first.body.deviceToken as string
    expect(deviceToken).toBeTruthy()

    const tap = await http.post('/admin/v1/auth/device/telegram').send({ deviceToken, initData: initData({ id: a.telegramId }) })
    expect(tap.status, JSON.stringify(tap.body)).toBe(200)
    expect(tap.body.admin).toMatchObject({ id: a.id, channel: 'telegram', trustedDevice: true })

    const stranger = await http.post('/admin/v1/auth/device/telegram').send({ deviceToken, initData: initData({ id: telegramId() }) })
    expect(stranger.status).toBe(401)
    const wrongChannel = await http.post('/admin/v1/auth/device/browser').send({ deviceToken, password: a.password })
    expect(wrongChannel.status).toBe(401)

    const [d] = await db.select().from(adminDevices).where(eq(adminDevices.adminId, a.id))
    expect(d?.label).toBe('Telegram on ios')
  })

  it('revoking a device ends trust and the sessions it opened', async () => {
    const a = await admin()
    const deviceToken = (await ticketSignIn(a, true)).body.deviceToken as string
    const tap = await http.post('/admin/v1/auth/device/telegram').send({ deviceToken, initData: initData({ id: a.telegramId }) })
    const other = await token(a)
    const [d] = await db.select().from(adminDevices).where(eq(adminDevices.adminId, a.id))
    const list = await http.post(`/admin/v1/me/devices/${d!.id}/revoke`).set(auth(other))
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    expect((list.body as AdminDevice[])[0]?.revokedReason).toBe('removed_by_admin')
    expect((await http.get('/admin/v1/me').set(auth(tap.body.token))).status).toBe(401)
    expect((await http.post('/admin/v1/auth/device/telegram').send({ deviceToken, initData: initData({ id: a.telegramId }) })).status).toBe(401)
    // Only your own devices
    const b = await token(await admin())
    expect((await http.post(`/admin/v1/me/devices/${d!.id}/revoke`).set(auth(b))).status).toBe(404)
  })

  it('a password reset by a super admin revokes every device', async () => {
    const a = await admin('viewer')
    const deviceToken = (await ticketSignIn(a, true)).body.deviceToken as string
    const boss = await token(await admin())
    expect((await http.post(`/admin/v1/admins/${a.id}/reset-password`).set(auth(boss))).status).toBe(200)
    expect((await http.post('/admin/v1/auth/device/telegram').send({ deviceToken, initData: initData({ id: a.telegramId }) })).status).toBe(401)
  })
})

describe('marking an admin at risk', () => {
  it('takes two admins other than the one concerned; then full checks only, everywhere', async () => {
    const target = await admin('super_admin')
    const asker = await admin('super_admin')
    const agreer = await admin('viewer')
    const deviceToken = (await ticketSignIn(target, true)).body.deviceToken as string
    const targetSession = await token(target)
    const askerT = await token(asker)
    const agreerT = await token(agreer)

    // Not about yourself
    expect((await http.post(`/admin/v1/team/${target.id}/risk`).set(auth(targetSession)).send({ reason: 'I lost my phone' })).status).toBe(403)

    const asked = await http.post(`/admin/v1/team/${target.id}/risk`).set(auth(askerT)).send({ reason: 'Logins from a strange place' })
    expect(asked.status, JSON.stringify(asked.body)).toBe(202)
    const approval = asked.body as AdminApproval
    expect(approval).toMatchObject({ action: 'admin_risk_flag', status: 'pending', requestedByAdminId: asker.id })
    // A super admin asking does not make it happen
    const [still] = await db.select().from(adminUsers).where(eq(adminUsers.id, target.id))
    expect(still?.riskFlaggedAt).toBeNull()
    // One request at a time
    expect((await http.post(`/admin/v1/team/${target.id}/risk`).set(auth(agreerT)).send({ reason: 'Same worry here' })).status).toBe(400)

    const team = (await http.get('/admin/v1/team').set(auth(agreerT))).body as AdminTeamMember[]
    expect(team.find((m) => m.id === target.id)?.pending).toMatchObject({ approvalId: approval.id, action: 'admin_risk_flag', requestedByMe: false })

    // Neither the asker nor the admin concerned can be the second
    expect((await http.post(`/admin/v1/approvals/${approval.id}/approve`).set(auth(askerT)).send({})).status).toBe(403)
    expect((await http.post(`/admin/v1/approvals/${approval.id}/approve`).set(auth(targetSession)).send({})).status).toBe(403)

    const calls = fakeBot()
    const agreed = await http.post(`/admin/v1/approvals/${approval.id}/approve`).set(auth(agreerT)).send({ note: 'Agreed' })
    expect(agreed.status, JSON.stringify(agreed.body)).toBe(200)
    expect(agreed.body).toMatchObject({ status: 'approved', result: { sessionsEnded: 2, devicesRevoked: 1 } })
    expect(calls.map((c) => c.chatId)).toEqual([target.telegramId])
    expect(calls[0]?.text).toMatch(/marked your admin account at risk/)

    // Signed out, device gone, nothing new trusted, shorter idle limit
    expect((await http.get('/admin/v1/me').set(auth(targetSession))).status).toBe(401)
    expect((await http.post('/admin/v1/auth/device/telegram').send({ deviceToken, initData: initData({ id: target.telegramId }) })).status).toBe(401)
    const full = await ticketSignIn(target, true)
    expect(full.status).toBe(200)
    expect(full.body).toMatchObject({ deviceToken: null, idleMinutes: 30, admin: { atRisk: true, trustedDevice: false } })
    expect(await db.select().from(adminDevices).where(and(eq(adminDevices.adminId, target.id), isNull(adminDevices.revokedAt)))).toHaveLength(0)

    // Clearing takes two admins as well
    const clear = await http.post(`/admin/v1/team/${target.id}/clear-risk`).set(auth(agreerT)).send({ reason: 'Checked with him in person' })
    expect(clear.status, JSON.stringify(clear.body)).toBe(202)
    expect((await http.post(`/admin/v1/approvals/${clear.body.id}/approve`).set(auth(full.body.token)).send({})).status).toBe(403)
    expect((await http.post(`/admin/v1/approvals/${clear.body.id}/approve`).set(auth(askerT)).send({})).status).toBe(200)
    const [cleared] = await db.select().from(adminUsers).where(eq(adminUsers.id, target.id))
    expect(cleared?.riskFlaggedAt).toBeNull()
    expect((await ticketSignIn(target, true)).body.deviceToken).toBeTruthy()
  })

  it('other approvals still need approvals.decide', async () => {
    const boss = await token(await admin('super_admin'))
    const viewer = await token(await admin('viewer'))
    const support = await admin('support')
    const asked = await http.post(`/admin/v1/team/${support.id}/risk`).set(auth(boss)).send({ reason: 'Shared their password' })
    expect(asked.status).toBe(202)
    // A viewer may agree to this one...
    expect((await http.post(`/admin/v1/approvals/${asked.body.id}/reject`).set(auth(viewer)).send({ note: 'Not convinced' })).status).toBe(200)
    // ...but no other kind (left pending; nobody approves it)
    const finance = await token(await admin('finance'))
    const rate = await http.post('/admin/v1/settings/rate-base').set(auth(finance)).send({ nairaPerRaff: 15, moveMinPct: 3, moveMaxPct: 15, reason: 'Test request' })
    expect(rate.status, JSON.stringify(rate.body)).toBe(202)
    expect((await http.post(`/admin/v1/approvals/${rate.body.id}/approve`).set(auth(viewer)).send({})).status).toBe(403)
    expect((await http.post(`/admin/v1/approvals/${rate.body.id}/reject`).set(auth(viewer)).send({})).status).toBe(403)
  })
})
