/**
 * Admin secrets: AES-256-GCM for data at rest (TOTP secrets) and RFC 6238
 * TOTP for the authenticator-app code. Both use node:crypto only.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/* AES-256-GCM ---------------------------------------------------------------- */

export function parseDataKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64url')
  if (key.length !== 32) throw new Error('ADMIN_DATA_KEY must be 32 bytes, base64url-encoded (43 characters)')
  return key
}

/** "v1.<iv>.<tag>.<ciphertext>", all base64url */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
}

export function decrypt(sealed: string, key: Buffer): string {
  const [version, iv, tag, data] = sealed.split('.')
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('unrecognised ciphertext format')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}

/* Base32 (RFC 4648), as authenticator apps expect ---------------------------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx === -1) throw new Error('invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/* TOTP (RFC 6238: SHA-1, 30 s steps, 6 digits) -------------------------------- */

const STEP_SECONDS = 30

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS)
}

export function totpCode(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest()
  const offset = (mac[mac.length - 1] as number) & 0x0f
  const binary = mac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 1_000_000).padStart(6, '0')
}

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matched step so the caller can refuse its reuse, or null.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const now = totpStep(nowMs)
  for (const step of [now - 1, now, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue
    const expected = Buffer.from(totpCode(secretBase32, step))
    if (timingSafeEqual(expected, Buffer.from(code))) return step
  }
  return null
}

export function otpauthUri(secretBase32: string, account: string, issuer = 'Raffle Win Admin'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
