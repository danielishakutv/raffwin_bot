/**
 * Admin sign-in and sessions (docs/ARCHITECTURE.md section 9).
 *
 * Layers, outermost first:
 *   1. Cloudflare Access (email one-time code) in front of admin.rafflewin.com.ng;
 *      the API verifies the Access JWT and that its email is this admin's.
 *   2. Email + argon2id password + TOTP code, checked together, one generic error.
 *      5 failures lock the account for 15 minutes.
 *   3. An opaque session cookie: HttpOnly, SameSite=Strict, Path=/admin, 8 h
 *      absolute and 30 min idle, revocable. Writes need the X-Raffwin-Admin
 *      header, which a cross-site form cannot send.
 */
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import type { AppContext } from '../context'
import { adminSessions, adminUsers, type AdminUserRow } from '../db/schema'
import { newRefreshToken, sha256Hex } from '../lib/crypto'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'
import { requestMeta } from '../http/middleware'
import { decrypt, parseDataKey, verifyTotp } from '../lib/admin-crypto'
import { appendAudit } from './audit'
import { can, type Permission } from './permissions'

export const ADMIN_COOKIE = 'rw_admin'
export const CSRF_HEADER = 'x-raffwin-admin'
const MAX_FAILED = 5
const LOCK_MINUTES = 15

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own extension point
  namespace Express {
    interface Request {
      admin?: { user: AdminUserRow; sessionId: string }
    }
  }
}

export function adminOf(req: Request): { user: AdminUserRow; sessionId: string } {
  if (!req.admin) throw new Error('adminOf() used on a route without requireAdmin')
  return req.admin
}

export const adminLoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
})

export function hashPassword(password: string): Promise<string> {
  return argonHash(password)
}

// Verifying against this when the email is unknown keeps response times alike
let dummyHash: Promise<string> | null = null

function readCookie(req: Request, name: string): string | null {
  const header = req.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

function cookieOptions(ctx: AppContext) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: ctx.config.NODE_ENV !== 'development' && ctx.config.NODE_ENV !== 'test',
    path: '/admin',
  }
}

/* Cloudflare Access ---------------------------------------------------------- */

const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

/** Returns the Access-verified email, null when Access is not configured (development/test only). */
async function accessEmail(ctx: AppContext, req: Request): Promise<string | null> {
  const team = ctx.config.CF_ACCESS_TEAM_DOMAIN
  const aud = ctx.config.CF_ACCESS_AUD
  if (!team || !aud) return null
  const token = req.get('cf-access-jwt-assertion')
  if (!token) throw new HttpError('AUTH_INVALID', 'Open the admin through admin.rafflewin.com.ng.')
  let jwks = jwksByTeam.get(team)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`))
    jwksByTeam.set(team, jwks)
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: aud })
    if (typeof payload.email !== 'string') throw new Error('no email claim')
    return payload.email.toLowerCase()
  } catch (error) {
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: 'high',
      category: 'admin',
      kind: 'admin_access_jwt_invalid',
      ...pick(requestMeta(ctx, req)),
      details: { reason: error instanceof Error ? error.message : String(error) },
      actionTaken: 'blocked',
    })
    throw new HttpError('AUTH_INVALID', 'Your Cloudflare Access sign-in is not valid. Reload the page.')
  }
}

function pick(m: ReturnType<typeof requestMeta>) {
  return { ipHash: m.ipHash, route: m.route, requestId: m.requestId }
}

/* Login / logout ------------------------------------------------------------- */

const LOGIN_FAILED = 'Email, password or code is wrong.'

export async function login(ctx: AppContext, req: Request, res: Response): Promise<AdminUserRow> {
  const body = adminLoginBody.parse(req.body)
  const meta = requestMeta(ctx, req)
  const viaAccess = await accessEmail(ctx, req)
  const [admin] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.email, body.email))
  const now = ctx.now()

  const fail = async (kind: string, adminId: string | null, locked = false) => {
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: locked ? 'high' : 'medium',
      category: 'admin',
      kind,
      ...pick(meta),
      details: { email: body.email, adminId },
      actionTaken: locked ? 'blocked' : 'none',
    })
    throw new HttpError('AUTH_INVALID', LOGIN_FAILED)
  }

  if (!admin || admin.status !== 'active') {
    dummyHash ??= argonHash('not-a-real-password')
    await argonVerify(await dummyHash, body.password).catch(() => false)
    return fail(admin ? 'admin_login_disabled' : 'admin_login_unknown_email', admin?.id ?? null)
  }
  if (viaAccess !== null && viaAccess !== admin.email) {
    return fail('admin_login_access_email_mismatch', admin.id)
  }
  if (admin.lockedUntil && admin.lockedUntil.getTime() > now) {
    const minutes = Math.ceil((admin.lockedUntil.getTime() - now) / 60_000)
    throw new HttpError('RATE_LIMITED', `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`)
  }

  const passwordOk = await argonVerify(admin.passwordHash, body.password).catch(() => false)
  const secret = decrypt(admin.totpSecretEnc, parseDataKey(ctx.config.ADMIN_DATA_KEY))
  const step = passwordOk ? verifyTotp(secret, body.code, now, admin.totpLastStep) : null
  if (!passwordOk || step === null) {
    const failed = admin.failedLogins + 1
    const lock = failed >= MAX_FAILED
    await ctx.db
      .update(adminUsers)
      .set({
        failedLogins: lock ? 0 : failed,
        lockedUntil: lock ? new Date(now + LOCK_MINUTES * 60_000) : admin.lockedUntil,
        updatedAt: sql`now()`,
      })
      .where(eq(adminUsers.id, admin.id))
    return fail(passwordOk ? 'admin_login_bad_code' : 'admin_login_bad_password', admin.id, lock)
  }

  const token = newRefreshToken()
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(adminUsers)
      .set({ failedLogins: 0, lockedUntil: null, totpLastStep: step, lastLoginAt: new Date(now), updatedAt: sql`now()` })
      .where(eq(adminUsers.id, admin.id))
    await tx.insert(adminSessions).values({
      adminId: admin.id,
      tokenHash: sha256Hex(token),
      ipHash: meta.ipHash,
      userAgent: req.get('user-agent')?.slice(0, 400) ?? null,
      expiresAt: new Date(now + ctx.config.ADMIN_SESSION_HOURS * 3_600_000),
    })
    await appendAudit(tx, { adminId: admin.id, action: 'admin.login', targetType: 'admin', targetId: admin.id, ipHash: meta.ipHash })
  })
  res.cookie(ADMIN_COOKIE, token, { ...cookieOptions(ctx), maxAge: ctx.config.ADMIN_SESSION_HOURS * 3_600_000 })
  return admin
}

export async function logout(ctx: AppContext, req: Request, res: Response): Promise<void> {
  const { user, sessionId } = adminOf(req)
  await ctx.db.transaction(async (tx) => {
    await tx.update(adminSessions).set({ revokedAt: sql`now()` }).where(eq(adminSessions.id, sessionId))
    await appendAudit(tx, { adminId: user.id, action: 'admin.logout', targetType: 'admin', targetId: user.id })
  })
  res.clearCookie(ADMIN_COOKIE, cookieOptions(ctx))
}

/* Middleware ----------------------------------------------------------------- */

/** Cookie session + Access identity + CSRF header on writes. */
export function requireAdmin(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get(CSRF_HEADER) !== '1') {
      await recordSecurityEvent(ctx.db, ctx.log, {
        severity: 'high',
        category: 'admin',
        kind: 'admin_csrf_header_missing',
        ...pick(requestMeta(ctx, req)),
        actionTaken: 'blocked',
      })
      throw new HttpError('AUTH_INVALID', 'Request refused: missing admin header.')
    }
    const viaAccess = await accessEmail(ctx, req)
    const token = readCookie(req, ADMIN_COOKIE)
    if (!token) throw new HttpError('AUTH_INVALID', 'Sign in to the admin.')
    const now = ctx.now()
    const [row] = await ctx.db
      .select({ session: adminSessions, admin: adminUsers })
      .from(adminSessions)
      .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.adminId))
      .where(
        and(
          eq(adminSessions.tokenHash, sha256Hex(token)),
          isNull(adminSessions.revokedAt),
          gt(adminSessions.expiresAt, new Date(now)),
          gt(adminSessions.lastSeenAt, new Date(now - ctx.config.ADMIN_IDLE_MINUTES * 60_000)),
        ),
      )
    if (!row || row.admin.status !== 'active') throw new HttpError('AUTH_INVALID', 'Your admin session has ended. Sign in again.')
    if (viaAccess !== null && viaAccess !== row.admin.email) {
      await recordSecurityEvent(ctx.db, ctx.log, {
        severity: 'critical',
        category: 'admin',
        kind: 'admin_session_access_email_mismatch',
        ...pick(requestMeta(ctx, req)),
        details: { adminId: row.admin.id },
        actionTaken: 'blocked',
      })
      throw new HttpError('AUTH_INVALID', 'This session belongs to a different admin.')
    }
    // Idle timeout: touch at most once a minute
    if (now - row.session.lastSeenAt.getTime() > 60_000) {
      await ctx.db.update(adminSessions).set({ lastSeenAt: new Date(now) }).where(eq(adminSessions.id, row.session.id))
    }
    req.admin = { user: row.admin, sessionId: row.session.id }
    next()
  }
}

export function requirePermission(ctx: AppContext, permission: Permission): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const { user } = adminOf(req)
    if (!can(user.role, permission)) {
      await recordSecurityEvent(ctx.db, ctx.log, {
        severity: 'medium',
        category: 'admin',
        kind: 'admin_forbidden',
        ...pick(requestMeta(ctx, req)),
        details: { adminId: user.id, role: user.role, permission },
        actionTaken: 'blocked',
      })
      throw new HttpError('FORBIDDEN', `Your role (${user.role}) cannot do this.`)
    }
    next()
  }
}
