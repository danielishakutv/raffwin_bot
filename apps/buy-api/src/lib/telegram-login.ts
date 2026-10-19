/**
 * Telegram Login Widget verification (https://core.telegram.org/widgets/login#checking-authorization):
 *
 *   data_check_string = every field received except `hash`, as key=value, sorted by key, joined by \n
 *   secret_key        = SHA256(bot_token)                  (raw bytes)
 *   valid             = hex(HMAC_SHA256(secret_key, data_check_string)) == hash
 *
 * Not the Mini App's scheme: initData uses HMAC_SHA256("WebAppData", bot_token)
 * as its key, so a Mini App signature never passes here and the other way round.
 * A login whose auth_date is older than maxAgeSeconds (24 h) is refused, and
 * so is one dated more than a minute ahead. Failures return a reason code for
 * the security log instead of throwing.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export type LoginFailure = 'malformed' | 'missing_hash' | 'bad_hash' | 'missing_auth_date' | 'expired' | 'future'

export interface TelegramLogin {
  id: number
  firstName: string | null
  lastName: string | null
  username: string | null
  photoUrl: string | null
  authDate: number
}

export type LoginResult = { ok: true; user: TelegramLogin } | { ok: false; reason: LoginFailure }

export function loginDataCheckString(fields: Record<string, string>): string {
  return Object.keys(fields)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n')
}

export function signTelegramLogin(fields: Record<string, string>, botToken: string): string {
  const secret = createHash('sha256').update(botToken).digest()
  return createHmac('sha256', secret).update(loginDataCheckString(fields)).digest('hex')
}

export function verifyTelegramLogin(input: unknown, botToken: string, options: { maxAgeSeconds: number; now?: number }): LoginResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'malformed' }
  // Every value is used as Telegram sent it: strings and numbers only, never anything nested
  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    if (!/^[a-z_]{1,32}$/.test(k)) return { ok: false, reason: 'malformed' }
    if (typeof v === 'string') fields[k] = v
    else if (typeof v === 'number' && Number.isFinite(v)) fields[k] = String(v)
    else return { ok: false, reason: 'malformed' }
  }
  const hash = fields.hash
  if (!hash) return { ok: false, reason: 'missing_hash' }
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'bad_hash' }

  const expected = Buffer.from(signTelegramLogin(fields, botToken), 'hex')
  const given = Buffer.from(hash, 'hex')
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_hash' }

  const authDate = Number(fields.auth_date)
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: 'missing_auth_date' }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  if (authDate > nowSeconds + 60) return { ok: false, reason: 'future' }
  if (nowSeconds - authDate > options.maxAgeSeconds) return { ok: false, reason: 'expired' }

  const id = Number(fields.id)
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: 'malformed' }
  return {
    ok: true,
    user: {
      id,
      firstName: fields.first_name ?? null,
      lastName: fields.last_name ?? null,
      username: fields.username ?? null,
      photoUrl: fields.photo_url?.startsWith('https://') ? fields.photo_url : null,
      authDate,
    },
  }
}
