import type { ApiErrorCode } from '@raffwin/shared'

export type { ApiErrorCode }

export class ApiError extends Error {
  code: ApiErrorCode
  /** Field-level messages from the API for INVALID_INPUT */
  fields?: Record<string, string>
  /** Server request id, for matching a report to the log line */
  requestId?: string
  constructor(code: ApiErrorCode, message: string, extra?: { fields?: Record<string, string>; requestId?: string }) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.fields = extra?.fields
    this.requestId = extra?.requestId
  }
}

export function isApiError(error: unknown, code?: ApiErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code)
}

export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}
