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
 * absolute, 30 min idle, revocable, held in memory only. Every login attempt
 * and every admin request is written to the hash-chained audit log.
 */
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { z } from 'zod'
import type { AppContext } from '../context'
import { adminSessions, adminTickets, adminUsers, type AdminUserRow } from '../db/schema'
import { newRefreshToken, sha256Hex } from '../lib/crypto'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'
import { readInitDataUser, verifyTelegramData } from '../lib/telegram-auth'
import { requestMeta } from '../http/middleware'
import { appendAudit } from './audit'
import { can, type Permission } from './permissions'

export const TICKET_MINUTES = 5

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
})

export interface AdminLogin {
  admin: AdminUserRow
  token: string
  expiresAt: number
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
    const token = newRefreshToken()
    const expiresAt = now + ctx.config.ADMIN_SESSION_HOURS * 3_600_000
    await tx.insert(adminSessions).values({
      adminId: admin.id,
      tokenHash: sha256Hex(token),
      ipHash: meta.ipHash,
      userAgent: req.get('user-agent')?.slice(0, 400) ?? null,
      expiresAt: new Date(expiresAt),
    })
    await appendAudit(tx, {
      adminId: admin.id,
      action: 'admin.session.start',
      targetType: 'admin',
      targetId: admin.id,
      after: { telegramId: tg.id },
      ipHash: meta.ipHash,
    })
    return { kind: 'ok' as const, admin, token, expiresAt }
  })

  if (result.kind !== 'ok') {
    return refuse(`admin_ticket_${result.kind}`, 'ticketTelegramId' in result ? { ticketTelegramId: result.ticketTelegramId } : {})
  }
  return { admin: result.admin, token: result.token, expiresAt: result.expiresAt }
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
          gt(adminSessions.lastSeenAt, new Date(now - ctx.config.ADMIN_IDLE_MINUTES * 60_000)),
        ),
      )
    if (!row || row.admin.status !== 'active') {
      throw new HttpError('AUTH_INVALID', 'Your admin session has ended. Unlock it from the bot again.')
    }
    if (now - row.session.lastSeenAt.getTime() > 60_000) {
      await ctx.db.update(adminSessions).set({ lastSeenAt: new Date(now) }).where(eq(adminSessions.id, row.session.id))
    }
    req.admin = { user: row.admin, sessionId: row.session.id }
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
