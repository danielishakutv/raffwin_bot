import { createHash, randomBytes, randomInt } from 'node:crypto'
import { REFERRAL_CODE_ALPHABET, REFERRAL_CODE_LENGTH } from '@raffwin/shared'

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** IPs are never stored raw: a salted hash still groups repeats from one source. */
export function hashIp(ip: string | undefined, salt: string): string | null {
  if (!ip) return null
  return sha256Hex(`${salt}:${ip}`).slice(0, 32)
}

/** Opaque refresh token: 32 random bytes, base64url (43 characters). */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function newReferralCode(): string {
  let code = ''
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    code += REFERRAL_CODE_ALPHABET[randomInt(REFERRAL_CODE_ALPHABET.length)]
  }
  return code
}
