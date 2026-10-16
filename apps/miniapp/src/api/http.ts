/**
 * Real API client. Same signatures as mock.ts, so the store cannot tell them
 * apart. Endpoints that arrive in later milestones refuse with NOT_READY and
 * say so, rather than pretending to work.
 */
import type {
  Bootstrap,
  ContactPrefs,
  DeliveryAddress,
  Entry,
  Profile,
  Raffle,
  SignUpInput,
  Transaction,
} from '@/data/types'
import { getRateProvider, type RateQuote } from '@/services/rates'
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

export async function signUp(input: SignUpInput): Promise<Bootstrap> {
  if (!input.contactProof) {
    throw new ApiError('PHONE_NOT_VERIFIED', 'Share your phone number through Telegram to finish creating your account.')
  }
  return call<Bootstrap>('POST', '/v1/signup', {
    fullName: input.fullName,
    username: input.username,
    email: input.email,
    contactProof: input.contactProof,
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

export function updateAddress(address: DeliveryAddress): Promise<Profile> {
  return call('PUT', '/v1/profile/address', address)
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

/** Server-issued quotes arrive with raffles (milestone 2); until then this is the demo quote. */
export function getRate(): Promise<RateQuote> {
  return getRateProvider().fetchRate()
}

/* Raffles -------------------------------------------------------------------- */

export async function getRaffles(): Promise<Raffle[]> {
  return (await getBootstrap()).raffles
}

export async function getRaffle(id: string): Promise<Raffle> {
  const raffle = (await getRaffles()).find((r) => r.id === id)
  if (!raffle) throw new ApiError('NOT_FOUND', 'That raffle no longer exists.')
  return raffle
}

export async function enterRaffle(): Promise<EnterRaffleResponse> {
  return notYet('Entering raffles')
}

export async function drawRaffle(): Promise<{ raffle: Raffle; balance: number; youWon: boolean }> {
  return notYet('Draws')
}

/* Wallet --------------------------------------------------------------------- */

export async function buyRaffs(): Promise<BuyRaffsResponse> {
  return notYet('Buying Raffs with Telegram Stars')
}

export async function getTransactions(): Promise<Transaction[]> {
  return (await getBootstrap()).transactions
}

export async function getEntries(): Promise<Entry[]> {
  return (await getBootstrap()).entries
}
