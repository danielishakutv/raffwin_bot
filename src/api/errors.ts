export type ApiErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'RAFFLE_CLOSED'
  | 'RATE_EXPIRED'
  | 'PAYMENT_DECLINED'
  | 'USERNAME_TAKEN'
  | 'NOT_FOUND'
  | 'NOT_SIGNED_IN'
  | 'ALREADY_DRAWN'
  | 'NOT_READY'

export class ApiError extends Error {
  code: ApiErrorCode
  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

export function isApiError(error: unknown, code?: ApiErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code)
}

export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}
