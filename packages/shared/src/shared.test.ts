import { describe, expect, it } from 'vitest'
import { isReferralCode, parseStartParam, referralEarning, REFERRAL_CODE_ALPHABET } from './referral'
import { normalizeNigerianPhone } from './phone'
import { profilePatchBody, signUpBody } from './schemas'

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
  it('normalises sign-up fields the same way the form does', () => {
    const parsed = signUpBody.parse({
      fullName: '  Ada Obi ',
      username: ' Ada_Obi ',
      email: ' ADA@Example.com ',
      contactProof: 'x',
    })
    expect(parsed).toEqual({ fullName: 'Ada Obi', username: 'ada_obi', email: 'ada@example.com', contactProof: 'x' })
  })
  it('returns the form messages for bad input', () => {
    const result = signUpBody.safeParse({ fullName: 'Ada', username: 'a!', email: 'nope', contactProof: 'x' })
    expect(result.success).toBe(false)
    const messages = result.error?.issues.map((i) => i.message) ?? []
    expect(messages).toContain('Add your surname too, e.g. Ada Obi')
    expect(messages).toContain('That email does not look right')
  })
  it('refuses an empty profile patch', () => {
    expect(profilePatchBody.safeParse({}).success).toBe(false)
  })
})
