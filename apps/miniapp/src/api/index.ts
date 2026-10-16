/**
 * The API the store talks to. VITE_API_URL set -> the real Raffle Win API
 * (http.ts); unset -> the in-browser mock (mock.ts) used by the demo build.
 * Both modules export the same functions with the same signatures.
 */
import { env } from '@/services/env'
import * as http from './http'
import * as mock from './mock'

export type { BuyRaffsRequest, BuyRaffsResponse, EnterRaffleRequest, EnterRaffleResponse } from './mock'

/** True when talking to the real API; the UI hides demo-only controls. */
export const usingRealApi = env.apiUrl !== ''

const impl: typeof mock = usingRealApi ? http : mock

export const getBootstrap = impl.getBootstrap
export const resetDemo = impl.resetDemo
export const signOut = impl.signOut
export const checkUsername = impl.checkUsername
export const saveKyc = impl.saveKyc
export const completeOnboarding = impl.completeOnboarding
export const getProfile = impl.getProfile
export const updateProfile = impl.updateProfile
export const updateContactPrefs = impl.updateContactPrefs
export const submitVerification = impl.submitVerification
export const setVerificationStatus = impl.setVerificationStatus
export const getRate = impl.getRate
export const getLive = impl.getLive
export const startAdminSignIn = impl.startAdminSignIn
export const getRaffles = impl.getRaffles
export const getRaffle = impl.getRaffle
export const enterRaffle = impl.enterRaffle
export const drawRaffle = impl.drawRaffle
export const buyRaffs = impl.buyRaffs
export const getTransactions = impl.getTransactions
export const getEntries = impl.getEntries
export const getReferralSummary = impl.getReferralSummary
export const getReferredPeople = impl.getReferredPeople
export const getReferralEarnings = impl.getReferralEarnings
