import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { ZodError } from 'zod'
import type { AppContext, RequestMeta } from '../context'
import type { BuyerRow } from '../db/schema'
import { hashIp, HttpError } from '../lib/util'
import { buyerForToken, SESSION_COOKIE } from '../services/auth'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own extension point
  namespace Express {
    interface Request {
      session?: { buyer: BuyerRow; sessionId: string }
    }
  }
}

/** The visitor's address: Cloudflare's header when configured, else what Express trusts */
export function clientIp(ctx: AppContext, req: Request): string | undefined {
  const header = ctx.config.CLIENT_IP_HEADER
  return (header ? req.get(header)?.trim() : undefined) || req.ip
}

export function requestMeta(ctx: AppContext, req: Request): RequestMeta {
  return { ipHash: hashIp(clientIp(ctx, req), ctx.config.IP_HASH_SALT), route: `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}` }
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}
export const clearedSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`

export function requireBuyer(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const s = await buyerForToken(ctx, cookie(req, SESSION_COOKIE))
    if (!s) throw new HttpError(401, 'NOT_SIGNED_IN', 'Log in with Telegram to continue.')
    req.session = s
    next()
  }
}

export function buyerOf(req: Request): BuyerRow {
  if (!req.session) throw new Error('buyerOf() on a route without requireBuyer')
  return req.session.buyer
}

/**
 * Writes come from our own pages only: JSON (a cross-site form cannot send it
 * without a preflight, which this API never answers) and, when the browser
 * says where it came from, our own origin.
 */
export function sameSiteWrites(ctx: AppContext): RequestHandler {
  const origin = new URL(ctx.config.PUBLIC_URL).origin
  return (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next()
    if (!req.is('application/json')) throw new HttpError(415, 'INVALID_INPUT', 'Send JSON.')
    const from = req.get('origin')
    if (from && from !== origin) throw new HttpError(403, 'FORBIDDEN', 'Not allowed from another site.')
    next()
  }
}

export function errorHandler(ctx: AppContext) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } })
      return
    }
    if (error instanceof ZodError) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: error.issues[0]?.message ?? 'Check what you entered.' } })
      return
    }
    const status = (error as { status?: number; type?: string }).status
    if (status === 413 || (error as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'That request could not be read.' } })
      return
    }
    ctx.log.error({ err: error, route: `${req.method} ${req.path}` }, 'unhandled error')
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Try again in a minute.' } })
  }
}
