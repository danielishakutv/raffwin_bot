/**
 * Real API client. Same signatures as mock.ts, so the store cannot tell them
 * apart. Endpoints that arrive in later milestones refuse with NOT_READY and
 * say so, rather than pretending to work.
 */
import type {
  Bootstrap,
  Page,
  ReferralEarning,
  ReferralSummary,
  ReferredPerson,
  ContactPrefs,
  Entry,
  Profile,
  Raffle,
  KycInput,
  LiveSnapshot,
  StreakClaimResult,
  StreakState,
  Transaction,
  TransferLimits,
  TransferRecipient,
  TransferResult,
} from '@/data/types'
import type { FeatureMap } from '@raffwin/shared'
import type { RateQuote } from '@/services/rates'
import { ApiError } from './errors'
import type { BuyRaffsRequest, BuyRaffsResponse, EnterRaffleRequest, EnterRaffleResponse, SendRaffsRequest } from './mock'
import { call, clearSession } from './session'

export type { BuyRaffsRequest, BuyRaffsResponse, EnterRaffleRequest, EnterRaffleResponse, SendRaffsRequest }

function notYet(what: string): never {
  throw new ApiError('NOT_READY', `${what} is not switched on yet. It arrives with the next release.`)
}

/* Boot / session ------------------------------------------------------------ */

export function getBootstrap(): Promise<Bootstrap> {
  return call<Bootstrap>('GET', '/v1/bootstrap')
}

export async function resetDemo(): Promise<Bootstrap> {
  return notYet('Resetting demo data')
}

export async function signOut(): Promise<void> {
  try {
    await call<void>('POST', '/v1/auth/logout')
  } finally {
    clearSession()
  }
}

/* Auth / profile ------------------------------------------------------------ */

export function checkUsername(username: string): Promise<{ available: boolean }> {
  return call('GET', `/v1/username-available?username=${encodeURIComponent(username.trim().toLowerCase())}`)
}

/** KYC: name, Telegram-verified phone and the nearest motor park (never a house address). */
export function saveKyc(input: KycInput): Promise<Profile> {
  return call<Profile>('PUT', '/v1/kyc', {
    fullName: input.fullName,
    state: input.state,
    city: input.city,
    motorPark: input.motorPark,
    ...(input.contactProof ? { contactProof: input.contactProof } : {}),
  })
}

export function completeOnboarding(): Promise<{ onboardingComplete: boolean }> {
  return call('POST', '/v1/onboarding/complete')
}

export function getProfile(): Promise<Profile> {
  return call('GET', '/v1/profile')
}

export function updateProfile(patch: Partial<Pick<Profile, 'fullName' | 'phone' | 'email' | 'username'>>): Promise<Profile> {
  if (patch.phone !== undefined) {
    throw new ApiError('INVALID_INPUT', 'Your phone number is verified by Telegram and cannot be edited here.')
  }
  return call('PATCH', '/v1/profile', patch)
}

export function updateContactPrefs(prefs: ContactPrefs): Promise<Profile> {
  return call('PUT', '/v1/profile/contact-prefs', prefs)
}

/** The phone alone, from Telegram's signed contact share (the sign-up step, or later). */
export function savePhone(contactProof: string): Promise<Profile> {
  return call<Profile>('PUT', '/v1/phone', { contactProof })
}

/** Whether the bot may send this player reminders and come-back offers. */
export function setReminders(on: boolean): Promise<Profile> {
  return call<Profile>('PUT', '/v1/profile/reminders', { on })
}

export async function submitVerification(): Promise<Profile> {
  return notYet('Identity verification')
}

export async function setVerificationStatus(): Promise<Profile> {
  return notYet('The verification demo switch')
}

/** Demo-only switch; in the real app a super admin switches features in the admin. */
export async function setDemoFeature(): Promise<FeatureMap> {
  return notYet('The feature demo switch')
}

/* Rates ---------------------------------------------------------------------- */

export function getRate(): Promise<RateQuote> {
  return call<RateQuote>('GET', '/v1/rate')
}

/* Raffles -------------------------------------------------------------------- */

/** The small snapshot polled every few seconds (counts, balance, raffle states). */
/** Admin card button: the bot asks this account for the master password in the chat. */
export function startAdminSignIn(): Promise<{ ok: boolean }> {
  return call('POST', '/v1/admin-signin')
}

export function getLive(): Promise<LiveSnapshot> {
  return call<LiveSnapshot>('GET', '/v1/live')
}

export function getRaffles(): Promise<Raffle[]> {
  return call<Raffle[]>('GET', '/v1/raffles')
}

export function getRaffle(id: string): Promise<Raffle> {
  return call<Raffle>('GET', `/v1/raffles/${encodeURIComponent(id)}`)
}

export function enterRaffle(req: EnterRaffleRequest): Promise<EnterRaffleResponse> {
  return call<EnterRaffleResponse>('POST', '/v1/entries', req)
}

export async function drawRaffle(): Promise<{ raffle: Raffle; balance: number; youWon: boolean }> {
  return notYet('Draws')
}

/* Wallet --------------------------------------------------------------------- */

export async function buyRaffs(): Promise<BuyRaffsResponse> {
  return notYet('Buying Raffs with Telegram Stars')
}

export function getTransactions(): Promise<Transaction[]> {
  return call<Transaction[]>('GET', '/v1/transactions')
}

export function getEntries(): Promise<Entry[]> {
  return call<Entry[]>('GET', '/v1/entries')
}

/* Daily streak (feature daily_streak) ------------------------------------------ */

export function getStreak(): Promise<StreakState> {
  return call<StreakState>('GET', '/v1/streak')
}

export function claimStreak(): Promise<StreakClaimResult> {
  return call<StreakClaimResult>('POST', '/v1/streak/claim')
}

/* Send Raffs (feature raffs_transfer) ------------------------------------------ */

export function getTransferLimits(): Promise<TransferLimits> {
  return call<TransferLimits>('GET', '/v1/transfers/limits')
}

export function findRecipient(username: string): Promise<TransferRecipient> {
  const u = username.trim().replace(/^@/, '').toLowerCase()
  return call<TransferRecipient>('GET', `/v1/transfers/recipient?username=${encodeURIComponent(u)}`)
}

export function sendRaffs(req: SendRaffsRequest): Promise<TransferResult> {
  return call<TransferResult>('POST', '/v1/transfers', req)
}

/* Referrals ------------------------------------------------------------------ */

export function getReferralSummary(): Promise<ReferralSummary> {
  return call<ReferralSummary>('GET', '/v1/referrals/summary')
}

export function getReferredPeople(cursor?: string): Promise<Page<ReferredPerson>> {
  return call('GET', `/v1/referrals/people${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
}

export function getReferralEarnings(cursor?: string): Promise<Page<ReferralEarning>> {
  return call('GET', `/v1/referrals/earnings${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
}
