import { and, eq, gte } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Bootstrap } from '@raffwin/shared'
import { securityEvents, users } from '../src/db/schema'
import { contactProof, initData, nigerianPhone, telegramId, testApp, uniqueUsername } from './helpers'

const { http, db } = testApp()

async function session(startParam?: string) {
  const id = telegramId()
  const res = await http.post('/v1/auth/telegram').send({ initData: initData({ id }, { startParam }) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const token = res.body.accessToken as string
  return {
    id,
    get: (path: string) => http.get(path).set('authorization', `Bearer ${token}`),
    post: (path: string, body?: object) => http.post(path).set('authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => http.patch(path).set('authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => http.put(path).set('authorization', `Bearer ${token}`).send(body),
  }
}

type Session = Awaited<ReturnType<typeof session>>

async function signUp(s: Session, overrides: { phone?: string; username?: string; proof?: string } = {}) {
  const phone = overrides.phone ?? nigerianPhone()
  return s.post('/v1/signup', {
    fullName: 'Ada Obi',
    username: overrides.username ?? uniqueUsername(),
    email: 'ADA@example.com',
    contactProof: overrides.proof ?? contactProof(s.id, phone.replace('+', '')),
  })
}

async function events(kind: string, since: Date) {
  return db.select().from(securityEvents).where(and(eq(securityEvents.kind, kind), gte(securityEvents.occurredAt, since)))
}

describe('POST /v1/signup', () => {
  it('creates the profile with the phone Telegram verified', async () => {
    const s = await session()
    const username = uniqueUsername('ada')
    const res = await signUp(s, { username })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const body = res.body as Bootstrap
    expect(body.profile).toMatchObject({
      fullName: 'Ada Obi',
      username,
      email: 'ada@example.com',
      phoneVerified: true,
      telegramId: s.id,
      contactPrefs: { whatsapp: true, telegram: true, email: false },
      verification: { status: 'unverified' },
      address: null,
    })
    expect(body.profile?.phone).toMatch(/^\+234803\d{7}$/)
    expect(body.profile?.referralCode).toMatch(/^[2-9A-HJKMNP-Z]{8}$/)
    expect(body.onboardingComplete).toBe(false)

    const boot = await s.get('/v1/bootstrap')
    expect(boot.body.profile.username).toBe(username)
  })

  it('accepts the phone with or without a leading +', async () => {
    const s = await session()
    const res = await signUp(s, { proof: contactProof(s.id, `+${nigerianPhone().slice(1)}`) })
    expect(res.status).toBe(201)
  })

  it('refuses a missing or forged contact share', async () => {
    const s = await session()
    const forged = contactProof(s.id, '2348031112222', { token: '1:not-the-bot-token-not-the-bot-token' })
    const res = await signUp(s, { proof: forged })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('PHONE_NOT_VERIFIED')
  })

  it('refuses somebody else\'s contact and records it as fraud', async () => {
    const since = new Date(Date.now() - 1000)
    const s = await session()
    const res = await signUp(s, { proof: contactProof(s.id + 1, nigerianPhone().slice(1)) })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('PHONE_NOT_VERIFIED')
    const found = await events('contact_other_account', since)
    expect(found[0]).toMatchObject({ category: 'fraud', severity: 'high' })
  })

  it('refuses a stale contact share', async () => {
    const s = await session()
    const stale = contactProof(s.id, nigerianPhone().slice(1), { authDate: Math.floor(Date.now() / 1000) - 7200 })
    const res = await signUp(s, { proof: stale })
    expect(res.body.error.code).toBe('PHONE_NOT_VERIFIED')
  })

  it('refuses a number outside Nigeria with a field message', async () => {
    const s = await session()
    const res = await signUp(s, { proof: contactProof(s.id, '447700900123') })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({ code: 'INVALID_INPUT', fields: { phone: expect.any(String) } })
  })

  it('keeps one account per phone and per username', async () => {
    const phone = nigerianPhone()
    const username = uniqueUsername()
    const a = await session()
    expect((await signUp(a, { phone, username })).status).toBe(201)

    const b = await session()
    const samePhone = await signUp(b, { phone })
    expect(samePhone.status).toBe(409)
    expect(samePhone.body.error.code).toBe('PHONE_IN_USE')

    const sameName = await signUp(b, { username: username.toUpperCase() })
    expect(sameName.status).toBe(409)
    expect(sameName.body.error.code).toBe('USERNAME_TAKEN')
  })

  it('signs up only once', async () => {
    const s = await session()
    expect((await signUp(s)).status).toBe(201)
    const again = await signUp(s)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('ALREADY_REGISTERED')
  })

  it('returns the form messages for bad fields', async () => {
    const s = await session()
    const res = await s.post('/v1/signup', { fullName: 'Ada', username: 'x', email: 'no', contactProof: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error.fields).toMatchObject({
      fullName: 'Add your surname too, e.g. Ada Obi',
      username: 'At least 3 characters',
      email: 'That email does not look right',
    })
  })
})

describe('GET /v1/username-available', () => {
  it('answers for free, taken and invalid names', async () => {
    const a = await session()
    const taken = uniqueUsername()
    await signUp(a, { username: taken })
    const b = await session()
    expect((await b.get(`/v1/username-available?username=${taken}`)).body).toEqual({ available: false })
    expect((await b.get(`/v1/username-available?username=${uniqueUsername()}`)).body).toEqual({ available: true })
    expect((await b.get('/v1/username-available?username=no!')).body).toEqual({ available: false })
    // Your own name counts as available to you
    expect((await a.get(`/v1/username-available?username=${taken}`)).body).toEqual({ available: true })
  })
})

describe('referrals', () => {
  async function referrer() {
    const s = await session()
    const res = await signUp(s)
    return { s, code: (res.body as Bootstrap).profile?.referralCode as string, id: (res.body as Bootstrap).profile?.id }
  }

  it('binds the referrer from the first open\'s start_param', async () => {
    const r = await referrer()
    const friend = await session(`ref_${r.code.toLowerCase()}`)
    expect((await signUp(friend)).status).toBe(201)
    const [row] = await db.select().from(users).where(eq(users.telegramId, friend.id))
    expect(row?.referredByUserId).toBe(r.id)
    expect(row?.referredAt).not.toBeNull()
  })

  it('keeps the first referrer if the user opens a second referral link before signing up', async () => {
    const first = await referrer()
    const second = await referrer()
    const id = telegramId()
    await http.post('/v1/auth/telegram').send({ initData: initData({ id }, { startParam: `ref_${first.code}` }) })
    const res = await http.post('/v1/auth/telegram').send({ initData: initData({ id }, { startParam: `ref_${second.code}` }) })
    const token = res.body.accessToken as string
    const signed = await http
      .post('/v1/signup')
      .set('authorization', `Bearer ${token}`)
      .send({ fullName: 'Ada Obi', username: uniqueUsername(), email: 'a@b.co', contactProof: contactProof(id, nigerianPhone().slice(1)) })
    expect(signed.status).toBe(201)
    const [row] = await db.select().from(users).where(eq(users.telegramId, id))
    expect(row?.referredByUserId).toBe(first.id)
  })

  it('ignores an unknown code without blocking sign-up, and records it', async () => {
    const since = new Date(Date.now() - 1000)
    const friend = await session('ref_ZZZZZZZZ')
    expect((await signUp(friend)).status).toBe(201)
    const [row] = await db.select().from(users).where(eq(users.telegramId, friend.id))
    expect(row?.referredByUserId).toBeNull()
    expect((await events('referral_unknown_code', since)).length).toBeGreaterThan(0)
  })

  it('ignores a code from an account that has not signed up', async () => {
    const pending = await session()
    const [p] = await db.select().from(users).where(eq(users.telegramId, pending.id))
    const friend = await session(`ref_${p?.referralCode}`)
    expect((await signUp(friend)).status).toBe(201)
    const [row] = await db.select().from(users).where(eq(users.telegramId, friend.id))
    expect(row?.referredByUserId).toBeNull()
  })
})

describe('profile', () => {
  async function member() {
    const s = await session()
    expect((await signUp(s)).status).toBe(201)
    return s
  }

  it('needs sign-up first', async () => {
    const s = await session()
    const res = await s.get('/v1/profile')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('NOT_SIGNED_IN')
  })

  it('completes onboarding once', async () => {
    const s = await member()
    expect((await s.post('/v1/onboarding/complete')).body).toEqual({ onboardingComplete: true })
    expect((await s.get('/v1/bootstrap')).body.onboardingComplete).toBe(true)
    expect((await s.post('/v1/onboarding/complete')).status).toBe(200)
  })

  it('updates name, username and email, but never the verified phone', async () => {
    const s = await member()
    const name = uniqueUsername('new')
    const res = await s.patch('/v1/profile', { fullName: 'Ada Nwosu', username: name, email: 'NEW@example.com' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ fullName: 'Ada Nwosu', username: name, email: 'new@example.com' })

    const phone = await s.patch('/v1/profile', { phone: '+2348030000000' })
    expect(phone.status).toBe(400)
  })

  it('saves and replaces the delivery address', async () => {
    const s = await member()
    const address = { street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos', landmark: 'Near the bank', phone: '' }
    expect((await s.put('/v1/profile/address', address)).body.address).toEqual(address)
    const moved = { ...address, city: 'Yaba' }
    expect((await s.put('/v1/profile/address', moved)).body.address.city).toBe('Yaba')
    expect((await s.put('/v1/profile/address', { street: '' })).status).toBe(400)
  })

  it('saves contact preferences', async () => {
    const s = await member()
    const res = await s.put('/v1/profile/contact-prefs', { whatsapp: false, telegram: true, email: true })
    expect(res.body.contactPrefs).toEqual({ whatsapp: false, telegram: true, email: true })
  })
})

describe('unknown routes', () => {
  it('answer with the standard error body', async () => {
    const res = await http.get('/v1/nope')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })
})
