/**
 * Mini App authentication (docs/ARCHITECTURE.md section 5).
 *
 * initData -> verified -> user found or created by telegram_id -> a session
 * with a 30-day rotating refresh token and a 15-minute access token.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { parseStartParam } from '@raffwin/shared'
import type { AppContext, RequestMeta } from '../context'
import { uniqueViolation } from '../db/client'
import { initDataUses, sessions, users, type UserRow } from '../db/schema'
import { newReferralCode, newRefreshToken, sha256Hex } from '../lib/crypto'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'
import { readInitDataUser, verifyTelegramData, type InitDataUser } from '../lib/telegram-auth'

export interface SessionTokens {
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken: string
  refreshTokenExpiresAt: number
}

const REOPEN = 'Close Raffle Win and open it again from the bot.'

export async function loginWithInitData(ctx: AppContext, initData: string, meta: RequestMeta): Promise<SessionTokens> {
  const now = ctx.now()
  const verified = verifyTelegramData(initData, ctx.config.BOT_TOKEN, {
    maxAgeSeconds: ctx.config.INITDATA_MAX_AGE_SECONDS,
    now,
  })
  if (!verified.ok) {
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: verified.reason === 'bad_hash' ? 'high' : 'medium',
      category: 'initdata',
      kind: `initdata_${verified.reason}`,
      ipHash: meta.ipHash,
      route: meta.route,
      requestId: meta.requestId,
    })
    if (verified.reason === 'expired') {
      throw new HttpError('AUTH_EXPIRED', `This Raffle Win session is too old. ${REOPEN}`)
    }
    throw new HttpError('AUTH_INVALID', `Telegram could not confirm this session. ${REOPEN}`)
  }

  const tgUser = readInitDataUser(verified.fields)
  if (!tgUser) {
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: 'medium',
      category: 'initdata',
      kind: 'initdata_no_user',
      ipHash: meta.ipHash,
      route: meta.route,
      requestId: meta.requestId,
    })
    throw new HttpError('AUTH_INVALID', `Telegram did not send your account details. ${REOPEN}`)
  }

  await checkReplay(ctx, initData, tgUser.id, verified.authDate, meta)

  const start = parseStartParam(verified.fields.get('start_param'))
  const user = await upsertTelegramUser(ctx, tgUser, start?.kind === 'referral' ? start.code : null)

  if (user.status !== 'active') {
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: 'medium',
      category: 'auth',
      kind: 'login_while_suspended',
      ipHash: meta.ipHash,
      route: meta.route,
      userId: user.id,
      requestId: meta.requestId,
      details: { status: user.status },
      actionTaken: 'blocked',
    })
    throw new HttpError('ACCOUNT_SUSPENDED', 'This account is suspended. Send /paysupport to the bot for help.')
  }

  return createSession(ctx, user.id, crypto.randomUUID(), meta)
}

/**
 * Records each initData string. Reuse inside the age window is legitimate
 * (a reload inside Telegram resends the same string) unless
 * INITDATA_SINGLE_USE is on; either way it is visible as a security event.
 */
async function checkReplay(ctx: AppContext, initData: string, telegramId: number, authDate: number, meta: RequestMeta) {
  const expiresAt = new Date((authDate + ctx.config.INITDATA_MAX_AGE_SECONDS) * 1000)
  const [row] = await ctx.db
    .insert(initDataUses)
    .values({ hash: sha256Hex(initData), telegramId, expiresAt })
    .onConflictDoUpdate({
      target: initDataUses.hash,
      set: { useCount: sql`${initDataUses.useCount} + 1`, lastUsedAt: sql`now()` },
    })
    .returning({ useCount: initDataUses.useCount })

  if (row && row.useCount > 1) {
    const single = ctx.config.INITDATA_SINGLE_USE
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: single ? 'medium' : 'low',
      category: 'initdata',
      kind: 'initdata_reuse',
      ipHash: meta.ipHash,
      route: meta.route,
      requestId: meta.requestId,
      details: { useCount: row.useCount, telegramId },
      actionTaken: single ? 'blocked' : 'none',
    })
    if (single) throw new HttpError('AUTH_INVALID', `This session was already used. ${REOPEN}`)
  }
}

/**
 * Finds or creates the user. The referral code from the first open(s) is kept
 * until sign-up (first touch wins) and never changes after it.
 */
async function upsertTelegramUser(
  ctx: AppContext,
  tg: InitDataUser,
  referralCode: string | null,
): Promise<UserRow> {
  const telegramFields = {
    tgUsername: tg.username ?? null,
    tgFirstName: tg.first_name ?? null,
    tgLastName: tg.last_name ?? null,
    tgLanguageCode: tg.language_code ?? null,
    tgIsPremium: tg.is_premium === true,
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const [row] = await ctx.db
        .insert(users)
        .values({
          telegramId: tg.id,
          ...telegramFields,
          referralCode: newReferralCode(),
          pendingReferralCode: referralCode,
          lastSeenAt: new Date(ctx.now()),
        })
        .onConflictDoUpdate({
          target: users.telegramId,
          set: {
            ...telegramFields,
            lastSeenAt: new Date(ctx.now()),
            updatedAt: sql`now()`,
            pendingReferralCode: sql`case when ${users.signedUpAt} is null
              then coalesce(${users.pendingReferralCode}, excluded.pending_referral_code)
              else ${users.pendingReferralCode} end`,
          },
        })
        .returning()
      if (row) return row
    } catch (error) {
      // A fresh referral code collided with an existing one: draw another
      if (uniqueViolation(error) === 'users_referral_code_key') continue
      throw error
    }
  }
  throw new Error('could not allocate a unique referral code in 5 attempts')
}

async function createSession(ctx: AppContext, userId: string, familyId: string, meta: RequestMeta): Promise<SessionTokens> {
  const now = ctx.now()
  const refreshToken = newRefreshToken()
  const refreshTokenExpiresAt = now + ctx.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      userId,
      familyId,
      refreshTokenHash: sha256Hex(refreshToken),
      ipHash: meta.ipHash,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      expiresAt: new Date(refreshTokenExpiresAt),
    })
    .returning({ id: sessions.id })
  if (!session) throw new Error('session insert returned no row')
  const access = await ctx.tokens.issue({ userId, sessionId: session.id }, now)
  return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt, refreshToken, refreshTokenExpiresAt }
}

/**
 * Exchanges a refresh token for a new pair. The presented token is retired;
 * presenting a retired token again means a copy exists, so every session in
 * its family is revoked (the legitimate holder signs in again with initData).
 */
export async function refreshSession(ctx: AppContext, refreshToken: string, meta: RequestMeta): Promise<SessionTokens> {
  const hash = sha256Hex(refreshToken)
  const outcome = await ctx.db.transaction(async (tx) => {
    const [session] = await tx.select().from(sessions).where(eq(sessions.refreshTokenHash, hash)).for('update')
    if (!session) return { kind: 'unknown' as const }
    if (session.replacedBySessionId) {
      await tx
        .update(sessions)
        .set({ revokedAt: sql`now()`, revokedReason: 'reuse_detected' })
        .where(and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)))
      return { kind: 'reused' as const, session }
    }
    if (session.revokedAt) return { kind: 'revoked' as const, session }
    if (session.expiresAt.getTime() <= ctx.now()) return { kind: 'expired' as const, session }

    const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, session.userId))
    if (!user || user.status !== 'active') return { kind: 'suspended' as const, session }

    const next = newRefreshToken()
    const nextExpiresAt = ctx.now() + ctx.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000
    const [created] = await tx
      .insert(sessions)
      .values({
        userId: session.userId,
        familyId: session.familyId,
        refreshTokenHash: sha256Hex(next),
        ipHash: meta.ipHash,
        userAgent: meta.userAgent?.slice(0, 400) ?? null,
        expiresAt: new Date(nextExpiresAt),
      })
      .returning({ id: sessions.id })
    if (!created) throw new Error('session insert returned no row')
    await tx
      .update(sessions)
      .set({ replacedBySessionId: created.id, revokedAt: sql`now()`, revokedReason: 'rotated', lastUsedAt: sql`now()` })
      .where(eq(sessions.id, session.id))
    return { kind: 'rotated' as const, userId: session.userId, sessionId: created.id, refreshToken: next, refreshTokenExpiresAt: nextExpiresAt }
  })

  if (outcome.kind === 'rotated') {
    const access = await ctx.tokens.issue({ userId: outcome.userId, sessionId: outcome.sessionId }, ctx.now())
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: outcome.refreshToken,
      refreshTokenExpiresAt: outcome.refreshTokenExpiresAt,
    }
  }

  const userId = 'session' in outcome && outcome.session ? outcome.session.userId : null
  const severity = outcome.kind === 'reused' ? 'high' : 'low'
  await recordSecurityEvent(ctx.db, ctx.log, {
    severity,
    category: 'auth',
    kind: `refresh_${outcome.kind}`,
    ipHash: meta.ipHash,
    route: meta.route,
    userId,
    requestId: meta.requestId,
    actionTaken: outcome.kind === 'reused' ? 'blocked' : 'none',
  })
  if (outcome.kind === 'expired') throw new HttpError('AUTH_EXPIRED', `Your sign-in has expired. ${REOPEN}`)
  if (outcome.kind === 'suspended') {
    throw new HttpError('ACCOUNT_SUSPENDED', 'This account is suspended. Send /paysupport to the bot for help.')
  }
  throw new HttpError('AUTH_INVALID', `Your sign-in is no longer valid. ${REOPEN}`)
}

/** Ends this device's session and every token rotated from it. */
export async function logout(ctx: AppContext, sessionId: string): Promise<void> {
  const [session] = await ctx.db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, sessionId))
  if (!session) return
  await ctx.db
    .update(sessions)
    .set({ revokedAt: sql`now()`, revokedReason: 'logout' })
    .where(and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)))
}
