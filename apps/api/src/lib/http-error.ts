import type { ApiErrorCode } from '@raffwin/shared'

const STATUS: Record<ApiErrorCode, number> = {
  INSUFFICIENT_FUNDS: 409,
  RAFFLE_CLOSED: 409,
  PRICE_CHANGED: 409,
  RATE_EXPIRED: 409,
  PAYMENT_DECLINED: 402,
  USERNAME_TAKEN: 409,
  NOT_FOUND: 404,
  NOT_SIGNED_IN: 403,
  ALREADY_DRAWN: 409,
  NOT_READY: 409,
  AUTH_INVALID: 401,
  AUTH_EXPIRED: 401,
  PHONE_NOT_VERIFIED: 422,
  PHONE_IN_USE: 409,
  ALREADY_REGISTERED: 409,
  ACCOUNT_SUSPENDED: 403,
  FORBIDDEN: 403,
  APPROVAL_REQUIRED: 202,
  INVALID_INPUT: 400,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  FEATURE_OFF: 403,
  PHONE_REQUIRED: 422,
  ALREADY_CLAIMED: 409,
  LIMIT_REACHED: 409,
}

/** An error the client is meant to see: code, user-facing message, HTTP status. */
export class HttpError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly fields?: Record<string, string>

  constructor(code: ApiErrorCode, message: string, fields?: Record<string, string>) {
    super(message)
    this.name = 'HttpError'
    this.code = code
    this.status = STATUS[code]
    this.fields = fields
  }
}
