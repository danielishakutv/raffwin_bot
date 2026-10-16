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
  Transaction,
} from '@/data/types'
import type { RateQuote } from '@/services/rates'
import { ApiError } from './errors'
import type { BuyRaffsRequest, BuyRaffsResponse, EnterRaffleRequest, EnterRaffleResponse } from './mock'
import { call, clearSession } from './session'

export type { BuyRaffsRequest, BuyRaffsResponse, EnterRaffleRequest, EnterRaffleResponse }

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

export async function submitVerification(): Promise<Profile> {
  return notYet('Identity verification')
}

export async function setVerificationStatus(): Promise<Profile> {
  return notYet('The verification demo switch')
}

/* Rates ---------------------------------------------------------------------- */

export function getRate(): Promise<RateQuote> {
  return call<RateQuote>('GET', '/v1/rate')
}

/* Raffles -------------------------------------------------------------------- */

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
