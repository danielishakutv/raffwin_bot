/**
 * Every error code the API can return. The Mini App switches on these, so a
 * code is only ever added here, never renamed.
 */
export const API_ERROR_CODES = [
  'INSUFFICIENT_FUNDS',
  'RAFFLE_CLOSED',
  /** The entry price changed since the player saw it (an admin edited the raffle) */
  'PRICE_CHANGED',
  'RATE_EXPIRED',
  'PAYMENT_DECLINED',
  'USERNAME_TAKEN',
  'NOT_FOUND',
  'NOT_SIGNED_IN',
  'ALREADY_DRAWN',
  'NOT_READY',
  /** initData or a token failed verification, or has expired */
  'AUTH_INVALID',
  /** The access token has expired; refresh and retry */
  'AUTH_EXPIRED',
  /** Sign-up without a valid Telegram contact share */
  'PHONE_NOT_VERIFIED',
  /** That verified phone already belongs to another account */
  'PHONE_IN_USE',
  /** This Telegram account already has a Raffle Win account */
  'ALREADY_REGISTERED',
  'ACCOUNT_SUSPENDED',
  /** Signed in, but this role may not do that */
  'FORBIDDEN',
  /** The action needs a second admin's approval and was queued instead */
  'APPROVAL_REQUIRED',
  'INVALID_INPUT',
  'RATE_LIMITED',
  'SERVER_ERROR',
  /** That feature is switched off (for everyone, or for this player) */
  'FEATURE_OFF',
  /** Share your phone number through Telegram first (entering a raffle, sending Raffs) */
  'PHONE_REQUIRED',
  /** Already claimed (today's streak bonus, an offer) */
  'ALREADY_CLAIMED',
  /** A daily or per-action cap was reached */
  'LIMIT_REACHED',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/** Body of every non-2xx API response. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode
    message: string
    /** Field-level messages for INVALID_INPUT, keyed by field name */
    fields?: Record<string, string>
    /** Correlates with the server log line for this request */
    requestId?: string
  }
}

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value)
}
