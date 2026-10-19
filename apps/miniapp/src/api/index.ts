/**
 * The API the store talks to. VITE_API_URL set -> the real Raffle Win API
 * (http.ts); unset -> the in-browser mock (mock.ts) used by the demo build.
 * Both modules export the same functions with the same signatures.
 */
import { env } from '@/services/env'
import * as http from './http'
import * as mock from './mock'

export type { EnterRaffleRequest, EnterRaffleResponse, RedeemVoucherResponse, SendRaffsRequest } from './mock'

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
export const savePhone = impl.savePhone
export const setReminders = impl.setReminders
export const setDemoFeature = impl.setDemoFeature
export const getRate = impl.getRate
export const getLive = impl.getLive
export const startAdminSignIn = impl.startAdminSignIn
export const getRaffles = impl.getRaffles
export const getRaffle = impl.getRaffle
export const enterRaffle = impl.enterRaffle
export const drawRaffle = impl.drawRaffle
export const redeemVoucher = impl.redeemVoucher
export const getTransactions = impl.getTransactions
export const getEntries = impl.getEntries
export const getStreak = impl.getStreak
export const claimStreak = impl.claimStreak
export const getTransferLimits = impl.getTransferLimits
export const findRecipient = impl.findRecipient
export const sendRaffs = impl.sendRaffs
export const getReferralSummary = impl.getReferralSummary
export const getReferredPeople = impl.getReferredPeople
export const getReferralEarnings = impl.getReferralEarnings
