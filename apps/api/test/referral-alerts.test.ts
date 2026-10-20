/**
 * 20 Oct: the bot tells a referrer when someone joins with their link, and
 * when one of their referrals tops up (a purchase or a voucher), with what
 * they can earn from it. Off with the "Referral alerts" switch.
 */
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { signRelay, type CreditRequest, type RelayOperation } from '@raffwin/relay'
import { hashPassword, issueTicket } from '../src/admin/session'
import { adminUsers, featureFlagOverrides, notifications, users } from '../src/db/schema'
import { member as open } from './fixtures'
import { initData, telegramId, testApp } from './helpers'

const SECRET = 'relay-secret-'.padEnd(64, 'x')
const PATH = 'q8Rk2mZr9vXc4hTn8bLw6sJe'
const { http, db, ctx } = testApp({ RELAY_SECRET: SECRET, RELAY_PATH: PATH, PUBLIC_APP_URL: 'https://raffwintest.example/' })

function relay(op: RelayOperation, body: unknown) {
  const raw = JSON.stringify(body)
  return http.post(`/internal/${PATH}/${op}`).set(signRelay(SECRET, op, raw, ctx.now())).send(raw)
}

async function goodCredit(tg: number, naira: number): Promise<CreditRequest> {
  const { rate } = (await relay('account', { telegramId: tg })).body
  const nairaKobo = naira * 100
  return {
    reference: `ps_${randomUUID().replaceAll('-', '')}`,
    source: 'paystack',
    telegramId: tg,
    quoteId: randomUUID(),
    nairaKobo,
    rateId: rate.id,
    nairaPerRaffKobo: rate.nairaPerRaffKobo,
    baseRaffs: Math.floor(nairaKobo / rate.nairaPerRaffKobo),
    bonusRaffs: 0,
    paidAt: new Date(ctx.now()).toISOString(),
  }
}

async function admin(role: 'super_admin' | 'finance') {
  const tg = telegramId()
  const [a] = await db
    .insert(adminUsers)
    .values({ name: `Ref ${role}`, username: `ref_${tg}`, telegramUsername: `ref${tg}`, telegramId: tg, role, passwordHash: await hashPassword('x'.repeat(16)) })
    .returning({ id: adminUsers.id })
  const ticket = await issueTicket(ctx, a!.id, tg)
  const res = await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: tg }) })
  const headers = { authorization: `Bearer ${res.body.token as string}` }
  return { id: a!.id, post: (path: string, body: object = {}) => http.post(`/admin/v1${path}`).set(headers).send(body) }
}

const alertsFor = (userId: string) => db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, 'referral')))

describe('referral alerts', () => {
  it('the referrer hears when someone joins with their link, once, with what they can earn', async () => {
    const referrer = await open(http)
    const friend = await open(http, { startParam: `ref_${referrer.referralCode}` })
    const [msg, ...rest] = await alertsFor(referrer.userId)
    expect(rest).toHaveLength(0)
    expect(msg?.templateKey).toBe('referral_joined')
    expect(msg?.text).toBe(
      `<b>@${friend.username} joined Raffle Win with your link</b>\n\nYou get 10% of every Raff they spend on raffle entries, for as long as they play. If they spend 5,000 Raffs, you get 500.`,
    )
    expect(msg?.buttons).toEqual([[{ text: 'See my referrals', webApp: 'https://raffwintest.example/#/referrals' }]])
    // A second friend is a second message; the friends themselves are told nothing
    await open(http, { startParam: `ref_${referrer.referralCode}` })
    expect((await alertsFor(referrer.userId)).length).toBe(2)
    expect((await alertsFor(friend.userId)).length).toBe(0)
  })

  it('a purchase by a referral tells the referrer the most it can earn them', async () => {
    const referrer = await open(http)
    const friend = await open(http, { startParam: `ref_${referrer.referralCode}` })
    const credit = await goodCredit(friend.telegramId, 20_000)
    const res = await relay('credit', credit)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const raffs = res.body.raffs as number
    const topups = (await alertsFor(referrer.userId)).filter((n) => n.templateKey === 'referral_topup')
    expect(topups).toHaveLength(1)
    expect(topups[0]?.text).toBe(
      `<b>@${friend.username} just added ${raffs.toLocaleString('en-NG')} Raffs</b>\n\nWhen they spend them on raffle entries, you earn up to ${Math.floor(raffs / 10).toLocaleString('en-NG')} Raffs (10%). It lands in your balance with each entry they make.`,
    )
    // The same payment relayed again is not a second message
    expect((await relay('credit', credit)).status).toBe(200)
    expect((await alertsFor(referrer.userId)).filter((n) => n.templateKey === 'referral_topup')).toHaveLength(1)
  })

  it('a voucher redeemed by a referral tells the referrer too; a player with no referrer tells nobody', async () => {
    const finance = await admin('finance')
    const boss = await admin('super_admin')
    const asked = await finance.post('/vouchers/batches', { vendor: 'Utako Kiosk', valueRaffs: 750, count: 2, expiresAt: null, reason: 'Restock' })
    const ok = await boss.post(`/approvals/${asked.body.id}/approve`)
    const [code1, code2] = (await finance.post(`/vouchers/batches/${ok.body.result.batchId}/issue`)).body.codes as string[]

    const referrer = await open(http)
    const friend = await open(http, { startParam: `ref_${referrer.referralCode}` })
    expect((await friend.post('/v1/vouchers/redeem', { code: code1 })).status).toBe(200)
    const topup = (await alertsFor(referrer.userId)).find((n) => n.templateKey === 'referral_topup')
    expect(topup?.text).toContain('just added 750 Raffs')
    expect(topup?.text).toContain('up to 75 Raffs')

    const loner = await open(http)
    const before = await db.select().from(notifications).where(eq(notifications.kind, 'referral'))
    expect((await loner.post('/v1/vouchers/redeem', { code: code2 })).status).toBe(200)
    const after = await db.select().from(notifications).where(eq(notifications.kind, 'referral'))
    expect(after.length).toBe(before.length)
  })

  it('stays quiet for a referrer who blocked the bot or has the switch turned off for them', async () => {
    const blocked = await open(http)
    await db.update(users).set({ botBlockedAt: new Date() }).where(eq(users.id, blocked.userId))
    await open(http, { startParam: `ref_${blocked.referralCode}` })
    expect(await alertsFor(blocked.userId)).toHaveLength(0)

    const optedOut = await open(http)
    const boss = await admin('super_admin')
    await db.insert(featureFlagOverrides).values({ flagKey: 'referral_alerts', userId: optedOut.userId, enabled: false, note: 'asked to stop', createdByAdminId: boss.id })
    await open(http, { startParam: `ref_${optedOut.referralCode}` })
    expect(await alertsFor(optedOut.userId)).toHaveLength(0)
  })
})
