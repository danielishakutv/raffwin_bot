/**
 * The signed-in user's own account: bootstrap, sign-up, profile, address,
 * contact preferences, onboarding. Responses use the shared Profile and
 * Bootstrap shapes, so the Mini App reads them exactly like the mock API.
 */
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm'
import { normalizeNigerianPhone, type Bootstrap, type ContactPrefs, type Profile } from '@raffwin/shared'
import type { AddressBody, ProfilePatchBody, SignUpBody } from '@raffwin/shared/schemas'
import type { AppContext, RequestMeta } from '../context'
import { uniqueViolation } from '../db/client'
import { addresses, users, type AddressRow, type UserRow } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'
import { readSharedContact, verifyTelegramData } from '../lib/telegram-auth'
import { recentTransactions } from './ledger'
import { entriesForPlayer, listForPlayer } from './raffles'

/** A contact share is fresh when it was made within this window. */
const CONTACT_PROOF_MAX_AGE_SECONDS = 60 * 60

export function toProfile(user: UserRow, address: AddressRow | null): Profile | null {
  if (!user.signedUpAt || !user.username || !user.fullName || !user.email || !user.phone) return null
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
    address: address
      ? { street: address.street, city: address.city, state: address.state, landmark: address.landmark, phone: address.phone }
      : null,
    contactPrefs: { whatsapp: user.contactWhatsapp, telegram: user.contactTelegram, email: user.contactEmail },
    // KYC arrives in milestone 5; until then every account is unverified.
    verification: { status: 'unverified', idImage: null, selfieImage: null, submittedAt: null },
  }
}

async function loadAddress(ctx: AppContext, userId: string): Promise<AddressRow | null> {
  const [row] = await ctx.db.select().from(addresses).where(eq(addresses.userId, userId))
  return row ?? null
}

async function reload(ctx: AppContext, userId: string): Promise<UserRow> {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, userId))
  if (!row) throw new Error(`user ${userId} vanished`)
  return row
}

function requireSignedUp(user: UserRow): void {
  if (!user.signedUpAt) throw new HttpError('NOT_SIGNED_IN', 'Create your account first.')
}

export async function bootstrap(ctx: AppContext, user: UserRow): Promise<Bootstrap> {
  const profile = toProfile(user, await loadAddress(ctx, user.id))
  const [raffleList, entryList, transactions] = await Promise.all([
    listForPlayer(ctx.db, user.id, ctx.now()),
    entriesForPlayer(ctx.db, user.id),
    recentTransactions(ctx.db, user.id),
  ])
  return {
    profile,
    onboardingComplete: profile !== null && user.onboardingCompletedAt !== null,
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
    return new HttpError('PHONE_IN_USE', 'That phone number already has a Raffle Win account. One account per person.')
  }
  return null
}

export async function signUp(ctx: AppContext, user: UserRow, body: SignUpBody, meta: RequestMeta): Promise<Bootstrap> {
  if (user.signedUpAt) throw new HttpError('ALREADY_REGISTERED', 'This Telegram account already has a Raffle Win account.')

  const phone = await verifiedPhone(ctx, user, body.contactProof, meta)

  if (!(await isUsernameAvailable(ctx, body.username, user.id))) {
    throw new HttpError('USERNAME_TAKEN', 'That username is already taken.')
  }

  const referrerId = await resolveReferrer(ctx, user, phone, meta)
  const now = new Date(ctx.now())
  try {
    await ctx.db
      .update(users)
      .set({
        username: body.username,
        fullName: body.fullName,
        email: body.email,
        phone,
        phoneVerifiedAt: now,
        signedUpAt: now,
        referredByUserId: referrerId,
        referredAt: referrerId ? now : null,
        updatedAt: sql`now()`,
      })
      // The where clause makes a double-submit a no-op instead of a second sign-up
      .where(and(eq(users.id, user.id), sql`${users.signedUpAt} is null`))
  } catch (error) {
    throw conflictError(error) ?? error
  }
  return bootstrap(ctx, await reload(ctx, user.id))
}

/**
 * The phone comes only from Telegram's signed contact share, and only when the
 * shared contact is the signed-in account itself.
 */
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
    throw new HttpError('PHONE_NOT_VERIFIED', 'Share your phone number through Telegram to finish creating your account.')
  }
  const phone = normalizeNigerianPhone((contact as { phone_number: string }).phone_number)
  if (!phone) {
    throw new HttpError('INVALID_INPUT', 'Raffle Win needs a Nigerian mobile number on your Telegram account.', {
      phone: 'Your Telegram account uses a number outside Nigeria.',
    })
  }
  return phone
}

/**
 * Binds the referrer seen on first open, if that code belongs to a signed-up,
 * active account that is not this person under another name (same phone).
 * A failed binding never blocks sign-up; it is recorded instead.
 */
async function resolveReferrer(ctx: AppContext, user: UserRow, phone: string, meta: RequestMeta): Promise<string | null> {
  const code = user.pendingReferralCode
  if (!code) return null
  const [referrer] = await ctx.db
    .select({ id: users.id, phone: users.phone, status: users.status })
    .from(users)
    .where(and(eq(users.referralCode, code), isNotNull(users.signedUpAt)))
  const reason = !referrer
    ? 'referral_unknown_code'
    : referrer.id === user.id || referrer.phone === phone
      ? 'referral_self'
      : referrer.status !== 'active'
        ? 'referral_inactive_referrer'
        : null
  if (reason) {
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: reason === 'referral_self' ? 'medium' : 'low',
      category: 'fraud',
      kind: reason,
      ipHash: meta.ipHash,
      route: meta.route,
      userId: user.id,
      requestId: meta.requestId,
      details: { code },
    })
    return null
  }
  return (referrer as { id: string }).id
}

export async function completeOnboarding(ctx: AppContext, user: UserRow): Promise<{ onboardingComplete: boolean }> {
  requireSignedUp(user)
  await ctx.db
    .update(users)
    .set({ onboardingCompletedAt: sql`coalesce(${users.onboardingCompletedAt}, now())`, updatedAt: sql`now()` })
    .where(eq(users.id, user.id))
  return { onboardingComplete: true }
}

export async function getProfile(ctx: AppContext, user: UserRow): Promise<Profile> {
  requireSignedUp(user)
  return toProfile(user, await loadAddress(ctx, user.id)) as Profile
}

export async function updateProfile(ctx: AppContext, user: UserRow, patch: ProfilePatchBody): Promise<Profile> {
  requireSignedUp(user)
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
  return getProfile(ctx, await reload(ctx, user.id))
}

export async function updateAddress(ctx: AppContext, user: UserRow, address: AddressBody): Promise<Profile> {
  requireSignedUp(user)
  await ctx.db
    .insert(addresses)
    .values({ userId: user.id, ...address })
    .onConflictDoUpdate({ target: addresses.userId, set: { ...address, updatedAt: sql`now()` } })
  return getProfile(ctx, user)
}

export async function updateContactPrefs(ctx: AppContext, user: UserRow, prefs: ContactPrefs): Promise<Profile> {
  requireSignedUp(user)
  await ctx.db
    .update(users)
    .set({
      contactWhatsapp: prefs.whatsapp,
      contactTelegram: prefs.telegram,
      contactEmail: prefs.email,
      updatedAt: sql`now()`,
    })
    .where(eq(users.id, user.id))
  return getProfile(ctx, await reload(ctx, user.id))
}
