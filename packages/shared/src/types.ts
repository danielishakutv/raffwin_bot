/**
 * Domain types shared by the Mini App (mock and real API clients), the store,
 * the UI and the API server. The API returns exactly these shapes, so the UI
 * does not care which backend it is talking to.
 */

export type RaffleStatus = 'open' | 'closing_soon' | 'drawing' | 'drawn'

export type PrizeKind = 'phone' | 'laptop' | 'tv' | 'earbuds' | 'powerbank' | 'voucher' | 'console'

export interface WinnerSlot {
  position: 1 | 2 | 3
  /** What this position wins, e.g. "Samsung Galaxy A15" or "₦20,000 airtime" */
  prizeItem: string
  /** Winner username without @, or null while the draw is pending ("TBD") */
  username: string | null
}

export interface Raffle {
  id: string
  prizeName: string
  model: string
  category: string
  kind: PrizeKind
  /** Accent hue (0-360) used for the card gradient and illustration */
  hue: number
  marketPriceNaira: number
  /** Price of one entry in Naira. Raffs cost is derived from the live rate. */
  entryPriceNaira: number
  /** Pool the raffle is aiming for; entriesTarget = poolTargetNaira / entryPriceNaira */
  poolTargetNaira: number
  /** ISO timestamp of the draw moment (the deadline for entries) */
  deadline: string
  entriesCount: number
  entriesTarget: number
  description: string
  rules: string[]
  winners: WinnerSlot[]
  /** ISO timestamp once the draw has completed, otherwise null */
  drawnAt: string | null
  /** Demo entrants (usernames) used by the draw reveal */
  entrants: string[]
}

export interface Entry {
  id: string
  raffleId: string
  qty: number
  raffsSpent: number
  nairaValue: number
  rateId: string
  createdAt: string
}

export type TransactionType = 'purchase' | 'entry' | 'bonus' | 'prize' | 'refund'

export interface Transaction {
  id: string
  type: TransactionType
  /** Signed Raffs movement: positive = in, negative = out */
  raffs: number
  /** Naira amount where applicable (purchases, entry value), otherwise null */
  naira: number | null
  note: string
  createdAt: string
  status: 'completed' | 'failed'
}

export interface DeliveryAddress {
  street: string
  city: string
  state: string
  landmark: string
  phone: string
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

export interface Profile {
  id: string
  fullName: string
  username: string
  /** Normalised E.164 Nigerian number, e.g. +2348031234567 */
  phone: string
  /** True when the number came from Telegram's contact share, not typed in */
  phoneVerified: boolean
  email: string
  createdAt: string
  telegramId: number | null
  /** This user's own code, used in https://t.me/<bot>/app?startapp=ref_<code> */
  referralCode: string
  address: DeliveryAddress | null
  contactPrefs: ContactPrefs
  verification: Verification
}

export interface SignUpInput {
  fullName: string
  username: string
  /** Typed number. The mock API uses it; the real API ignores it in favour of contactProof. */
  phone: string
  email: string
  telegramId?: number | null
  /**
   * The signed `response` string Telegram returns from WebApp.requestContact.
   * The API verifies its hash with the bot token, so the phone in it is the
   * one Telegram holds for this account.
   */
  contactProof?: string
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
}
