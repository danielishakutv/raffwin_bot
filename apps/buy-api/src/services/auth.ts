/**
 * Signing in with the Telegram Login Widget. The Telegram user id is the
 * permanent key: it is the same id the game knows, so a purchase here lands
 * in that player's balance. A session is a random token in an httpOnly
 * cookie; only its SHA-256 is stored.
 */
import { and, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext, RequestMeta } from '../context'
import { buyers, sessions, type BuyerRow } from '../db/schema'
import { verifyTelegramLogin } from '../lib/telegram-login'
import { HttpError, normalizePhone, randomToken, sha256Hex } from '../lib/util'
import { recordSecurity } from './security'

export const SESSION_COOKIE = '__Host-ip_session'

export async function signIn(ctx: AppContext, body: unknown, meta: RequestMeta): Promise<{ token: string; buyer: BuyerRow; expiresAt: Date }> {
  const result = verifyTelegramLogin(body, ctx.config.LOGIN_BOT_TOKEN, { maxAgeSeconds: ctx.config.LOGIN_MAX_AGE_SECONDS, now: ctx.now() })
  if (!result.ok) {
    await recordSecurity(ctx, { kind: `login_${result.reason}`, severity: result.reason === 'bad_hash' ? 'high' : 'medium', ipHash: meta.ipHash })
    throw new HttpError(401, 'LOGIN_FAILED', result.reason === 'expired' ? 'That Telegram login is too old. Log in again.' : 'Telegram could not confirm this login. Try again.')
  }
  const u = result.user
  const at = new Date(ctx.now())
  const [buyer] = await ctx.db
    .insert(buyers)
    .values({ telegramId: u.id, username: u.username, firstName: u.firstName, lastName: u.lastName, photoUrl: u.photoUrl, lastLoginAt: at })
    .onConflictDoUpdate({
      target: buyers.telegramId,
      set: { username: u.username, firstName: u.firstName, lastName: u.lastName, photoUrl: u.photoUrl, lastLoginAt: at },
    })
    .returning()
  if (!buyer) throw new Error('buyer upsert returned no row')

  const token = randomToken()
  const expiresAt = new Date(at.getTime() + ctx.config.SESSION_DAYS * 86_400_000)
  await ctx.db.insert(sessions).values({ buyerId: buyer.id, tokenHash: sha256Hex(token), ipHash: meta.ipHash, expiresAt })
  ctx.log.info({ buyerId: buyer.id }, 'signed in')
  return { token, buyer, expiresAt }
}

export async function buyerForToken(ctx: AppContext, token: string | undefined): Promise<{ buyer: BuyerRow; sessionId: string } | null> {
  if (!token || token.length > 100) return null
  const [row] = await ctx.db
    .select({ buyer: buyers, sessionId: sessions.id })
    .from(sessions)
    .innerJoin(buyers, eq(buyers.id, sessions.buyerId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date(ctx.now()))))
  return row ?? null
}

export async function signOut(ctx: AppContext, sessionId: string): Promise<void> {
  await ctx.db.update(sessions).set({ revokedAt: new Date(ctx.now()) }).where(eq(sessions.id, sessionId))
}

export const detailsBody = z.object({
  phone: z.string().trim().max(20),
  email: z.string().trim().toLowerCase().max(254).email('Enter a valid email address'),
})

export async function saveDetails(ctx: AppContext, buyerId: string, body: unknown): Promise<BuyerRow> {
  const { phone, email } = detailsBody.parse(body)
  const normalized = normalizePhone(phone)
  if (!normalized) throw new HttpError(400, 'INVALID_INPUT', 'Enter a Nigerian mobile number, like 0803 123 4567.')
  const [buyer] = await ctx.db.update(buyers).set({ phone: normalized, email }).where(eq(buyers.id, buyerId)).returning()
  if (!buyer) throw new HttpError(404, 'NOT_FOUND', 'Sign in again.')
  return buyer
}

/** What the browser is told about the buyer: nothing it did not give us */
export function toBuyer(b: BuyerRow) {
  return { telegramId: b.telegramId, username: b.username, firstName: b.firstName, photoUrl: b.photoUrl, phone: b.phone, email: b.email, detailsComplete: !!(b.phone && b.email) }
}
