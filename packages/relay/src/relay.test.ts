import { describe, expect, it } from 'vitest'
import { creditRequest, MAX_AGE_SECONDS, relaySignature, SIGNATURE_HEADER, signRelay, TIMESTAMP_HEADER, verifyRelay } from './index'

const SECRET = 'a'.repeat(48)
const OLD = 'b'.repeat(48)
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)
const body = JSON.stringify({ telegramId: 42 })

function check(headers: Record<string, string>, over: Partial<Parameters<typeof verifyRelay>[0]> = {}) {
  return verifyRelay({
    secrets: [SECRET],
    operation: 'account',
    rawBody: body,
    timestamp: headers[TIMESTAMP_HEADER],
    signature: headers[SIGNATURE_HEADER],
    now: NOW,
    ...over,
  })
}

describe('relay signature', () => {
  it('accepts a request signed with the secret', () => {
    expect(check(signRelay(SECRET, 'account', body, NOW))).toEqual({ ok: true, secretIndex: 0 })
  })

  it('is HMAC-SHA256 over timestamp, operation and body', () => {
    // Fixed vector, so a change to the format cannot pass silently on both sides at once
    // printf '1760000000\ncredit\n{}' | openssl dgst -sha256 -hmac kkkk...(32)
    expect(relaySignature('k'.repeat(32), 1_760_000_000, 'credit', '{}')).toBe('v1=2b590047ea429706d9d133055b4a6051a42d5e4312afa43ebe804efb77cad9fb')
  })

  it('refuses a changed body, a different operation, a wrong secret', () => {
    const h = signRelay(SECRET, 'account', body, NOW)
    expect(check(h, { rawBody: JSON.stringify({ telegramId: 43 }) })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(check(h, { operation: 'credit' })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(check(signRelay(OLD, 'account', body, NOW))).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('refuses old and future timestamps', () => {
    expect(check(signRelay(SECRET, 'account', body, NOW - (MAX_AGE_SECONDS + 1) * 1000))).toEqual({ ok: false, reason: 'stale' })
    expect(check(signRelay(SECRET, 'account', body, NOW - (MAX_AGE_SECONDS - 5) * 1000))).toMatchObject({ ok: true })
    expect(check(signRelay(SECRET, 'account', body, NOW + 120_000))).toEqual({ ok: false, reason: 'ahead' })
  })

  it('refuses missing and malformed headers', () => {
    expect(check({})).toEqual({ ok: false, reason: 'missing' })
    expect(check({ [TIMESTAMP_HEADER]: 'yesterday', [SIGNATURE_HEADER]: 'v1=00' })).toEqual({ ok: false, reason: 'malformed' })
    const h = signRelay(SECRET, 'account', body, NOW)
    expect(check({ ...h, [SIGNATURE_HEADER]: h[SIGNATURE_HEADER]!.toUpperCase() })).toEqual({ ok: false, reason: 'malformed' })
  })

  it('accepts the previous secret during a rotation, and says which matched', () => {
    expect(check(signRelay(OLD, 'account', body, NOW), { secrets: [SECRET, OLD] })).toEqual({ ok: true, secretIndex: 1 })
    expect(check(signRelay(SECRET, 'account', body, NOW), { secrets: [SECRET, OLD] })).toEqual({ ok: true, secretIndex: 0 })
  })
})

describe('credit request', () => {
  const ok = {
    reference: 'ip_7f3a9c2e1b',
    source: 'paystack',
    telegramId: 42,
    quoteId: '7d1f0e7a-4a8b-4c55-9a1e-1f2b3c4d5e6f',
    nairaKobo: 500_000,
    rateId: '0b9e3a51-2c1d-4e6f-8a7b-9c0d1e2f3a4b',
    nairaPerRaffKobo: 1_000,
    baseRaffs: 500,
    bonusRaffs: 25,
    paidAt: '2026-10-19T12:00:00.000Z',
  }
  it('takes a well-formed credit and refuses extras or fractions', () => {
    expect(creditRequest.safeParse(ok).success).toBe(true)
    expect(creditRequest.safeParse({ ...ok, raffs: 9999 }).success).toBe(false)
    expect(creditRequest.safeParse({ ...ok, nairaKobo: 10.5 }).success).toBe(false)
    expect(creditRequest.safeParse({ ...ok, reference: 'has space' }).success).toBe(false)
  })
})
