/**
 * The player's own account: bootstrap, profile, KYC, contact preferences,
 * onboarding. There is no sign-up: the account is created complete on the
 * first open of the bot (services/auth.ts). Personal details beyond the
 * Telegram name are asked for only on the KYC page, to deliver a prize to the
 * player's nearest motor park. Responses use the shared shapes, so the Mini
 * App reads them exactly like the mock API.
 */
import { and, eq, ne, sql } from 'drizzle-orm'
import { normalizeNigerianPhone, type Bootstrap, type ContactPrefs, type Profile } from '@raffwin/shared'
import type { KycBody, ProfilePatchBody } from '@raffwin/shared/schemas'
import type { AppContext, RequestMeta } from '../context'
import { uniqueViolation } from '../db/client'
import { adminUsers, deliveryPoints, users, type DeliveryPointRow, type UserRow } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'
import { readSharedContact, verifyTelegramData } from '../lib/telegram-auth'
import { recentTransactions } from './ledger'
import { entriesForPlayer, listForPlayer } from './raffles'

/** A contact share is fresh when it was made within this window. */
const CONTACT_PROOF_MAX_AGE_SECONDS = 60 * 60

export function toProfile(user: UserRow, delivery: DeliveryPointRow | null, isAdmin: boolean): Profile | null {
  if (!user.signedUpAt || !user.username || !user.fullName) return null
  return {
    id: user.id,
    fullName: user.fullName,
    username: user.username,
    phone: user.phone,
    phoneVerified: user.phoneVerifiedAt !== null,
    email: user.email,
    createdAt: user.signedUpAt.toISOString(),
    telegramId: user.telegramId,
    referralCode: user.referralCode,
    delivery: delivery ? { state: delivery.state, city: delivery.city, motorPark: delivery.motorPark } : null,
    kycComplete: user.kycCompletedAt !== null,
    isAdmin,
    contactPrefs: { whatsapp: user.contactWhatsapp, telegram: user.contactTelegram, email: user.contactEmail },
    // Identity documents are not collected (16 Oct): delivery is to a motor park, by name and phone
    verification: { status: 'unverified', idImage: null, selfieImage: null, submittedAt: null },
  }
}

async function loadDelivery(ctx: AppContext, userId: string): Promise<DeliveryPointRow | null> {
  const [row] = await ctx.db.select().from(deliveryPoints).where(eq(deliveryPoints.userId, userId))
  return row ?? null
}

async function isAdminAccount(ctx: AppContext, telegramId: number): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(and(eq(adminUsers.telegramId, telegramId), eq(adminUsers.status, 'active')))
  return !!row
}

async function reload(ctx: AppContext, userId: string): Promise<UserRow> {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, userId))
  if (!row) throw new Error(`user ${userId} vanished`)
  return row
}

function requireAccount(user: UserRow): void {
  if (!user.signedUpAt) throw new HttpError('NOT_SIGNED_IN', 'Close Raffle Win and open it again from the bot.')
}

async function profileOf(ctx: AppContext, user: UserRow): Promise<Profile> {
  const [delivery, admin] = await Promise.all([loadDelivery(ctx, user.id), isAdminAccount(ctx, user.telegramId)])
  const profile = toProfile(user, delivery, admin)
  if (!profile) throw new HttpError('NOT_SIGNED_IN', 'Close Raffle Win and open it again from the bot.')
  return profile
}

export async function bootstrap(ctx: AppContext, user: UserRow): Promise<Bootstrap> {
  const [profile, raffleList, entryList, transactions] = await Promise.all([
    profileOf(ctx, user),
    listForPlayer(ctx.db, user.id, ctx.now()),
    entriesForPlayer(ctx.db, user.id),
    recentTransactions(ctx.db, user.id),
  ])
  return {
    profile,
    onboardingComplete: user.onboardingCompletedAt !== null,
    balance: user.balanceCache,
    raffles: raffleList,
    entries: entryList,
    transactions,
  }
}

export async function isUsernameAvailable(ctx: AppContext, username: string, selfId: string): Promise<boolean> {
  const [taken] = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, username), ne(users.id, selfId)))
  return !taken
}

/** Maps a unique-index race to the error the form already knows how to show. */
function conflictError(error: unknown): HttpError | null {
  const constraint = uniqueViolation(error)
  if (constraint === 'users_username_key') return new HttpError('USERNAME_TAKEN', 'That username is already taken.')
  if (constraint === 'users_phone_key') {
    return new HttpError('PHONE_IN_USE', 'That phone number is already on another Raffle Win account. One account per person.')
  }
  return null
}

/**
 * KYC: name, the phone Telegram verified, and the motor park to deliver to.
 * The phone is taken only from Telegram's signed contact share, and only when
 * the shared contact is this account itself. Once verified, later KYC edits
 * (a new motor park, say) do not need a new share.
 */
export async function saveKyc(ctx: AppContext, user: UserRow, body: KycBody, meta: RequestMeta): Promise<Profile> {
  requireAccount(user)
  let phone = user.phone
  if (body.contactProof) phone = await verifiedPhone(ctx, user, body.contactProof, meta)
  else if (!user.phoneVerifiedAt) {
    throw new HttpError('PHONE_NOT_VERIFIED', 'Share your phone number through Telegram so the courier can call you.')
  }

  const now = new Date(ctx.now())
  try {
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          fullName: body.fullName,
          phone,
          phoneVerifiedAt: body.contactProof ? now : user.phoneVerifiedAt,
          kycCompletedAt: sql`coalesce(${users.kycCompletedAt}, ${now})`,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, user.id))
      const point = { state: body.state, city: body.city, motorPark: body.motorPark }
      await tx
        .insert(deliveryPoints)
        .values({ userId: user.id, ...point })
        .onConflictDoUpdate({ target: deliveryPoints.userId, set: { ...point, updatedAt: sql`now()` } })
    })
  } catch (error) {
    if (uniqueViolation(error) === 'users_phone_key' && phone && user.referredByUserId) {
      await flagSelfReferral(ctx, user, phone, meta)
    }
    throw conflictError(error) ?? error
  }
  return profileOf(ctx, await reload(ctx, user.id))
}

async function verifiedPhone(ctx: AppContext, user: UserRow, proof: string, meta: RequestMeta): Promise<string> {
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
 * belongs to one account, so the friend's KYC is refused when they verify the
 * referrer's own number; that refusal means one person on two Telegram
 * accounts and is recorded for review (earnings paid so far stay visible in
 * the ledger).
 */
async function flagSelfReferral(ctx: AppContext, user: UserRow, phone: string, meta: RequestMeta): Promise<void> {
  const [referrer] = await ctx.db.select({ phone: users.phone }).from(users).where(eq(users.id, user.referredByUserId as string))
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

export async function completeOnboarding(ctx: AppContext, user: UserRow): Promise<{ onboardingComplete: boolean }> {
  requireAccount(user)
  await ctx.db
    .update(users)
    .set({ onboardingCompletedAt: sql`coalesce(${users.onboardingCompletedAt}, now())`, updatedAt: sql`now()` })
    .where(eq(users.id, user.id))
  return { onboardingComplete: true }
}

export async function getProfile(ctx: AppContext, user: UserRow): Promise<Profile> {
  requireAccount(user)
  return profileOf(ctx, user)
}

export async function updateProfile(ctx: AppContext, user: UserRow, patch: ProfilePatchBody): Promise<Profile> {
  requireAccount(user)
  if (patch.username && !(await isUsernameAvailable(ctx, patch.username, user.id))) {
    throw new HttpError('USERNAME_TAKEN', 'That username is already taken.')
  }
  try {
    await ctx.db
      .update(users)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(users.id, user.id))
  } catch (error) {
    throw conflictError(error) ?? error
  }
  return profileOf(ctx, await reload(ctx, user.id))
}

export async function updateContactPrefs(ctx: AppContext, user: UserRow, prefs: ContactPrefs): Promise<Profile> {
  requireAccount(user)
  await ctx.db
    .update(users)
    .set({
      contactWhatsapp: prefs.whatsapp,
      contactTelegram: prefs.telegram,
      contactEmail: prefs.email,
      updatedAt: sql`now()`,
    })
    .where(eq(users.id, user.id))
  return profileOf(ctx, await reload(ctx, user.id))
}
