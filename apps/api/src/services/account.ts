/**
 * The player's own account: bootstrap, profile, phone, KYC, contact
 * preferences, reminders, onboarding. There is no sign-up: the account is
 * created complete on the first open of the bot (services/auth.ts). The phone
 * is asked for at onboarding (services/phone.ts); the other personal details
 * beyond the Telegram name are asked for only on the KYC page, to deliver a
 * prize to the player's nearest motor park. Responses use the shared shapes,
 * so the Mini App reads them exactly like the mock API.
 */
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm'
import type { Bootstrap, ContactPrefs, Profile } from '@raffwin/shared'
import type { KycBody, ProfilePatchBody } from '@raffwin/shared/schemas'
import type { AppContext, RequestMeta } from '../context'
import { uniqueViolation } from '../db/client'
import { adminUsers, deliveryPoints, users, type DeliveryPointRow, type UserRow } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { claimComeback, setReminders } from './engagement'
import { featuresFor } from './features'
import { recentTransactions } from './ledger'
import { flagSelfReferral, phoneInUseError, saveVerifiedPhone, verifyContactProof } from './phone'
import { entriesForPlayer, listForPlayer } from './raffles'

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
    remindersOn: user.remindersOptOutAt === null,
  }
}

async function loadDelivery(ctx: AppContext, userId: string): Promise<DeliveryPointRow | null> {
  const [row] = await ctx.db.select().from(deliveryPoints).where(eq(deliveryPoints.userId, userId))
  return row ?? null
}

/**
 * True for an active admin's Telegram account: the one it is bound to, or,
 * before its first sign-in, the account whose username the super admin named.
 * This only decides whether the app shows the Admin card; getting in still
 * needs the full bot sign-in.
 */
export async function isAdminAccount(ctx: AppContext, user: Pick<UserRow, 'telegramId' | 'tgUsername'>): Promise<boolean> {
  const tgUsername = user.tgUsername?.toLowerCase() ?? null
  const [row] = await ctx.db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(
      and(
        eq(adminUsers.status, 'active'),
        or(
          eq(adminUsers.telegramId, user.telegramId),
          tgUsername ? and(isNull(adminUsers.telegramId), eq(adminUsers.telegramUsername, tgUsername)) : undefined,
        ),
      ),
    )
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
  const [delivery, admin] = await Promise.all([loadDelivery(ctx, user.id), isAdminAccount(ctx, user)])
  const profile = toProfile(user, delivery, admin)
  if (!profile) throw new HttpError('NOT_SIGNED_IN', 'Close Raffle Win and open it again from the bot.')
  return profile
}

/**
 * A pending come-back offer is credited on this open, before the balance is
 * read, so the balance the app shows already includes it. A failed claim is
 * logged and the app opens without it: the offer stays unclaimed for the next
 * open, and a bonus must never stop a player getting in.
 */
async function claimWelcomeBack(ctx: AppContext, userId: string): Promise<{ raffs: number } | null> {
  try {
    return await claimComeback(ctx, userId)
  } catch (error) {
    ctx.log.error({ err: error, userId }, 'come-back offer claim failed; opening the app without it')
    return null
  }
}

export async function bootstrap(ctx: AppContext, user: UserRow): Promise<Bootstrap> {
  const welcomeBack = await claimWelcomeBack(ctx, user.id)
  // Always read again, not only after our own claim: a second open at the same moment
  // gets null (the first open's claim won) and must still show the balance with it
  const current = await reload(ctx, user.id)
  const [profile, raffleList, entryList, transactions, features] = await Promise.all([
    profileOf(ctx, current),
    listForPlayer(ctx.db, current.id, ctx.now()),
    entriesForPlayer(ctx.db, current.id),
    recentTransactions(ctx.db, current.id),
    featuresFor(ctx.db, current.id),
  ])
  return {
    profile,
    onboardingComplete: current.onboardingCompletedAt !== null,
    balance: current.balanceCache,
    raffles: raffleList,
    entries: entryList,
    transactions,
    features,
    welcomeBack,
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
  if (constraint === 'users_phone_key') return phoneInUseError()
  return null
}

/**
 * The phone alone (onboarding step, the dashboard card, or before an entry):
 * from Telegram's signed contact share, only when the contact is this account
 * itself. Does not complete KYC.
 */
export async function savePhone(ctx: AppContext, user: UserRow, contactProof: string, meta: RequestMeta): Promise<Profile> {
  requireAccount(user)
  const phone = await verifyContactProof(ctx, user, contactProof, meta)
  return profileOf(ctx, await saveVerifiedPhone(ctx, user, phone, 'app', meta))
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
  if (body.contactProof) phone = await verifyContactProof(ctx, user, body.contactProof, meta)
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
    if (uniqueViolation(error) === 'users_phone_key' && phone) await flagSelfReferral(ctx, user, phone, meta)
    throw conflictError(error) ?? error
  }
  return profileOf(ctx, await reload(ctx, user.id))
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

/** Bot reminders and come-back offers on or off (announcements are not affected). */
export async function updateReminders(ctx: AppContext, user: UserRow, on: boolean): Promise<Profile> {
  requireAccount(user)
  await setReminders(ctx, user.id, on)
  return profileOf(ctx, await reload(ctx, user.id))
}
