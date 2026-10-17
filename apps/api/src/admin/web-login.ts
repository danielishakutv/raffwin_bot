/**
 * Browser (desktop) admin sign-in, decision of 17 Oct. The same three secrets
 * as the bot sign-in (master password, admin username, admin password), and
 * possession proved by a 6-digit code the bot sends to the Telegram account
 * bound to that admin (bound on their first bot sign-in; an unbound admin
 * cannot use the browser at all).
 *
 *   POST /auth/web/start   secrets -> challenge (code DM'd, 5 minutes)
 *   POST /auth/web/verify  challenge + code -> bearer token, channel 'browser'
 *
 * Every refusal gets one generic answer, a security event (kind admin_web_*)
 * and an audit row. Both argon2 checks always run, with a dummy hash for an
 * unknown username, so the response time does not say which secret was wrong.
 *
 * Limits:
 *  - 10 admin_web_* events per connection per hour (an IPv4 address, or an
 *    IPv6 /64, since one host usually holds a whole /64);
 *  - 5 failed sign-ins naming a username in the last hour lock it. Real and
 *    unknown usernames lock by the same rule, read from the security events
 *    (admin_users.failed_logins and locked_until are display only), so a lock
 *    reveals nothing about who exists;
 *  - 5 wrong codes burn a challenge; 5 codes per admin per hour; 10 wrong codes
 *    for one admin in an hour, across challenges, close browser sign-in for
 *    that admin for the hour.
 *
 * Each attempt runs in one transaction that first takes advisory locks on the
 * connection and on the username (always in that order), then reads the
 * counts, checks, and records the failure before committing. Concurrent
 * attempts therefore queue, and none is evaluated on counts that miss another.
 * Every write inside goes through that transaction, so a waiting attempt never
 * needs a second pool connection from the one holding the lock.
 */
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { and, eq, gt, gte, isNull, like, sql } from 'drizzle-orm'
import type { Request } from 'express'
import { webLoginStartBody, webLoginVerifyBody } from '@raffwin/shared/admin-schemas'
import type { AdminWebLoginChallenge } from '@raffwin/shared/admin-types'
import type { AppContext, RequestMeta } from '../context'
import { adminUsers, adminWebLogins, securityEvents, type AdminUserRow } from '../db/schema'
import { hashIp, sha256Hex } from '../lib/crypto'
import { HttpError } from '../lib/http-error'
import { requestMeta } from '../http/middleware'
import type { Tx } from '../services/ledger'
import { appendAudit } from './audit'
import { hashPassword, openSession, verifyPassword, type AdminLogin } from './session'

export const CODE_MINUTES = 5
const MAX_CODE_ATTEMPTS = 5
const MAX_FAILED_LOGINS = 5
const LOCK_MINUTES = 60
/** admin_web_* security events from one connection in the last hour before it is refused outright */
export const IP_EVENTS_PER_HOUR = 10
/** Codes sent to one admin in the last hour; the next start is refused */
export const CODES_PER_ADMIN_PER_HOUR = 5
/** Wrong codes for one admin in the last hour, across challenges, that close browser sign-in for the hour */
export const WRONG_CODES_PER_ADMIN_PER_HOUR = 10
/** Namespace of this file's pg_advisory_xact_lock keys (features-admin uses 727201) */
const WEB_LOCK_SPACE = 727210

const GENERIC = 'Those details are not right.'
const UNBOUND = 'Sign in once from the bot in Telegram first, so a code can reach you.'
const LOCKED = 'Too many failed sign-ins for this admin. Wait an hour and try again, or sign in from the bot.'
const IP_LIMITED = 'Too many sign-in attempts from this connection. Wait an hour and try again.'
const CODES_LIMITED = 'Too many codes were sent for this admin in the last hour. Wait an hour, or sign in from the bot.'
const CODE_LOCKED =
  'Too many wrong codes for this admin. Browser sign-in is closed for an hour; sign in from the bot, and change your password if this was not you.'
const CODE_GONE = 'That code has expired or was already used. Sign in again for a new code.'

let dummyHash: Promise<string> | null = null
/** A real argon2id hash (same cost as real ones) of a random secret, checked when the username is unknown */
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64url')).catch((error: unknown) => {
    dummyHash = null
    throw error
  })
  return dummyHash
}

function codeHash(challengeId: string, code: string): string {
  return sha256Hex(`${challengeId}:${code}`)
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

/** "@ada***" from the bound Telegram username, or a neutral phrase when there is none */
export function maskedTelegram(telegramUsername: string | null): string {
  if (!telegramUsername || !/^[a-z0-9_]{3,32}$/i.test(telegramUsername)) return 'your Telegram'
  return `@${telegramUsername.slice(0, 3)}***`
}

/**
 * Usernames that match no admin are recorded only as a salted hash: people
 * type passwords into the username field, and security events are readable
 * by every admin role.
 */
function usernameKey(ctx: AppContext, handle: string): string {
  return sha256Hex(`${ctx.config.IP_HASH_SALT}:admin-username:${handle}`).slice(0, 32)
}

/** The first four groups of an IPv6 address, normalised ("2001:db8:0:1"); null for IPv4 and IPv4-mapped */
export function ipv6Prefix64(ip: string | undefined): string | null {
  const addr = (ip ?? '').split('%')[0] ?? ''
  if (isIP(addr) !== 6 || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(addr)) return null
  const [head = '', tail] = addr.split('::')
  const h = head ? head.split(':') : []
  let groups = h
  if (tail !== undefined) {
    const t = tail ? tail.split(':') : []
    // A dotted IPv4 tail fills two groups
    const used = h.length + t.length + (addr.includes('.') ? 1 : 0)
    groups = [...h, ...Array<string>(8 - used).fill('0'), ...t]
  }
  return groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')
}

/**
 * What the per-connection limit counts by: the IP hash, or for IPv6 a hash of
 * its /64, since rotating through one host's /64 is free. Stored as
 * details.ipKey on every admin_web_* event; ip_hash keeps the exact address.
 */
function ipKeyOf(ctx: AppContext, req: Request, meta: RequestMeta): string | null {
  const prefix = ipv6Prefix64(req.ip)
  return prefix ? hashIp(`${prefix}::/64`, ctx.config.IP_HASH_SALT) : meta.ipHash
}

interface WebMeta extends RequestMeta {
  ipKey: string | null
}

/** Queues this transaction behind any other attempt holding the same name, until commit */
async function lockName(tx: Tx, name: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${WEB_LOCK_SPACE}, hashtext(${name}))`)
}

const lockConnection = (tx: Tx, meta: WebMeta) => lockName(tx, `admin-web-ip:${meta.ipKey ?? 'none'}`)
const lockUsername = (tx: Tx, key: string) => lockName(tx, `admin-web-user:${key}`)

/**
 * A security event written in the attempt's own transaction. Unlike
 * recordSecurityEvent, a failed insert fails the attempt: these rows are what
 * the limits count, so an unrecorded failure would be a free guess.
 */
async function webEvent(
  ctx: AppContext,
  tx: Tx,
  meta: WebMeta,
  kind: string,
  severity: 'medium' | 'high' | 'critical',
  details: Record<string, unknown>,
  actionTaken: 'none' | 'blocked' = 'blocked',
): Promise<void> {
  const row: typeof securityEvents.$inferInsert = {
    severity,
    category: 'admin',
    kind,
    fingerprint: `${meta.ipHash ?? 'noip'}:admin:${meta.route}`,
    ipHash: meta.ipHash,
    route: meta.route,
    requestId: meta.requestId,
    details: { ...details, ipKey: meta.ipKey },
    actionTaken,
  }
  ctx.log.warn({ securityEvent: row }, `security event: ${kind}`)
  await tx.insert(securityEvents).values(row)
}

/** Audits in its own transaction; audit trouble is logged and never hides the real outcome. */
async function auditWeb(
  ctx: AppContext,
  entry: { adminId: string | null; action: string; details: Record<string, unknown>; ipHash: string | null },
): Promise<void> {
  try {
    await ctx.db.transaction((tx) =>
      appendAudit(tx, {
        adminId: entry.adminId,
        action: entry.action,
        targetType: 'admin',
        targetId: entry.adminId ?? undefined,
        after: entry.details,
        ipHash: entry.ipHash,
      }),
    )
  } catch (error) {
    ctx.log.error({ err: error, entry }, 'could not write browser admin sign-in to the audit log')
  }
}

const hourAgo = (ctx: AppContext) => new Date(ctx.now() - LOCK_MINUTES * 60_000)

/** admin_web_* security events from this connection in the last hour (refusals and codes sent alike). */
async function recentWebEvents(ctx: AppContext, tx: Tx, ipKey: string | null): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(securityEvents)
    .where(
      and(
        gte(securityEvents.occurredAt, hourAgo(ctx)),
        like(securityEvents.kind, 'admin\\_web\\_%'),
        // Events from before ipKey was recorded count by their exact address
        ipKey ? sql`coalesce(${securityEvents.details}->>'ipKey', ${securityEvents.ipHash}) = ${ipKey}` : isNull(securityEvents.ipHash),
      ),
    )
  return row?.n ?? 0
}

/** Failed sign-ins naming this username in the last hour, the one lock rule for real and unknown names alike. */
async function recentUsernameFailures(ctx: AppContext, tx: Tx, key: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(securityEvents)
    .where(
      and(
        gte(securityEvents.occurredAt, hourAgo(ctx)),
        like(securityEvents.kind, 'admin\\_web\\_login\\_%'),
        // Attempts while locked do not count, or the lock would slide for as long as someone keeps trying;
        // unbound means every secret was right
        sql`${securityEvents.kind} not in ('admin_web_login_locked', 'admin_web_login_unbound')`,
        sql`${securityEvents.details}->>'usernameKey' = ${key}`,
      ),
    )
  return row?.n ?? 0
}

/** Codes sent to this admin in the last hour (every challenge row is one code). */
async function recentCodes(ctx: AppContext, tx: Tx, adminId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(adminWebLogins)
    .where(and(eq(adminWebLogins.adminId, adminId), gte(adminWebLogins.createdAt, hourAgo(ctx))))
  return row?.n ?? 0
}

/** Wrong codes for this admin in the last hour across all challenges, and whether they closed sign-in. */
async function recentWrongCodes(ctx: AppContext, tx: Tx, adminId: string): Promise<{ n: number; lockedOut: boolean }> {
  const [row] = await tx
    .select({
      n: sql<number>`count(*)::int`,
      lockedOut: sql<boolean>`coalesce(bool_or(${securityEvents.details}->>'lockedOut' = 'true'), false)`,
    })
    .from(securityEvents)
    .where(
      and(
        gte(securityEvents.occurredAt, hourAgo(ctx)),
        eq(securityEvents.kind, 'admin_web_code_wrong_code'),
        sql`${securityEvents.details}->>'adminId' = ${adminId}`,
      ),
    )
  return { n: row?.n ?? 0, lockedOut: row?.lockedOut ?? false }
}

type StartOutcome =
  | { kind: 'ip_limited' }
  | { kind: 'locked'; adminId: string | null }
  | { kind: 'failed'; adminId: string | null; reason: string; locked: boolean }
  | { kind: 'unbound' | 'codes_limited' | 'code_locked'; adminId: string }
  | { kind: 'challenge'; admin: AdminUserRow; challengeId: string; code: string; expiresAt: number }

/**
 * Step 1: the three secrets. On success a 6-digit code goes to the admin's
 * bound Telegram account and the browser gets a challenge id to send it with.
 */
export async function startWebLogin(ctx: AppContext, req: Request): Promise<AdminWebLoginChallenge> {
  const masterHash = ctx.config.ADMIN_MASTER_PASSWORD_HASH
  const send = ctx.sendTelegram
  if (!masterHash || !send) {
    throw new HttpError('NOT_READY', 'Browser sign-in is not set up on this server. Sign in from the bot in Telegram.')
  }
  const body = webLoginStartBody.parse(req.body)
  const base = requestMeta(ctx, req)
  const meta: WebMeta = { ...base, ipKey: ipKeyOf(ctx, req, base) }
  const handle = body.username.trim().toLowerCase()
  const key = usernameKey(ctx, handle)
  const dummy = await dummyPasswordHash()

  const outcome = await ctx.db.transaction(async (tx): Promise<StartOutcome> => {
    await lockConnection(tx, meta)
    await lockUsername(tx, key)
    if ((await recentWebEvents(ctx, tx, meta.ipKey)) >= IP_EVENTS_PER_HOUR) {
      await webEvent(ctx, tx, meta, 'admin_web_rate_limited', 'high', { step: 'start' })
      return { kind: 'ip_limited' }
    }

    const [found] = await tx.select().from(adminUsers).where(eq(adminUsers.username, handle))
    const admin: AdminUserRow | null = found ?? null
    const who = admin ? { adminId: admin.id } : {}
    const nameFailures = await recentUsernameFailures(ctx, tx, key)
    if (nameFailures >= MAX_FAILED_LOGINS) {
      await webEvent(ctx, tx, meta, 'admin_web_login_locked', 'high', { ...who, usernameKey: key })
      return { kind: 'locked', adminId: admin?.id ?? null }
    }

    // Everything below runs whatever the username: both argon2 checks
    const [masterOk, passwordOk] = await Promise.all([
      verifyPassword(masterHash, body.master),
      verifyPassword(admin?.passwordHash ?? dummy, body.password),
    ])
    const now = ctx.now()
    const reason = !masterOk
      ? 'master_password'
      : !admin
        ? 'unknown_username'
        : admin.status !== 'active'
          ? 'admin_disabled'
          : !passwordOk
            ? admin.passwordHash
              ? 'password'
              : 'no_password'
            : null
    if (reason) {
      const failedInARow = nameFailures + 1
      const lockedNow = failedInARow >= MAX_FAILED_LOGINS
      if (admin) {
        // For the admin screens only: the lock itself is the event count above
        await tx
          .update(adminUsers)
          .set({
            failedLogins: failedInARow,
            ...(lockedNow ? { lockedUntil: new Date(now + LOCK_MINUTES * 60_000) } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(adminUsers.id, admin.id))
      }
      await webEvent(ctx, tx, meta, `admin_web_login_${reason}`, lockedNow ? 'critical' : 'high', {
        ...who,
        usernameKey: key,
        failedInARow,
        locked: lockedNow,
      })
      return { kind: 'failed', adminId: admin?.id ?? null, reason, locked: lockedNow }
    }
    const a = admin as AdminUserRow

    // Every secret was right. Without a bound Telegram account there is nowhere to send the code.
    if (a.telegramId === null) {
      await webEvent(ctx, tx, meta, 'admin_web_login_unbound', 'medium', { adminId: a.id })
      return { kind: 'unbound', adminId: a.id }
    }
    if ((await recentWrongCodes(ctx, tx, a.id)).lockedOut) {
      await webEvent(ctx, tx, meta, 'admin_web_code_locked', 'high', { adminId: a.id, step: 'start' })
      return { kind: 'code_locked', adminId: a.id }
    }
    const codes = await recentCodes(ctx, tx, a.id)
    if (codes >= CODES_PER_ADMIN_PER_HOUR) {
      await webEvent(ctx, tx, meta, 'admin_web_codes_limited', 'high', { adminId: a.id, codesLastHour: codes })
      return { kind: 'codes_limited', adminId: a.id }
    }

    const challengeId = randomUUID()
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    // Only the newest code works: any earlier open challenge of this admin ends now
    await tx
      .update(adminWebLogins)
      .set({ expiresAt: new Date(now) })
      .where(and(eq(adminWebLogins.adminId, a.id), isNull(adminWebLogins.usedAt), gt(adminWebLogins.expiresAt, new Date(now))))
    await tx.insert(adminWebLogins).values({
      id: challengeId,
      adminId: a.id,
      codeHash: codeHash(challengeId, code),
      ipHash: meta.ipHash,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      expiresAt: new Date(now + CODE_MINUTES * 60_000),
    })
    await appendAudit(tx, {
      adminId: a.id,
      action: 'admin.web.challenge',
      targetType: 'admin',
      targetId: a.id,
      after: { challengeId },
      ipHash: meta.ipHash,
    })
    return { kind: 'challenge', admin: a, challengeId, code, expiresAt: now + CODE_MINUTES * 60_000 }
  })

  if (outcome.kind !== 'challenge') {
    const adminId = outcome.kind === 'ip_limited' ? null : outcome.adminId
    const reason =
      outcome.kind === 'ip_limited' ? 'ip_rate_limited' : outcome.kind === 'failed' ? outcome.reason : outcome.kind
    const details = { step: 'start', reason, ...(outcome.kind === 'failed' ? { locked: outcome.locked } : {}) }
    await auditWeb(ctx, { adminId, action: 'admin.web.failed', details, ipHash: meta.ipHash })
    switch (outcome.kind) {
      case 'ip_limited':
        throw new HttpError('RATE_LIMITED', IP_LIMITED)
      case 'locked':
        throw new HttpError('RATE_LIMITED', LOCKED)
      case 'code_locked':
        throw new HttpError('RATE_LIMITED', CODE_LOCKED)
      case 'codes_limited':
        throw new HttpError('RATE_LIMITED', CODES_LIMITED)
      case 'unbound':
        throw new HttpError('AUTH_INVALID', UNBOUND)
      default:
        throw new HttpError('AUTH_INVALID', GENERIC)
    }
  }

  const { admin: a, challengeId, code, expiresAt } = outcome
  try {
    await send(
      a.telegramId as number,
      `Browser admin sign-in code: <b>${code}</b>\nValid ${CODE_MINUTES} minutes. If this was not you, do nothing and change your password: someone knows it.`,
      { html: true },
    )
  } catch (error) {
    ctx.log.error({ err: error, adminId: a.id }, 'browser admin sign-in: the bot could not deliver the code')
    await ctx.db.update(adminWebLogins).set({ expiresAt: new Date(ctx.now()) }).where(eq(adminWebLogins.id, challengeId))
    await auditWeb(ctx, {
      adminId: a.id,
      action: 'admin.web.code_undelivered',
      details: { challengeId, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) },
      ipHash: meta.ipHash,
    })
    throw new HttpError('SERVER_ERROR', 'The bot could not message your Telegram account. Open the bot, press Start, then try again.')
  }
  // Recorded on purpose: someone holding all three secrets is worth an admin's attention,
  // and it counts toward this connection's hourly limit, which also caps codes sent from here
  await ctx.db.transaction((tx) => webEvent(ctx, tx, meta, 'admin_web_code_sent', 'medium', { adminId: a.id, challengeId }, 'none'))
  return { challengeId, expiresAt, sentTo: maskedTelegram(a.telegramUsername) }
}

type VerifyOutcome =
  | { kind: 'ok'; admin: AdminUserRow; token: string; expiresAt: number }
  | { kind: 'ip_limited' }
  | { kind: 'wrong_code'; adminId: string; attemptsLeft: number; lockedOut: boolean }
  | { kind: 'unknown' | 'used' | 'expired' | 'burned' | 'admin_unavailable' | 'code_locked'; adminId: string | null }

/** Step 2: the code from the bot. Unused, unexpired, fewer than 5 wrong tries -> a browser session. */
export async function verifyWebLogin(ctx: AppContext, req: Request): Promise<AdminLogin> {
  const body = webLoginVerifyBody.parse(req.body)
  const base = requestMeta(ctx, req)
  const meta: WebMeta = { ...base, ipKey: ipKeyOf(ctx, req, base) }
  const now = ctx.now()

  const result = await ctx.db.transaction(async (tx): Promise<VerifyOutcome> => {
    await lockConnection(tx, meta)
    if ((await recentWebEvents(ctx, tx, meta.ipKey)) >= IP_EVENTS_PER_HOUR) {
      await webEvent(ctx, tx, meta, 'admin_web_rate_limited', 'high', { step: 'verify' })
      return { kind: 'ip_limited' }
    }
    const outcome = await checkCode(ctx, tx, meta, body.challengeId, body.code, now)
    if (outcome.kind === 'ok') return outcome
    const details = {
      challengeId: body.challengeId,
      adminId: outcome.adminId,
      ...(outcome.kind === 'wrong_code' ? { attemptsLeft: outcome.attemptsLeft, lockedOut: outcome.lockedOut } : {}),
    }
    const critical = outcome.kind === 'wrong_code' && outcome.lockedOut
    await webEvent(ctx, tx, meta, `admin_web_code_${outcome.kind}`, critical ? 'critical' : 'high', details)
    return outcome
  })

  if (result.kind === 'ok') return { admin: result.admin, token: result.token, expiresAt: result.expiresAt }
  if (result.kind === 'ip_limited') {
    await auditWeb(ctx, { adminId: null, action: 'admin.web.failed', details: { step: 'verify', reason: 'ip_rate_limited' }, ipHash: meta.ipHash })
    throw new HttpError('RATE_LIMITED', IP_LIMITED)
  }

  const details = { challengeId: body.challengeId, ...(result.kind === 'wrong_code' ? { attemptsLeft: result.attemptsLeft, lockedOut: result.lockedOut } : {}) }
  await auditWeb(ctx, { adminId: result.adminId, action: 'admin.web.failed', details: { step: 'verify', reason: result.kind, ...details }, ipHash: meta.ipHash })
  if (result.kind === 'code_locked') throw new HttpError('RATE_LIMITED', CODE_LOCKED)
  if (result.kind === 'wrong_code') {
    if (result.lockedOut) throw new HttpError('RATE_LIMITED', CODE_LOCKED)
    throw new HttpError(
      'AUTH_INVALID',
      result.attemptsLeft > 0 ? 'That code is not right.' : 'That code is not right, and that was the last try. Sign in again for a new code.',
    )
  }
  throw new HttpError('AUTH_INVALID', CODE_GONE)
}

/** The challenge checks, inside verify's transaction once the connection lock is held. */
async function checkCode(
  ctx: AppContext,
  tx: Tx,
  meta: WebMeta,
  challengeId: string,
  code: string,
  now: number,
): Promise<Exclude<VerifyOutcome, { kind: 'ip_limited' }>> {
  // The admin's username lock too, so starts and verifies for one admin count each other's codes
  const [owner] = await tx
    .select({ adminId: adminWebLogins.adminId, username: adminUsers.username })
    .from(adminWebLogins)
    .leftJoin(adminUsers, eq(adminUsers.id, adminWebLogins.adminId))
    .where(eq(adminWebLogins.id, challengeId))
  if (!owner) return { kind: 'unknown', adminId: null }
  await lockUsername(tx, owner.username ? usernameKey(ctx, owner.username) : `admin:${owner.adminId}`)

  const [c] = await tx.select().from(adminWebLogins).where(eq(adminWebLogins.id, challengeId)).for('update')
  if (!c) return { kind: 'unknown', adminId: null }
  const wrong = await recentWrongCodes(ctx, tx, c.adminId)
  if (wrong.lockedOut) return { kind: 'code_locked', adminId: c.adminId }
  if (c.usedAt) return { kind: 'used', adminId: c.adminId }
  if (c.expiresAt.getTime() <= now) return { kind: 'expired', adminId: c.adminId }
  if (c.attempts >= MAX_CODE_ATTEMPTS) return { kind: 'burned', adminId: c.adminId }
  if (!sameHex(c.codeHash, codeHash(c.id, code))) {
    const attempts = c.attempts + 1
    await tx.update(adminWebLogins).set({ attempts }).where(eq(adminWebLogins.id, c.id))
    const lockedOut = wrong.n + 1 >= WRONG_CODES_PER_ADMIN_PER_HOUR
    if (lockedOut) {
      // No code of this admin works while browser sign-in is closed
      await tx
        .update(adminWebLogins)
        .set({ expiresAt: new Date(now) })
        .where(and(eq(adminWebLogins.adminId, c.adminId), isNull(adminWebLogins.usedAt), gt(adminWebLogins.expiresAt, new Date(now))))
    }
    return { kind: 'wrong_code', adminId: c.adminId, attemptsLeft: MAX_CODE_ATTEMPTS - attempts, lockedOut }
  }
  const [admin] = await tx.select().from(adminUsers).where(eq(adminUsers.id, c.adminId)).for('update')
  if (!admin || admin.status !== 'active' || admin.telegramId === null) return { kind: 'admin_unavailable', adminId: c.adminId }
  await tx.update(adminWebLogins).set({ usedAt: new Date(now) }).where(eq(adminWebLogins.id, c.id))
  await tx.update(adminUsers).set({ lastLoginAt: new Date(now), failedLogins: 0, updatedAt: sql`now()` }).where(eq(adminUsers.id, admin.id))
  const session = await openSession(ctx, tx, {
    admin,
    channel: 'browser',
    ipHash: meta.ipHash,
    userAgent: meta.userAgent,
    auditAfter: { channel: 'browser', challengeId: c.id },
  })
  return { kind: 'ok', admin, ...session }
}
