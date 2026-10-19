/**
 * Domain types shared by the Mini App (mock and real API clients), the store,
 * the UI and the API server. The API returns exactly these shapes, so the UI
 * does not care which backend it is talking to.
 */

import type { FeatureMap } from './features'

export type RaffleStatus = 'open' | 'closing_soon' | 'drawing' | 'drawn'

export type PrizeKind = 'phone' | 'laptop' | 'tv' | 'earbuds' | 'powerbank' | 'voucher' | 'console'

export interface WinnerSlot {
  /** 1..n with no gaps; see prizeLabel() for how a place is named */
  position: number
  /** What this position wins, e.g. "Samsung Galaxy A15" or "₦20,000 airtime" */
  prizeItem: string
  /** Winner username without @, or null while the draw is pending ("TBD") or when the winner has none */
  username: string | null
  /** How the winner is shown: "@username", or a first name for a player without one; null before the draw */
  name: string | null
  /** The winning ticket number; null before the draw */
  ticket: number | null
}

export interface Raffle {
  id: string
  prizeName: string
  model: string
  category: string
  kind: PrizeKind
  /** Accent hue (0-360) used for the card gradient and illustration */
  hue: number
  /** Prize photo, a /v1/media/<id> path on the API (always under 500 KB); null shows the drawn illustration */
  imageUrl: string | null
  marketPriceNaira: number
  /**
   * Price of one entry in Raffs, fixed for the life of the raffle. The hourly
   * rate only affects buying Raffs with Stars, never what an entry costs.
   */
  entryPriceRaffs: number
  /** ISO timestamp of the draw moment (the deadline for entries) */
  deadline: string
  entriesCount: number
  /** Entries on sale; the raffle closes early once they are all sold */
  entriesTarget: number
  description: string
  rules: string[]
  winners: WinnerSlot[]
  /** ISO timestamp once the draw has completed, otherwise null */
  drawnAt: string | null
  /** SHA-256 of the draw seed, published while entries are open */
  seedCommitment: string | null
  /** The seed itself, published once the raffle is drawn so anyone can re-run the draw */
  drawSeed: string | null
  /** Recent entrants' usernames, for the draw reveal animation */
  entrants: string[]
}

export interface Entry {
  id: string
  raffleId: string
  qty: number
  raffsSpent: number
  /** Ticket numbers this entry holds, inclusive; the draw picks ticket numbers */
  ticketFrom: number
  ticketTo: number
  createdAt: string
}

export type TransactionType =
  | 'purchase'
  | 'entry'
  | 'bonus'
  | 'prize'
  | 'refund'
  /** 10% of an entry by someone you referred */
  | 'referral'
  /** A referral earning taken back because the purchase behind it was refunded */
  | 'referral_reversal'
  /** A correction made by an admin, approved by a second admin */
  | 'adjustment'
  /** Raffs another player sent you (feature raffs_transfer) */
  | 'transfer_in'
  /** Raffs you sent to another player */
  | 'transfer_out'

export interface Transaction {
  id: string
  type: TransactionType
  /** Signed Raffs movement: positive = in, negative = out */
  raffs: number
  /** Naira amount where applicable (demo purchases), otherwise null */
  naira: number | null
  /** Telegram Stars paid, for purchases; otherwise null */
  stars: number | null
  note: string
  createdAt: string
  status: 'completed' | 'failed'
}

/**
 * The price of a Raff in Telegram Stars for one clock hour. Admins set a base;
 * each hour moves 3% to 15% up or down from that base (never from the
 * previous hour), so a quote stays within 85% to 115% of the base.
 */
export interface RateQuote {
  id: string
  starsPerRaff: number
  /** Display only: about how many Naira one Raff is worth at this quote */
  nairaPerRaff: number
  /** Epoch ms when the quote became valid */
  issuedAt: number
  /** Epoch ms when it stops being valid */
  expiresAt: number
  source: 'demo' | 'live'
}

export interface ReferralSummary {
  code: string
  link: string
  peopleReferred: number
  /** Referred people who entered at least once this calendar month (Lagos time) */
  activeThisMonth: number
  lifetimeRaffs: number
  monthRaffs: number
}

export interface ReferredPerson {
  username: string
  joinedAt: string
  entries: number
  /** Raffs you have earned from this person's entries */
  raffsEarned: number
}

export interface ReferralEarning {
  id: string
  createdAt: string
  username: string
  raffleName: string
  /** What their entry cost */
  entryRaffs: number
  /** Your 10% */
  earnedRaffs: number
}

/**
 * GET /v1/live: the small, cheap snapshot the app polls every few seconds so
 * counts, balance and raffle states change on screen without a refresh.
 * Anything it reveals as changed (a new raffle, a new balance) makes the app
 * fetch the full data once.
 */
export interface LiveSnapshot {
  serverTime: number
  balance: number
  /** Effective feature switches for this player; a change shows or hides features within seconds */
  features: FeatureMap
  raffles: {
    id: string
    entriesCount: number
    entriesTarget: number
    status: string
    deadline: string
    drawnAt: string | null
    /** Changes whenever an admin edits what players see (price, prizes, text); entries do not change it */
    version: string
  }[]
}

/** One page of a cursor-paginated list. nextCursor is null on the last page. */
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * Where a winner collects a physical prize: their city and the nearest motor
 * park. Never a house address (security decision of 16 Oct).
 */
export interface DeliveryPoint {
  state: string
  city: string
  /** e.g. "Jibowu Motor Park" */
  motorPark: string
}

export type VerificationStatus = 'unverified' | 'pending' | 'verified'

export interface Verification {
  status: VerificationStatus
  /** Downscaled data URL of the uploaded government ID (demo: stored locally) */
  idImage: string | null
  /** Downscaled data URL of the selfie / profile picture (demo: stored locally) */
  selfieImage: string | null
  submittedAt: string | null
}

export interface ContactPrefs {
  whatsapp: boolean
  telegram: boolean
  email: boolean
}

/**
 * A player. There is no sign-up: the account exists from the first open of
 * the bot, with the Telegram name and username. Phone and delivery point are
 * given only on the KYC page, when a prize needs delivering.
 */
export interface Profile {
  id: string
  fullName: string
  username: string
  /** Normalised E.164 Nigerian number from Telegram's contact share, or null before KYC */
  phone: string | null
  /** True when the number came from Telegram's contact share, not typed in */
  phoneVerified: boolean
  email: string | null
  createdAt: string
  telegramId: number | null
  /** This user's own code, used in https://t.me/<bot>/app?startapp=ref_<code> */
  referralCode: string
  delivery: DeliveryPoint | null
  /** Name, verified phone and delivery point all given: prizes can be released */
  kycComplete: boolean
  /** Shows the admin entry; the admin API still checks the account and a TOTP code itself */
  isAdmin: boolean
  contactPrefs: ContactPrefs
  verification: Verification
  /** The bot may send reminders and offers to this player (they can turn it off) */
  remindersOn: boolean
}

/** The KYC page: who to hand the prize to, and where. */
export interface KycInput {
  fullName: string
  state: string
  city: string
  motorPark: string
  /**
   * The signed `response` string from WebApp.requestContact. The API checks
   * its hash with the bot token, so the phone is the one Telegram holds for
   * this account. Not needed again once the phone is verified.
   */
  contactProof?: string
  /** Mock API only: a typed number for the demo, where Telegram cannot share one */
  phone?: string
}

export interface RaffsPackage {
  id: string
  naira: number
  /** Bonus Raffs as a percentage of the base amount (0 = none) */
  bonusPct: number
  tag?: string
}

/** Everything the app needs on boot, in one round trip. */
export interface Bootstrap {
  profile: Profile | null
  onboardingComplete: boolean
  balance: number
  raffles: Raffle[]
  entries: Entry[]
  transactions: Transaction[]
  /** Effective feature switches for this player (see features.ts) */
  features: FeatureMap
  /**
   * Set once, on the open that claimed a come-back offer: the Raffs just
   * credited, for a "welcome back" message. Null otherwise.
   */
  welcomeBack: { raffs: number } | null
}

/** GET /v1/streak (feature daily_streak). Days are Lagos calendar days. */
export interface StreakState {
  /** Consecutive days claimed, counting today if claimed; 0 when the streak is broken */
  current: number
  claimedToday: boolean
  /** Raffs the next claim pays (today's if not yet claimed, else tomorrow's) */
  nextReward: number
  /** Reward by streak day: day 1 = rewards[0]; past the end the last value repeats */
  rewards: number[]
  /** YYYY-MM-DD (Lagos) of the last claim, or null */
  lastClaimedDay: string | null
  /** Best streak ever */
  best: number
}

/** POST /v1/streak/claim */
export interface StreakClaimResult {
  state: StreakState
  /** Raffs credited by this claim */
  raffs: number
  balance: number
}

/** GET /v1/transfers/recipient?username= : who you are about to send to */
export interface TransferRecipient {
  username: string
  /** First name only, for "Send to Ada (@ada_obi)?" */
  displayName: string
}

/** POST /v1/transfers (feature raffs_transfer) */
export interface TransferResult {
  id: string
  toUsername: string
  raffs: number
  /** Sender's balance after the transfer */
  balance: number
  createdAt: string
}

/** GET /v1/transfers/limits */
export interface TransferLimits {
  minRaffs: number
  dailyMaxRaffs: number
  /** Raffs already sent today (Lagos day) */
  sentToday: number
}
