/**
 * Mini App authentication (docs/ARCHITECTURE.md section 5).
 *
 * initData -> verified -> user found or created by telegram_id -> a session
 * with a 30-day rotating refresh token and a 15-minute access token.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { parseStartParam, USERNAME_RE } from '@raffwin/shared'
import type { AppContext, RequestMeta } from '../context'
import { uniqueViolation } from '../db/client'
import { initDataUses, referralHints, sessions, users, type UserRow } from '../db/schema'
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
  const user = await upsertTelegramUser(ctx, tgUser, start?.kind === 'referral' ? start.code : null, meta)

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

/** Telegram's username when it fits ours (3-20 of a-z 0-9 _), else null. */
function usernameFromTelegram(tg: InitDataUser): string | null {
  const u = tg.username?.toLowerCase() ?? ''
  return USERNAME_RE.test(u) ? u : null
}

function generatedUsername(): string {
  return `player_${newReferralCode().toLowerCase().slice(0, 6)}`
}

function displayName(tg: InitDataUser): string {
  return [tg.first_name, tg.last_name].filter(Boolean).join(' ').trim().slice(0, 120) || 'Raffle Win player'
}

/**
 * Finds or creates the player. There is no sign-up form: opening the bot is
 * the account (decision of 16 Oct). A new account gets its Telegram username
 * (or player_xxxxxx if that is missing, invalid or taken), its Telegram name,
 * and the referrer from the link it was first opened with. The referral bond
 * is set once, at creation, and never changes.
 */
async function upsertTelegramUser(
  ctx: AppContext,
  tg: InitDataUser,
  referralCode: string | null,
  meta: RequestMeta,
): Promise<UserRow> {
  const now = new Date(ctx.now())
  const telegramFields = {
    tgUsername: tg.username ?? null,
    tgFirstName: tg.first_name ?? null,
    tgLastName: tg.last_name ?? null,
    tgLanguageCode: tg.language_code ?? null,
    tgIsPremium: tg.is_premium === true,
    lastSeenAt: now,
  }

  const [existing] = await ctx.db.select().from(users).where(eq(users.telegramId, tg.id))
  if (existing) return refreshExisting(ctx, existing, tg, telegramFields)

  // The code on the opening link wins; otherwise one the bot saw in /start ref_<code> before this first open
  const code0 = referralCode ?? (await referralHint(ctx, tg.id))
  const referrerId = code0 ? await referrerFor(ctx, code0, meta) : null
  let username = usernameFromTelegram(tg) ?? generatedUsername()
  let code = newReferralCode()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const [row] = await ctx.db
        .insert(users)
        .values({
          telegramId: tg.id,
          ...telegramFields,
          username,
          fullName: displayName(tg),
          referralCode: code,
          referredByUserId: referrerId,
          referredAt: referrerId ? now : null,
          signedUpAt: now,
        })
        .returning()
      if (row) return row
    } catch (error) {
      const constraint = uniqueViolation(error)
      if (constraint === 'users_username_key') username = generatedUsername()
      else if (constraint === 'users_referral_code_key') code = newReferralCode()
      else if (constraint === 'users_telegram_id_key') {
        // Two first opens raced; the other one created the row
        const [row] = await ctx.db.select().from(users).where(eq(users.telegramId, tg.id))
        if (row) return row
      } else throw error
    }
  }
  throw new Error(`could not create an account for telegram ${tg.id} after 8 attempts`)
}

/** Keeps Telegram details current; fills the profile of accounts made before sign-up was removed. */
async function refreshExisting(
  ctx: AppContext,
  user: UserRow,
  tg: InitDataUser,
  telegramFields: Partial<typeof users.$inferInsert>,
): Promise<UserRow> {
  const backfill = user.signedUpAt
    ? {}
    : { signedUpAt: new Date(ctx.now()), fullName: user.fullName ?? displayName(tg), username: user.username ?? usernameFromTelegram(tg) ?? generatedUsername() }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const [row] = await ctx.db
        .update(users)
        .set({ ...telegramFields, ...backfill, updatedAt: sql`now()` })
        .where(eq(users.id, user.id))
        .returning()
      if (row) return row
    } catch (error) {
      if (uniqueViolation(error) === 'users_username_key' && 'username' in backfill) {
        backfill.username = generatedUsername()
        continue
      }
      throw error
    }
  }
  throw new Error(`could not update account ${user.id}`)
}

async function referralHint(ctx: AppContext, telegramId: number): Promise<string | null> {
  const [hint] = await ctx.db.select({ code: referralHints.code }).from(referralHints).where(eq(referralHints.telegramId, telegramId))
  return hint?.code ?? null
}

/** A referral code counts only if it belongs to an active account; otherwise it is recorded and ignored. */
async function referrerFor(ctx: AppContext, code: string, meta: RequestMeta): Promise<string | null> {
  const [referrer] = await ctx.db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.referralCode, code))
  if (referrer && referrer.status === 'active') return referrer.id
  await recordSecurityEvent(ctx.db, ctx.log, {
    severity: 'low',
    category: 'fraud',
    kind: referrer ? 'referral_inactive_referrer' : 'referral_unknown_code',
    ipHash: meta.ipHash,
    route: meta.route,
    requestId: meta.requestId,
    details: { code },
  })
  return null
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
