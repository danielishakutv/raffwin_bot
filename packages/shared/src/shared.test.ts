import { describe, expect, it } from 'vitest'
import { prizeLabel, winnersLabel } from './prizes'
import { isReferralCode, parseStartParam, referralEarning, REFERRAL_CODE_ALPHABET } from './referral'
import { normalizeNigerianPhone } from './phone'
import { kycBody, profilePatchBody } from './schemas'
import { hourlyQuote, hourStart, RATE_TTL_MS } from './rate'

describe('hourlyQuote', () => {
  it('moves 3% to 15% from the base, in either direction', () => {
    expect(hourlyQuote(0.5, 0, 0.9)).toEqual({ value: 0.515, move: 0.03 })
    expect(hourlyQuote(0.5, 0, 0.1)).toEqual({ value: 0.485, move: -0.03 })
    expect(hourlyQuote(0.5, 0.999999, 0.9).value).toBeCloseTo(0.575, 5)
    expect(hourlyQuote(0.5, 0.999999, 0.1).value).toBeCloseTo(0.425, 5)
  })
  it('never leaves 85%-115% of the base, whatever the randomness', () => {
    for (let i = 0; i < 2000; i += 1) {
      const { value, move } = hourlyQuote(2, Math.random(), Math.random())
      expect(Math.abs(move)).toBeGreaterThanOrEqual(0.03)
      expect(Math.abs(move)).toBeLessThanOrEqual(0.15)
      expect(value).toBeGreaterThanOrEqual(1.7)
      expect(value).toBeLessThanOrEqual(2.3)
    }
  })
  it('refuses a non-positive base', () => {
    expect(() => hourlyQuote(0, 0.5, 0.5)).toThrow()
  })
})

describe('hourlyQuote with an admin range', () => {
  it('stays inside the range it is given; 0..0 is a fixed price', () => {
    for (let i = 0; i < 500; i += 1) {
      const { move } = hourlyQuote(1000, Math.random(), Math.random(), { min: 0.05, max: 0.08 })
      expect(Math.abs(move)).toBeGreaterThanOrEqual(0.05)
      expect(Math.abs(move)).toBeLessThanOrEqual(0.08)
    }
    expect(hourlyQuote(1000, 0.7, 0.9, { min: 0, max: 0 }).value).toBe(1000)
    expect(() => hourlyQuote(1000, 0.5, 0.5, { min: 0.1, max: 0.05 })).toThrow()
  })
})

describe('hourStart', () => {
  it('aligns to the clock hour', () => {
    const t = Date.UTC(2026, 9, 16, 13, 42, 7)
    expect(hourStart(t)).toBe(Date.UTC(2026, 9, 16, 13))
    expect(hourStart(t) + RATE_TTL_MS).toBe(Date.UTC(2026, 9, 16, 14))
  })
})

describe('referralEarning', () => {
  it('pays 10% floored to a whole Raff', () => {
    expect(referralEarning(1000)).toBe(100)
    expect(referralEarning(99)).toBe(9)
    expect(referralEarning(9)).toBe(0)
  })
  it('never pays on zero, negative or non-numeric spend', () => {
    expect(referralEarning(0)).toBe(0)
    expect(referralEarning(-50)).toBe(0)
    expect(referralEarning(Number.NaN)).toBe(0)
  })
})

describe('parseStartParam', () => {
  it('reads referral codes case-insensitively', () => {
    expect(parseStartParam('ref_ab3dk9mz')).toEqual({ kind: 'referral', code: 'AB3DK9MZ' })
  })
  it('reads raffle links', () => {
    expect(parseStartParam('raffle_rf-123')).toEqual({ kind: 'raffle', raffleId: 'rf-123' })
  })
  it('rejects malformed or unknown values without throwing', () => {
    for (const bad of [undefined, null, '', 'ref_', 'ref_SHORT', 'ref_0OIL0OIL', 'hello', 'ref_AB3DK9MZ!', 'x'.repeat(65)]) {
      expect(parseStartParam(bad)).toBeNull()
    }
  })
})

describe('referral code alphabet', () => {
  it('excludes look-alike characters', () => {
    for (const c of '01OIL') expect(REFERRAL_CODE_ALPHABET).not.toContain(c)
    expect(isReferralCode('23456789')).toBe(true)
  })
})

describe('normalizeNigerianPhone', () => {
  it('accepts the common ways people write a number', () => {
    for (const raw of ['08031234567', '8031234567', '+2348031234567', '234 803 123 4567', '0803-123-4567']) {
      expect(normalizeNigerianPhone(raw)).toBe('+2348031234567')
    }
  })
  it('rejects non-mobile or wrong-length numbers', () => {
    expect(normalizeNigerianPhone('0123456789')).toBeNull()
    expect(normalizeNigerianPhone('+447700900123')).toBeNull()
  })
})

describe('schemas', () => {
  it('normalises KYC fields and needs a motor park, never a street', () => {
    const parsed = kycBody.parse({ fullName: '  Ada Obi ', state: 'Lagos', city: ' Ikeja ', motorPark: ' Ojota Motor Park ' })
    expect(parsed).toEqual({ fullName: 'Ada Obi', state: 'Lagos', city: 'Ikeja', motorPark: 'Ojota Motor Park' })
    const bad = kycBody.safeParse({ fullName: 'Ada', state: '', city: '', motorPark: '' })
    const messages = bad.error?.issues.map((i) => i.message) ?? []
    expect(messages).toContain('Add your surname too, e.g. Ada Obi')
    expect(messages).toContain('Enter the motor park nearest to you')
    expect(kycBody.safeParse({ fullName: 'Ada Obi', state: 'Lagos', city: 'Ikeja', motorPark: 'Ojota', street: '1 Allen' }).data).not.toHaveProperty('street')
  })
  it('refuses an empty profile patch', () => {
    expect(profilePatchBody.safeParse({}).success).toBe(false)
  })
})

describe('prize places', () => {
  it('names a single prize "Prize" and places after that in order', () => {
    expect(prizeLabel(1, 1)).toBe('Prize')
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((n) => prizeLabel(n, 200))).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th'])
    expect(winnersLabel(1)).toBe('1 winner')
    expect(winnersLabel(4)).toBe('4 winners')
  })
})
