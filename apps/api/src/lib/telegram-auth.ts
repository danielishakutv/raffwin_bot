/**
 * Verification of data signed by Telegram for a Mini App: the launch initData
 * and the response of WebApp.requestContact. Both are query strings signed
 * the same way (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *
 *   data_check_string = every field except `hash`, as key=value, sorted by key, joined by \n
 *   secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   valid             = hex(HMAC_SHA256(key = secret_key, message = data_check_string)) == hash
 *
 * Failures return a reason code instead of throwing, so the caller can record
 * exactly what was wrong as a security event.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export type SignedDataFailure = 'malformed' | 'missing_hash' | 'bad_hash' | 'missing_auth_date' | 'expired' | 'future'

export type SignedDataResult =
  | { ok: true; fields: Map<string, string>; authDate: number }
  | { ok: false; reason: SignedDataFailure }

const secretCache = new Map<string, Buffer>()

function secretKey(botToken: string): Buffer {
  let key = secretCache.get(botToken)
  if (!key) {
    key = createHmac('sha256', 'WebAppData').update(botToken).digest()
    secretCache.set(botToken, key)
  }
  return key
}

export function signTelegramData(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.keys(fields)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n')
  return createHmac('sha256', secretKey(botToken)).update(dataCheckString).digest('hex')
}

export function verifyTelegramData(
  raw: string,
  botToken: string,
  options: { maxAgeSeconds: number; now?: number },
): SignedDataResult {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(raw)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const fields = new Map<string, string>()
  for (const [key, value] of params) {
    if (fields.has(key)) return { ok: false, reason: 'malformed' }
    fields.set(key, value)
  }
  const hash = fields.get('hash')
  if (!hash) return { ok: false, reason: 'missing_hash' }
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'bad_hash' }

  const expected = Buffer.from(signTelegramData(Object.fromEntries(fields), botToken), 'hex')
  const given = Buffer.from(hash, 'hex')
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_hash' }

  const authDate = Number(fields.get('auth_date'))
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: 'missing_auth_date' }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  // A minute of clock skew either way is tolerated
  if (authDate > nowSeconds + 60) return { ok: false, reason: 'future' }
  if (nowSeconds - authDate > options.maxAgeSeconds) return { ok: false, reason: 'expired' }

  return { ok: true, fields, authDate }
}

/** The `user` object inside initData (https://core.telegram.org/bots/webapps#webappuser). */
export interface InitDataUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
  is_premium?: boolean
  /** True when the player has allowed the bot to message them */
  allows_write_to_pm?: boolean
}

export function readInitDataUser(fields: Map<string, string>): InitDataUser | null {
  const raw = fields.get('user')
  if (!raw) return null
  try {
    const user = JSON.parse(raw) as InitDataUser
    return Number.isSafeInteger(user.id) && user.id > 0 ? user : null
  } catch {
    return null
  }
}

/** The `contact` object inside a requestContact response. */
export interface SharedContact {
  user_id: number
  phone_number: string
  first_name?: string
  last_name?: string
}

export function readSharedContact(fields: Map<string, string>): SharedContact | null {
  const raw = fields.get('contact')
  if (!raw) return null
  try {
    const contact = JSON.parse(raw) as SharedContact
    if (!Number.isSafeInteger(contact.user_id) || typeof contact.phone_number !== 'string') return null
    return contact
  } catch {
    return null
  }
}
