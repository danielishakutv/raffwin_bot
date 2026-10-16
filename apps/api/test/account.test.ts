import { and, eq, gte } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Profile } from '@raffwin/shared'
import { deliveryPoints, securityEvents, users } from '../src/db/schema'
import { kyc, member } from './fixtures'
import { contactProof, initData, nigerianPhone, telegramId, testApp, uniqueUsername } from './helpers'

const { http, db } = testApp()

async function events(kind: string, since: Date) {
  return db.select().from(securityEvents).where(and(eq(securityEvents.kind, kind), gte(securityEvents.occurredAt, since)))
}

describe('first open = the account (no sign-up)', () => {
  it('creates a complete profile from Telegram alone', async () => {
    const name = uniqueUsername('ada')
    const m = await member(http, { username: name })
    const profile = (await m.get('/v1/profile')).body as Profile
    expect(profile).toMatchObject({
      username: name,
      fullName: 'Ada',
      phone: null,
      phoneVerified: false,
      email: null,
      delivery: null,
      kycComplete: false,
      isAdmin: false,
      telegramId: m.telegramId,
    })
    expect(profile.referralCode).toMatch(/^[2-9A-HJKMNP-Z]{8}$/)
    expect((await m.get('/v1/bootstrap')).body.onboardingComplete).toBe(false)
  })

  it('gives a generated username when the Telegram one is missing, invalid or taken', async () => {
    const taken = uniqueUsername('t')
    await member(http, { username: taken })
    const clash = await member(http, { username: taken })
    expect(clash.username).toMatch(/^player_[2-9a-hjkmnp-z]{6}$/)

    const id = telegramId()
    const res = await http.post('/v1/auth/telegram').send({ initData: initData({ id, username: 'Bad-Name!' }) })
    const boot = await http.get('/v1/bootstrap').set('authorization', `Bearer ${res.body.accessToken}`)
    expect(boot.body.profile.username).toMatch(/^player_/)
  })

  it('updates Telegram details on the next open without touching the profile', async () => {
    const m = await member(http)
    await db.update(users).set({ fullName: 'Chosen Name' }).where(eq(users.telegramId, m.telegramId))
    await http.post('/v1/auth/telegram').send({ initData: initData({ id: m.telegramId, username: 'renamed_tg', first_name: 'New' }) })
    const [row] = await db.select().from(users).where(eq(users.telegramId, m.telegramId))
    expect(row).toMatchObject({ tgUsername: 'renamed_tg', tgFirstName: 'New', fullName: 'Chosen Name', username: m.username })
  })
})

describe('PUT /v1/kyc', () => {
  it('saves name, the Telegram-verified phone and the motor park, never a street', async () => {
    const m = await member(http)
    const res = await m.put('/v1/kyc', kyc(m, { street: '12 Allen Avenue' }))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const p = res.body as Profile
    expect(p).toMatchObject({
      fullName: 'Ada Obi',
      phoneVerified: true,
      kycComplete: true,
      delivery: { state: 'Lagos', city: 'Ikeja', motorPark: 'Ojota Motor Park' },
    })
    expect(p.phone).toMatch(/^\+234803\d{7}$/)
    expect(JSON.stringify(p)).not.toContain('Allen')
    const [point] = await db.select().from(deliveryPoints).where(eq(deliveryPoints.userId, m.userId))
    expect(point).toMatchObject({ city: 'Ikeja', motorPark: 'Ojota Motor Park' })
  })

  it('lets a verified player change the motor park without sharing the phone again', async () => {
    const m = await member(http)
    await m.put('/v1/kyc', kyc(m))
    const res = await m.put('/v1/kyc', kyc(m, { city: 'Yaba', motorPark: 'Yaba Bus Stop Park', contactProof: undefined }))
    expect(res.status).toBe(200)
    expect(res.body.delivery).toEqual({ state: 'Lagos', city: 'Yaba', motorPark: 'Yaba Bus Stop Park' })
  })

  it('needs a phone share the first time', async () => {
    const m = await member(http)
    const res = await m.put('/v1/kyc', kyc(m, { contactProof: undefined }))
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('PHONE_NOT_VERIFIED')
  })

  it('refuses a forged or stale share, and somebody else\'s', async () => {
    const since = new Date(Date.now() - 1000)
    const m = await member(http)
    const forged = contactProof(m.telegramId, '2348031112222', { token: '1:not-the-bot-token-not-the-bot-token' })
    expect((await m.put('/v1/kyc', kyc(m, { contactProof: forged }))).body.error.code).toBe('PHONE_NOT_VERIFIED')
    const stale = contactProof(m.telegramId, nigerianPhone().slice(1), { authDate: Math.floor(Date.now() / 1000) - 7200 })
    expect((await m.put('/v1/kyc', kyc(m, { contactProof: stale }))).body.error.code).toBe('PHONE_NOT_VERIFIED')
    const other = contactProof(m.telegramId + 1, nigerianPhone().slice(1))
    expect((await m.put('/v1/kyc', kyc(m, { contactProof: other }))).body.error.code).toBe('PHONE_NOT_VERIFIED')
    expect((await events('contact_other_account', since))[0]).toMatchObject({ category: 'fraud', severity: 'high' })
  })

  it('refuses a number outside Nigeria with a field message', async () => {
    const m = await member(http)
    const res = await m.put('/v1/kyc', kyc(m, { contactProof: contactProof(m.telegramId, '447700900123') }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({ code: 'INVALID_INPUT', fields: { phone: expect.any(String) } })
  })

  it('keeps one account per phone', async () => {
    const phone = nigerianPhone().slice(1)
    const a = await member(http)
    expect((await a.put('/v1/kyc', kyc(a, { contactProof: contactProof(a.telegramId, phone) }))).status).toBe(200)
    const b = await member(http)
    const res = await b.put('/v1/kyc', kyc(b, { contactProof: contactProof(b.telegramId, phone) }))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('PHONE_IN_USE')
  })

  it('returns the form messages for bad fields', async () => {
    const m = await member(http)
    const res = await m.put('/v1/kyc', { fullName: 'Ada', state: '', city: '', motorPark: '' })
    expect(res.status).toBe(400)
    expect(res.body.error.fields).toMatchObject({
      fullName: 'Add your surname too, e.g. Ada Obi',
      motorPark: 'Enter the motor park nearest to you',
    })
  })
})

describe('referrals bound on first open', () => {
  it('binds the referrer from the start_param of the very first open', async () => {
    const r = await member(http)
    const friend = await member(http, { startParam: `ref_${r.referralCode.toLowerCase()}` })
    const [row] = await db.select().from(users).where(eq(users.telegramId, friend.telegramId))
    expect(row?.referredByUserId).toBe(r.userId)
  })

  it('never re-binds on a later open with another link', async () => {
    const first = await member(http)
    const second = await member(http)
    const friend = await member(http, { startParam: `ref_${first.referralCode}` })
    await http.post('/v1/auth/telegram').send({ initData: initData({ id: friend.telegramId }, { startParam: `ref_${second.referralCode}` }) })
    const [row] = await db.select().from(users).where(eq(users.telegramId, friend.telegramId))
    expect(row?.referredByUserId).toBe(first.userId)
  })

  it('ignores and records an unknown code', async () => {
    const since = new Date(Date.now() - 1000)
    const friend = await member(http, { startParam: 'ref_ZZZZZZZZ' })
    const [row] = await db.select().from(users).where(eq(users.telegramId, friend.telegramId))
    expect(row?.referredByUserId).toBeNull()
    expect((await events('referral_unknown_code', since)).length).toBeGreaterThan(0)
  })

  it("records a friend verifying the referrer's own phone as self-referral", async () => {
    const since = new Date(Date.now() - 1000)
    const phone = nigerianPhone().slice(1)
    const r = await member(http)
    await r.put('/v1/kyc', kyc(r, { contactProof: contactProof(r.telegramId, phone) }))
    const friend = await member(http, { startParam: `ref_${r.referralCode}` })
    const res = await friend.put('/v1/kyc', kyc(friend, { contactProof: contactProof(friend.telegramId, phone) }))
    expect(res.body.error.code).toBe('PHONE_IN_USE')
    const found = await events('referral_self_same_phone', since)
    expect(found[0]).toMatchObject({ severity: 'high', category: 'fraud', userId: friend.userId })
  })
})

describe('profile', () => {
  it('completes onboarding once', async () => {
    const m = await member(http)
    expect((await m.post('/v1/onboarding/complete')).body).toEqual({ onboardingComplete: true })
    expect((await m.get('/v1/bootstrap')).body.onboardingComplete).toBe(true)
  })

  it('updates name and username, never the phone', async () => {
    const m = await member(http)
    const name = uniqueUsername('new')
    const res = await m.patch('/v1/profile', { fullName: 'Ada Nwosu', username: name })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ fullName: 'Ada Nwosu', username: name })
    expect((await m.patch('/v1/profile', { phone: '+2348030000000' })).status).toBe(400)
  })

  it('saves contact preferences', async () => {
    const m = await member(http)
    const res = await m.put('/v1/profile/contact-prefs', { whatsapp: false, telegram: true, email: true })
    expect(res.body.contactPrefs).toEqual({ whatsapp: false, telegram: true, email: true })
  })
})

describe('unknown routes', () => {
  it('answer with the standard error body, including the removed sign-up', async () => {
    const m = await member(http)
    const res = await m.post('/v1/signup', {})
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })
})
