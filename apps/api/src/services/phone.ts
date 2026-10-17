/**
 * The player's phone number. It is taken only from Telegram: the Mini App's
 * signed contact share (WebApp.requestContact) or the contact a player sends
 * the bot, and only when the contact is the player's own account. One phone
 * belongs to one account (users_phone_key).
 *
 * The phone is asked for at onboarding (there is no sign-up form, so that step
 * is the "sign-up"), before entering a raffle and before sending Raffs; the
 * KYC page reuses it. Saving a phone never completes KYC on its own: that also
 * needs the name and the motor park.
 */
import { eq, sql } from 'drizzle-orm'
import { normalizeNigerianPhone } from '@raffwin/shared'
import type { AppContext, RequestMeta } from '../context'
import { uniqueViolation } from '../db/client'
import { users, type UserRow } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'
import { readSharedContact, verifyTelegramData } from '../lib/telegram-auth'

/** A contact share is fresh when it was made within this window. */
const CONTACT_PROOF_MAX_AGE_SECONDS = 60 * 60

export function phoneInUseError(): HttpError {
  return new HttpError('PHONE_IN_USE', 'That phone number is already on another Raffle Win account. One account per person.')
}

/**
 * Checks a Mini App contact share and returns the Nigerian number in it
 * (E.164). Refused: a forged, stale or empty share, or somebody else's
 * contact (recorded as a fraud event), and numbers outside Nigeria.
 */
export async function verifyContactProof(ctx: AppContext, user: UserRow, proof: string, meta: RequestMeta): Promise<string> {
  const verified = verifyTelegramData(proof, ctx.config.BOT_TOKEN, {
    maxAgeSeconds: CONTACT_PROOF_MAX_AGE_SECONDS,
    now: ctx.now(),
  })
  const contact = verified.ok ? readSharedContact(verified.fields) : null
  const problem = !verified.ok
    ? `contact_${verified.reason}`
    : !contact
      ? 'contact_missing'
      : contact.user_id !== user.telegramId
        ? 'contact_other_account'
        : null
  if (problem) {
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: problem === 'contact_other_account' || problem === 'contact_bad_hash' ? 'high' : 'medium',
      category: 'fraud',
      kind: problem,
      ipHash: meta.ipHash,
      route: meta.route,
      userId: user.id,
      requestId: meta.requestId,
    })
    throw new HttpError('PHONE_NOT_VERIFIED', 'Share your phone number through Telegram so the courier can call you.')
  }
  const phone = normalizeNigerianPhone((contact as { phone_number: string }).phone_number)
  if (!phone) {
    throw new HttpError('INVALID_INPUT', 'Raffle Win delivers in Nigeria only, to a Nigerian number on your Telegram account.', {
      phone: 'Your Telegram account uses a number outside Nigeria.',
    })
  }
  return phone
}

/**
 * The referral bond is set on first open, before any phone is known. One phone
 * belongs to one account, so a friend verifying the referrer's own number is
 * refused; that refusal means one person on two Telegram accounts and is
 * recorded for review (earnings paid so far stay visible in the ledger).
 */
export async function flagSelfReferral(ctx: AppContext, user: UserRow, phone: string, meta: RequestMeta): Promise<void> {
  if (!user.referredByUserId) return
  const [referrer] = await ctx.db.select({ phone: users.phone }).from(users).where(eq(users.id, user.referredByUserId))
  if (referrer?.phone !== phone) return
  await recordSecurityEvent(ctx.db, ctx.log, {
    severity: 'high',
    category: 'fraud',
    kind: 'referral_self_same_phone',
    ipHash: meta.ipHash,
    route: meta.route,
    userId: user.id,
    requestId: meta.requestId,
    details: { referrerUserId: user.referredByUserId },
  })
}

/**
 * Stores a phone Telegram has verified as this player's own (E.164) and marks
 * it verified. A number already on another account is PHONE_IN_USE (and a
 * self-referral is recorded when it is the referrer's). `meta` is absent for
 * the bot's contact handler, which has no HTTP request behind it.
 */
export async function saveVerifiedPhone(
  ctx: AppContext,
  user: UserRow,
  phone: string,
  source: 'app' | 'bot',
  meta?: RequestMeta,
): Promise<UserRow> {
  const context: RequestMeta = meta ?? { ipHash: null, userAgent: null, requestId: '', route: 'bot contact' }
  try {
    const [row] = await ctx.db
      .update(users)
      .set({ phone, phoneVerifiedAt: new Date(ctx.now()), updatedAt: sql`now()` })
      .where(eq(users.id, user.id))
      .returning()
    if (!row) throw new Error(`user ${user.id} vanished`)
    if (row.phone !== user.phone) ctx.log.info({ userId: user.id, source, hadPhone: user.phone !== null }, 'phone verified')
    return row
  } catch (error) {
    if (uniqueViolation(error) === 'users_phone_key') {
      await flagSelfReferral(ctx, user, phone, context)
      throw phoneInUseError()
    }
    throw error
  }
}
