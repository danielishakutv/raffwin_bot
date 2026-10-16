import { and, eq, gte } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { securityEvents, sessions, users } from '../src/db/schema'
import { sha256Hex } from '../src/lib/crypto'
import { initData, telegramId, testApp } from './helpers'

const { http, db, ctx } = testApp()

async function eventsOfKind(kind: string, since: Date) {
  return db
    .select()
    .from(securityEvents)
    .where(and(eq(securityEvents.kind, kind), gte(securityEvents.occurredAt, since)))
}

async function login(id = telegramId(), startParam?: string) {
  const res = await http.post('/v1/auth/telegram').send({ initData: initData({ id }, { startParam }) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { id, ...(res.body as { accessToken: string; refreshToken: string; accessTokenExpiresAt: number }) }
}

describe('GET /health', () => {
  it('reports the database as up', async () => {
    const res = await http.get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, db: 'up', env: 'test' })
  })
})

describe('POST /v1/auth/telegram', () => {
  it('creates the user and returns a session for valid initData', async () => {
    const s = await login()
    expect(s.accessToken).toMatch(/^ey/)
    expect(s.refreshToken).toHaveLength(43)
    const [row] = await db.select().from(users).where(eq(users.telegramId, s.id))
    expect(row).toMatchObject({ status: 'active', signedUpAt: null })
    expect(row?.referralCode).toMatch(/^[2-9A-HJKMNP-Z]{8}$/)

    const boot = await http.get('/v1/bootstrap').set('authorization', `Bearer ${s.accessToken}`)
    expect(boot.status).toBe(200)
    // Raffles are shared by every test file in the run, so only their presence is checked
    expect(boot.body).toMatchObject({ profile: null, onboardingComplete: false, balance: 0, entries: [], transactions: [] })
    expect(Array.isArray(boot.body.raffles)).toBe(true)
  })

  it('finds the same user on the next open', async () => {
    const id = telegramId()
    await login(id)
    await login(id)
    const rows = await db.select().from(users).where(eq(users.telegramId, id))
    expect(rows).toHaveLength(1)
  })

  it('rejects a forged hash and records it', async () => {
    const since = new Date(Date.now() - 1000)
    const forged = initData({ id: telegramId() }, { token: '42:a-different-bot-token-a-different-bot' })
    const res = await http.post('/v1/auth/telegram').send({ initData: forged })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_INVALID')
    expect(res.body.error.requestId).toBeTruthy()
    const events = await eventsOfKind('initdata_bad_hash', since)
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]).toMatchObject({ severity: 'high', category: 'initdata' })
    expect(events[0]?.ipHash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('tells an expired session apart from a forged one', async () => {
    const stale = initData({ id: telegramId() }, { authDate: Math.floor(Date.now() / 1000) - 7200 })
    const res = await http.post('/v1/auth/telegram').send({ initData: stale })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_EXPIRED')
  })

  it('allows reuse of the same initData but records it', async () => {
    const since = new Date(Date.now() - 1000)
    const data = initData({ id: telegramId() })
    expect((await http.post('/v1/auth/telegram').send({ initData: data })).status).toBe(200)
    expect((await http.post('/v1/auth/telegram').send({ initData: data })).status).toBe(200)
    const events = await eventsOfKind('initdata_reuse', since)
    expect(events.some((e) => (e.details as { useCount?: number }).useCount === 2)).toBe(true)
  })

  it('refuses reuse when INITDATA_SINGLE_USE is on', async () => {
    const strict = testApp({ INITDATA_SINGLE_USE: 'true' })
    const data = initData({ id: telegramId() })
    expect((await strict.http.post('/v1/auth/telegram').send({ initData: data })).status).toBe(200)
    const second = await strict.http.post('/v1/auth/telegram').send({ initData: data })
    expect(second.status).toBe(401)
    expect(second.body.error.code).toBe('AUTH_INVALID')
  })

  it('refuses a suspended account', async () => {
    const id = telegramId()
    await login(id)
    await db.update(users).set({ status: 'suspended' }).where(eq(users.telegramId, id))
    const res = await http.post('/v1/auth/telegram').send({ initData: initData({ id }) })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED')
  })

  it('validates the body', async () => {
    const res = await http.post('/v1/auth/telegram').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({ code: 'INVALID_INPUT', fields: { initData: expect.any(String) } })
    const bad = await http.post('/v1/auth/telegram').set('content-type', 'application/json').send('{not json')
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('INVALID_INPUT')
  })
})

describe('access tokens', () => {
  it('needs a bearer token', async () => {
    const res = await http.get('/v1/bootstrap')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_INVALID')
  })

  it('reports expiry separately so the client refreshes', async () => {
    // jose checks exp against the real clock, so issue the token an hour in the past
    const past = await ctx.tokens.issue({ userId: 'u', sessionId: 's' }, Date.now() - 3600_000)
    const res = await http.get('/v1/bootstrap').set('authorization', `Bearer ${past.token}`)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_EXPIRED')
  })

  it('rejects a token signed with another key', async () => {
    const res = await http
      .get('/v1/bootstrap')
      .set('authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_INVALID')
  })
})

describe('POST /v1/auth/refresh', () => {
  it('rotates the refresh token', async () => {
    const s = await login()
    const res = await http.post('/v1/auth/refresh').send({ refreshToken: s.refreshToken })
    expect(res.status).toBe(200)
    expect(res.body.refreshToken).not.toBe(s.refreshToken)
    const boot = await http.get('/v1/bootstrap').set('authorization', `Bearer ${res.body.accessToken}`)
    expect(boot.status).toBe(200)
  })

  it('revokes the whole family when a retired token comes back', async () => {
    const since = new Date(Date.now() - 1000)
    const s = await login()
    const first = await http.post('/v1/auth/refresh').send({ refreshToken: s.refreshToken })
    expect(first.status).toBe(200)

    // An attacker replays the original token
    const replay = await http.post('/v1/auth/refresh').send({ refreshToken: s.refreshToken })
    expect(replay.status).toBe(401)
    expect(replay.body.error.code).toBe('AUTH_INVALID')

    // ...which also kills the legitimate holder's newer tokens
    const again = await http.post('/v1/auth/refresh').send({ refreshToken: first.body.refreshToken })
    expect(again.status).toBe(401)
    const boot = await http.get('/v1/bootstrap').set('authorization', `Bearer ${first.body.accessToken}`)
    expect(boot.status).toBe(401)

    const events = await eventsOfKind('refresh_reused', since)
    expect(events[0]).toMatchObject({ severity: 'high', actionTaken: 'blocked' })
  })

  it('rejects an unknown token', async () => {
    const res = await http.post('/v1/auth/refresh').send({ refreshToken: 'a'.repeat(43) })
    expect(res.status).toBe(401)
  })

  it('reports an expired refresh token as AUTH_EXPIRED', async () => {
    const s = await login()
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.refreshTokenHash, sha256Hex(s.refreshToken)))
    const res = await http.post('/v1/auth/refresh').send({ refreshToken: s.refreshToken })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_EXPIRED')
  })
})

describe('POST /v1/auth/logout', () => {
  it('ends the session at once', async () => {
    const s = await login()
    const out = await http.post('/v1/auth/logout').set('authorization', `Bearer ${s.accessToken}`)
    expect(out.status).toBe(204)
    const boot = await http.get('/v1/bootstrap').set('authorization', `Bearer ${s.accessToken}`)
    expect(boot.status).toBe(401)
    const refresh = await http.post('/v1/auth/refresh').send({ refreshToken: s.refreshToken })
    expect(refresh.status).toBe(401)
  })
})
