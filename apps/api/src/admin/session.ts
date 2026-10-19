/**
 * Admin sign-in (decisions of 16 Oct). There is no admin website: admins sign
 * in through the bot, and every session needs two factors:
 *
 *   possession: the Telegram account bound to that admin. It is bound on the
 *               admin's first successful login, and only when that account's
 *               username matches the telegram_username a super admin
 *               registered. From then on the admin username works only from
 *               that one Telegram account.
 *   knowledge:  a hidden bot command, then the master password, the admin
 *               username and the admin password (bot/admin-login.ts). The bot
 *               deletes each of those messages as soon as it reads them.
 *
 * A successful login hands out a one-time ticket (5 minutes) on an "Open
 * admin" button. The admin screen exchanges it, together with the Mini App's
 * signed initData for the same Telegram account, for a bearer token: 8 h
 * absolute, 30 min idle (2 h for super admins), revocable. Super admins may
 * keep it in Telegram's secure storage on their phone; reopening the Mini App
 * resumes it only with fresh initData from the bound account (resumeSession). Every login attempt
 * and every admin request is written to the hash-chained audit log.
 *
 * Since 17 Oct there is also a browser (desktop) sign-in with the same
 * secrets, where the possession factor is a 6-digit code the bot sends to the
 * bound Telegram account (admin/web-login.ts). Its sessions are the same
 * bearer tokens with channel 'browser', the same limits, and no resume.
 *
 * Since 19 Oct all of the above is for a device's first sign-in only: a
 * successful full sign-in can register the device as trusted, and a trusted
 * device signs in with far less (admin/devices.ts). An account two admins have
 * marked at risk (admin/risk.ts) loses its devices and the super admin's longer
 * idle limit until it is cleared.
 */
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { z } from 'zod'
import type { AppContext } from '../context'
import { adminSessions, adminTickets, adminUsers, type AdminUserRow } from '../db/schema'

type AdminSessionRow = typeof adminSessions.$inferSelect
import { newRefreshToken, sha256Hex } from '../lib/crypto'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'
import { readInitDataUser, verifyTelegramData } from '../lib/telegram-auth'
import { requestMeta } from '../http/middleware'
import type { Tx } from '../services/ledger'
import { appendAudit } from './audit'
import { registerDevice } from './devices'
import { can, type Permission } from './permissions'

export const TICKET_MINUTES = 5

/** Minutes without a request before a session ends: longer for super admins, unless marked at risk */
export function idleMinutesFor(ctx: AppContext, admin: Pick<AdminUserRow, 'role' | 'riskFlaggedAt'>): number {
  return admin.role === 'super_admin' && !admin.riskFlaggedAt ? ctx.config.ADMIN_SUPER_IDLE_MINUTES : ctx.config.ADMIN_IDLE_MINUTES
}

/** How a session signed in: the bot's Open admin button, or the browser sign-in (admin/web-login.ts) */
export type AdminChannel = AdminSessionRow['channel']

export interface AdminCaller {
  user: AdminUserRow
  sessionId: string
  channel: AdminChannel
  /** The trusted device this session came from, if any */
  deviceId: string | null
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own extension point
  namespace Express {
    interface Request {
      admin?: AdminCaller
    }
  }
}

export function adminOf(req: Request): AdminCaller {
  if (!req.admin) throw new Error('adminOf() used on a route without requireAdmin')
  return req.admin
}

export function hashPassword(password: string): Promise<string> {
  return argonHash(password)
}

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash) return false
  return argonVerify(hash, password).catch(() => false)
}

/** Audits a login event in its own transaction; never lets audit trouble hide the real outcome. */
export async function auditLogin(
  ctx: AppContext,
  entry: { adminId: string | null; action: string; telegramId: number; details?: Record<string, unknown>; ipHash?: string | null },
): Promise<void> {
  try {
    await ctx.db.transaction((tx) =>
      appendAudit(tx, {
        adminId: entry.adminId,
        action: entry.action,
        targetType: 'telegram',
        targetId: String(entry.telegramId),
        after: entry.details ?? null,
        ipHash: entry.ipHash ?? null,
      }),
    )
  } catch (error) {
    ctx.log.error({ err: error, entry }, 'could not write admin login to the audit log')
  }
}

/** Issues the one-time ticket the bot puts on its "Open admin" button. */
export async function issueTicket(ctx: AppContext, adminId: string, telegramId: number): Promise<string> {
  const ticket = newRefreshToken()
  await ctx.db.insert(adminTickets).values({
    adminId,
    telegramId,
    tokenHash: sha256Hex(ticket),
    expiresAt: new Date(ctx.now() + TICKET_MINUTES * 60_000),
  })
  return ticket
}

export const ticketBody = z.object({
  ticket: z.string().min(20).max(100),
  initData: z.string().min(1).max(8192),
  /** Trust this device from now on (admin/devices.ts) */
  rememberDevice: z.boolean().optional().default(false),
  /** Telegram's platform name (ios, android, tdesktop...), for the device list */
  platform: z.string().max(30).optional(),
})

export interface AdminLogin {
  admin: AdminUserRow
  token: string
  expiresAt: number
  /** Set when this sign-in registered the device: the device keeps it */
  deviceToken?: string | null
}

/**
 * Ticket + initData -> admin session. The ticket must be unused and fresh, and
 * the initData must be signed by our bot for the same Telegram account the
 * ticket was issued to, so a ticket copied out of the chat is useless elsewhere.
 */
export async function exchangeTicket(ctx: AppContext, req: Request): Promise<AdminLogin> {
  const body = ticketBody.parse(req.body)
  const meta = requestMeta(ctx, req)
  const now = ctx.now()
  const verified = verifyTelegramData(body.initData, ctx.config.BOT_TOKEN, {
    maxAgeSeconds: ctx.config.INITDATA_MAX_AGE_SECONDS,
    now,
  })
  const tg = verified.ok ? readInitDataUser(verified.fields) : null

  const refuse = async (kind: string, details: Record<string, unknown> = {}): Promise<never> => {
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: 'high',
      category: 'admin',
      kind,
      ipHash: meta.ipHash,
      route: meta.route,
      requestId: meta.requestId,
      details: { telegramId: tg?.id ?? null, ...details },
      actionTaken: 'blocked',
    })
    await auditLogin(ctx, { adminId: null, action: 'admin.login.ticket_refused', telegramId: tg?.id ?? 0, details: { kind }, ipHash: meta.ipHash })
    throw new HttpError('AUTH_INVALID', 'This admin link has expired or was already used. Send the admin command to the bot again.')
  }

  if (!tg) return refuse(verified.ok ? 'admin_ticket_no_user' : `admin_ticket_initdata_${verified.reason}`)

  const result = await ctx.db.transaction(async (tx) => {
    const [t] = await tx.select().from(adminTickets).where(eq(adminTickets.tokenHash, sha256Hex(body.ticket))).for('update')
    if (!t) return { kind: 'unknown' as const }
    if (t.usedAt) return { kind: 'reused' as const }
    if (t.expiresAt.getTime() <= now) return { kind: 'expired' as const }
    if (t.telegramId !== tg.id) return { kind: 'other_account' as const, ticketTelegramId: t.telegramId }
    const [admin] = await tx.select().from(adminUsers).where(eq(adminUsers.id, t.adminId))
    if (!admin || admin.status !== 'active' || admin.telegramId !== tg.id) return { kind: 'admin_unavailable' as const }
    await tx.update(adminTickets).set({ usedAt: new Date(now) }).where(eq(adminTickets.id, t.id))
    const device = body.rememberDevice
      ? await registerDevice(ctx, tx, { admin, channel: 'telegram', userAgent: meta.userAgent, ipHash: meta.ipHash, platform: body.platform })
      : null
    const { token, expiresAt } = await openSession(ctx, tx, {
      admin,
      channel: 'telegram',
      deviceId: device?.deviceId ?? null,
      ipHash: meta.ipHash,
      userAgent: req.get('user-agent') ?? null,
      auditAfter: { telegramId: tg.id, deviceTrusted: !!device },
    })
    return { kind: 'ok' as const, admin, token, expiresAt, deviceToken: device?.token ?? null }
  })

  if (result.kind !== 'ok') {
    return refuse(`admin_ticket_${result.kind}`, 'ticketTelegramId' in result ? { ticketTelegramId: result.ticketTelegramId } : {})
  }
  return { admin: result.admin, token: result.token, expiresAt: result.expiresAt, deviceToken: result.deviceToken }
}

/**
 * Creates a session row (bearer token: 8 h absolute, idle limit by role, the
 * same for both channels) and audits admin.session.start, inside the caller's
 * transaction so the session exists only if the sign-in that earned it commits.
 */
export async function openSession(
  ctx: AppContext,
  tx: Tx,
  input: {
    admin: AdminUserRow
    channel: AdminChannel
    deviceId?: string | null
    ipHash: string | null
    userAgent: string | null
    auditAfter: Record<string, unknown>
  },
): Promise<{ token: string; expiresAt: number }> {
  const token = newRefreshToken()
  const expiresAt = ctx.now() + ctx.config.ADMIN_SESSION_HOURS * 3_600_000
  await tx.insert(adminSessions).values({
    adminId: input.admin.id,
    tokenHash: sha256Hex(token),
    ipHash: input.ipHash,
    userAgent: input.userAgent?.slice(0, 400) ?? null,
    expiresAt: new Date(expiresAt),
    channel: input.channel,
    deviceId: input.deviceId ?? null,
  })
  await appendAudit(tx, {
    adminId: input.admin.id,
    action: 'admin.session.start',
    targetType: 'admin',
    targetId: input.admin.id,
    after: input.auditAfter,
    ipHash: input.ipHash,
  })
  return { token, expiresAt }
}

export const resumeBody = z.object({ initData: z.string().min(1).max(8192) })

/**
 * Reopening the Mini App with a stored session token: it carries on only when
 * fresh initData proves the same bound Telegram account is holding it. A token
 * presented from any other account is revoked on the spot.
 */
export async function resumeSession(ctx: AppContext, req: Request): Promise<{ expiresAt: number }> {
  const { user, sessionId, channel } = adminOf(req)
  const body = resumeBody.parse(req.body)
  const meta = requestMeta(ctx, req)
  // Resuming is the Mini App's way back in; a browser session simply carries on (or signs in again)
  if (channel !== 'telegram') {
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: 'medium',
      category: 'admin',
      kind: 'admin_resume_browser_session',
      ipHash: meta.ipHash,
      route: meta.route,
      requestId: meta.requestId,
      details: { adminId: user.id },
      actionTaken: 'blocked',
    })
    throw new HttpError('INVALID_INPUT', 'Only a session opened from the bot can be resumed in Telegram. Sign in again in the browser.')
  }
  const verified = verifyTelegramData(body.initData, ctx.config.BOT_TOKEN, { maxAgeSeconds: ctx.config.INITDATA_MAX_AGE_SECONDS, now: ctx.now() })
  const tg = verified.ok ? readInitDataUser(verified.fields) : null
  if (!tg || tg.id !== user.telegramId) {
    await ctx.db.transaction(async (tx) => {
      await tx.update(adminSessions).set({ revokedAt: sql`now()` }).where(eq(adminSessions.id, sessionId))
      await appendAudit(tx, { adminId: user.id, action: 'admin.session.resume_refused', targetType: 'admin', targetId: user.id, after: { telegramId: tg?.id ?? null }, ipHash: meta.ipHash })
    })
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: 'high',
      category: 'admin',
      kind: verified.ok ? 'admin_resume_other_account' : `admin_resume_initdata_${verified.reason}`,
      ipHash: meta.ipHash,
      route: meta.route,
      requestId: meta.requestId,
      details: { adminId: user.id, telegramId: tg?.id ?? null },
      actionTaken: 'blocked',
    })
    throw new HttpError('AUTH_INVALID', 'This admin session cannot be resumed here. Sign in from the bot again.')
  }
  const [s] = await ctx.db.select({ expiresAt: adminSessions.expiresAt }).from(adminSessions).where(eq(adminSessions.id, sessionId))
  await auditLogin(ctx, { adminId: user.id, action: 'admin.session.resume', telegramId: tg.id, ipHash: meta.ipHash })
  return { expiresAt: s?.expiresAt.getTime() ?? ctx.now() }
}

export async function logout(ctx: AppContext, req: Request): Promise<void> {
  const { user, sessionId } = adminOf(req)
  await ctx.db.transaction(async (tx) => {
    await tx.update(adminSessions).set({ revokedAt: sql`now()` }).where(eq(adminSessions.id, sessionId))
    await appendAudit(tx, { adminId: user.id, action: 'admin.session.end', targetType: 'admin', targetId: user.id })
  })
}

/* Middleware ----------------------------------------------------------------- */

export function requireAdmin(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token) throw new HttpError('AUTH_INVALID', 'Unlock the admin from the bot first.')
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
        ),
      )
    const idle = row ? now - row.session.lastSeenAt.getTime() > idleMinutesFor(ctx, row.admin) * 60_000 : false
    if (!row || row.admin.status !== 'active' || idle) {
      throw new HttpError('AUTH_INVALID', 'Your admin session has ended. Unlock it from the bot again.')
    }
    if (now - row.session.lastSeenAt.getTime() > 60_000) {
      await ctx.db.update(adminSessions).set({ lastSeenAt: new Date(now) }).where(eq(adminSessions.id, row.session.id))
    }
    req.admin = { user: row.admin, sessionId: row.session.id, channel: row.session.channel, deviceId: row.session.deviceId }
    next()
  }
}

/**
 * Full audit trail: every admin request, reads included, is appended to the
 * audit log once the response is sent (method, route, status, query keys).
 * Writes additionally log their own before/after record.
 */
export function auditEveryRequest(ctx: AppContext): RequestHandler {
  return (req, res, next) => {
    res.on('finish', () => {
      const admin = req.admin?.user
      const route = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`
      void ctx.db
        .transaction((tx) =>
          appendAudit(tx, {
            adminId: admin?.id ?? null,
            action: 'admin.request',
            targetType: 'route',
            targetId: route,
            after: { status: res.statusCode, params: req.params, queryKeys: Object.keys(req.query) },
            ipHash: requestMeta(ctx, req).ipHash,
          }),
        )
        .catch((error: unknown) => ctx.log.error({ err: error, route }, 'could not audit admin request'))
    })
    next()
  }
}

export function requirePermission(ctx: AppContext, permission: Permission): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const { user } = adminOf(req)
    if (!can(user.role, permission)) {
      const meta = requestMeta(ctx, req)
      await recordSecurityEvent(ctx.db, ctx.log, {
        severity: 'medium',
        category: 'admin',
        kind: 'admin_forbidden',
        ipHash: meta.ipHash,
        route: meta.route,
        requestId: meta.requestId,
        details: { adminId: user.id, role: user.role, permission },
        actionTaken: 'blocked',
      })
      throw new HttpError('FORBIDDEN', `Your role (${user.role}) cannot do this.`)
    }
    next()
  }
}
