import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { ZodError } from 'zod'
import type { ApiErrorBody } from '@raffwin/shared'
import type { AppContext, RequestMeta } from '../context'
import { sessions, users, type UserRow } from '../db/schema'
import { hashIp } from '../lib/crypto'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own extension point
  namespace Express {
    interface Request {
      /** Set by requireAuth */
      auth?: { user: UserRow; sessionId: string }
    }
  }
}

/** The caller on a route behind requireAuth. */
export function authOf(req: Request): { user: UserRow; sessionId: string } {
  if (!req.auth) throw new Error('authOf() used on a route without requireAuth')
  return req.auth
}

export function requestMeta(ctx: AppContext, req: Request): RequestMeta {
  return {
    ipHash: hashIp(req.ip, ctx.config.IP_HASH_SALT),
    userAgent: req.get('user-agent') ?? null,
    requestId: String(req.id ?? ''),
    route: `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`,
  }
}

/** Bearer access token -> live session -> active user, or a typed 401/403. */
export function requireAuth(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token) throw new HttpError('AUTH_INVALID', 'Sign in again.')

    const result = await ctx.tokens.verify(token)
    if (!result.ok) {
      if (result.reason === 'expired') throw new HttpError('AUTH_EXPIRED', 'Your session expired. Refreshing.')
      await recordSecurityEvent(ctx.db, ctx.log, {
        severity: 'medium',
        category: 'auth',
        kind: 'access_token_invalid',
        ...pickMeta(requestMeta(ctx, req)),
      })
      throw new HttpError('AUTH_INVALID', 'Sign in again.')
    }

    // The session check makes logout and reuse-revocation take effect immediately
    const [row] = await ctx.db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, result.claims.sessionId),
          eq(sessions.userId, result.claims.userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date(ctx.now())),
        ),
      )
    if (!row) throw new HttpError('AUTH_INVALID', 'Your sign-in is no longer valid. Close Raffle Win and open it again.')
    if (row.user.status !== 'active') {
      throw new HttpError('ACCOUNT_SUSPENDED', 'This account is suspended. Send /paysupport to the bot for help.')
    }
    req.auth = { user: row.user, sessionId: result.claims.sessionId }
    next()
  }
}

function pickMeta(meta: RequestMeta) {
  return { ipHash: meta.ipHash, route: meta.route, requestId: meta.requestId }
}

export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new HttpError('NOT_FOUND', 'No such endpoint.'))
}

/** One error format for every failure; unexpected errors are logged with the request id. */
export function errorHandler(ctx: AppContext) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = String(req.id ?? '')
    let status = 500
    let body: ApiErrorBody = {
      error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.', requestId },
    }

    if (error instanceof HttpError) {
      status = error.status
      body = { error: { code: error.code, message: error.message, fields: error.fields, requestId } }
    } else if (error instanceof ZodError) {
      status = 400
      const fields: Record<string, string> = {}
      for (const issue of error.issues) {
        const key = issue.path.join('.') || 'body'
        fields[key] ??= issue.message
      }
      body = { error: { code: 'INVALID_INPUT', message: 'Check the highlighted fields.', fields, requestId } }
    } else if (isBodyParserError(error)) {
      status = error.status
      body = {
        error: {
          code: 'INVALID_INPUT',
          message: error.type === 'entity.too.large' ? 'That request is too large.' : 'The request body is not valid JSON.',
          requestId,
        },
      }
    } else {
      ctx.log.error({ err: error, requestId, route: `${req.method} ${req.originalUrl}` }, 'unhandled error')
    }
    res.status(status).json(body)
  }
}

function isBodyParserError(error: unknown): error is { status: number; type: string } {
  const e = error as { status?: unknown; type?: unknown }
  return typeof e?.status === 'number' && typeof e?.type === 'string' && e.type.startsWith('entity.')
}
