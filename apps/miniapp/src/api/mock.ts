/**
 * Mock API layer.
 *
 * Every function here mimics a real async endpoint: it takes a request shape,
 * waits a little so loading states are visible, and resolves with a response
 * shape (or rejects with an ApiError). The store only ever talks to these
 * functions, so swapping in a real backend means re-implementing this file
 * with fetch() calls and keeping the signatures.
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
  VerificationStatus,
} from '@/data/types'
import { TAKEN_USERNAMES, seedHistoryForUser } from '@/data/seed'
import { getRaffleStatus, isEnterable } from '@/data/raffleStatus'
import { demoQuoteAt, entryCostRaffs, getRateProvider, isRateValid, type RateQuote } from '@/services/rates'
import { loadDb, mutateDb, newId, resetDb } from './db'
import { ApiError } from './errors'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const jitter = (base: number, spread = 250) => delay(base + Math.random() * spread)

/** Deep-ish clone so the UI never holds references into the mock database. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function requireProfile(): Profile {
  const db = loadDb()
  if (!db.profile) throw new ApiError('NOT_SIGNED_IN', 'Create your account first.')
  return db.profile
}

/* ----------------------------------------------------------------------------
 * Boot / session
 * -------------------------------------------------------------------------- */

export async function getBootstrap(): Promise<Bootstrap> {
  await jitter(500)
  const db = loadDb()
  return clone({
    profile: db.profile,
    onboardingComplete: db.onboardingComplete,
    balance: db.balance,
    raffles: db.raffles,
    entries: db.entries,
    transactions: db.transactions,
  })
}

export async function resetDemo(): Promise<Bootstrap> {
  await jitter(400)
  resetDb()
  return getBootstrap()
}

export async function signOut(): Promise<void> {
  await jitter(300)
  resetDb()
}

/* ----------------------------------------------------------------------------
 * Auth / profile
 * -------------------------------------------------------------------------- */

export async function checkUsername(username: string): Promise<{ available: boolean }> {
  await jitter(350, 350)
  const u = username.trim().toLowerCase()
  const taken = (TAKEN_USERNAMES as readonly string[]).includes(u)
  return { available: !taken }
}

export async function signUp(input: SignUpInput): Promise<Bootstrap> {
  await jitter(900, 400)
  const username = input.username.trim().toLowerCase()
  if ((TAKEN_USERNAMES as readonly string[]).includes(username)) {
    throw new ApiError('USERNAME_TAKEN', 'That username is already taken.')
  }
  const now = Date.now()
  const profile: Profile = {
    id: newId('usr'),
    fullName: input.fullName.trim(),
    username,
    phone: input.phone,
    phoneVerified: false,
    email: input.email.trim().toLowerCase(),
    createdAt: new Date(now).toISOString(),
    telegramId: input.telegramId ?? null,
    referralCode: 'DEMO2345',
    address: null,
    contactPrefs: { whatsapp: true, telegram: true, email: false },
    verification: { status: 'unverified', idImage: null, selfieImage: null, submittedAt: null },
  }
  mutateDb((db) => {
    db.profile = profile
    const seeded = seedHistoryForUser(profile, db.raffles, now)
    db.entries = seeded.entries
    db.transactions = seeded.transactions
    db.balance = seeded.balance
  })
  return getBootstrap()
}

export async function completeOnboarding(): Promise<{ onboardingComplete: boolean }> {
  await jitter(300)
  requireProfile()
  mutateDb((db) => {
    db.onboardingComplete = true
  })
  return { onboardingComplete: true }
}

export async function getProfile(): Promise<Profile> {
  await jitter(300)
  return clone(requireProfile())
}

export async function updateProfile(
  patch: Partial<Pick<Profile, 'fullName' | 'phone' | 'email' | 'username'>>,
): Promise<Profile> {
  await jitter(600, 300)
  requireProfile()
  return clone(
    mutateDb((db) => {
      const p = db.profile as Profile
      if (patch.fullName !== undefined) p.fullName = patch.fullName.trim()
      if (patch.phone !== undefined) p.phone = patch.phone
      if (patch.email !== undefined) p.email = patch.email.trim().toLowerCase()
      if (patch.username !== undefined) {
        const u = patch.username.trim().toLowerCase()
        if (u !== p.username && (TAKEN_USERNAMES as readonly string[]).includes(u)) {
          throw new ApiError('USERNAME_TAKEN', 'That username is already taken.')
        }
        p.username = u
      }
      return p
    }),
  )
}

export async function updateAddress(address: DeliveryAddress): Promise<Profile> {
  await jitter(600, 300)
  requireProfile()
  return clone(
    mutateDb((db) => {
      const p = db.profile as Profile
      p.address = { ...address }
      return p
    }),
  )
}

export async function updateContactPrefs(prefs: ContactPrefs): Promise<Profile> {
  await jitter(250)
  requireProfile()
  return clone(
    mutateDb((db) => {
      const p = db.profile as Profile
      p.contactPrefs = { ...prefs }
      return p
    }),
  )
}

export async function submitVerification(input: {
  idImage: string
  selfieImage: string
}): Promise<Profile> {
  await jitter(1200, 400)
  requireProfile()
  return clone(
    mutateDb((db) => {
      const p = db.profile as Profile
      p.verification = {
        status: 'pending',
        idImage: input.idImage,
        selfieImage: input.selfieImage,
        submittedAt: new Date().toISOString(),
      }
      return p
    }),
  )
}

/** Demo control only: flips the review outcome so the "Verified" state can be shown. */
export async function setVerificationStatus(status: VerificationStatus): Promise<Profile> {
  await jitter(300)
  requireProfile()
  return clone(
    mutateDb((db) => {
      const p = db.profile as Profile
      p.verification.status = status
      if (status === 'unverified') {
        p.verification.idImage = null
        p.verification.selfieImage = null
        p.verification.submittedAt = null
      }
      return p
    }),
  )
}

/* ----------------------------------------------------------------------------
 * Rates
 * -------------------------------------------------------------------------- */

export async function getRate(): Promise<RateQuote> {
  return getRateProvider().fetchRate()
}

/* ----------------------------------------------------------------------------
 * Raffles
 * -------------------------------------------------------------------------- */

export async function getRaffles(): Promise<Raffle[]> {
  await jitter(400)
  return clone(loadDb().raffles)
}

export async function getRaffle(id: string): Promise<Raffle> {
  await jitter(300)
  const raffle = loadDb().raffles.find((r) => r.id === id)
  if (!raffle) throw new ApiError('NOT_FOUND', 'That raffle no longer exists.')
  return clone(raffle)
}

export interface EnterRaffleRequest {
  raffleId: string
  qty: number
  /** The quote the user saw. The server re-prices with its own current quote. */
  rateId: string
}

export interface EnterRaffleResponse {
  entry: Entry
  raffle: Raffle
  balance: number
  transaction: Transaction
}

export async function enterRaffle(req: EnterRaffleRequest): Promise<EnterRaffleResponse> {
  await jitter(900, 500)
  requireProfile()
  const now = Date.now()
  const quote = demoQuoteAt(now)
  if (!isRateValid(quote, now) || quote.id !== req.rateId) {
    throw new ApiError('RATE_EXPIRED', 'The rate has refreshed. Check the new price and try again.')
  }
  return clone(
    mutateDb((db) => {
      const raffle = db.raffles.find((r) => r.id === req.raffleId)
      if (!raffle) throw new ApiError('NOT_FOUND', 'That raffle no longer exists.')
      if (!isEnterable(raffle, now)) throw new ApiError('RAFFLE_CLOSED', 'Entries for this raffle have closed.')
      const qty = Math.max(1, Math.floor(req.qty))
      const unitRaffs = entryCostRaffs(raffle.entryPriceNaira, quote)
      const raffsSpent = unitRaffs * qty
      if (db.balance < raffsSpent) {
        throw new ApiError('INSUFFICIENT_FUNDS', `You need ${raffsSpent - db.balance} more Raffs for this entry.`)
      }
      db.balance -= raffsSpent
      raffle.entriesCount += qty
      const profile = db.profile as Profile
      if (!raffle.entrants.includes(profile.username)) raffle.entrants.push(profile.username)
      const entry: Entry = {
        id: newId('en'),
        raffleId: raffle.id,
        qty,
        raffsSpent,
        nairaValue: raffle.entryPriceNaira * qty,
        rateId: quote.id,
        createdAt: new Date(now).toISOString(),
      }
      const transaction: Transaction = {
        id: newId('tx'),
        type: 'entry',
        raffs: -raffsSpent,
        naira: entry.nairaValue,
        note: `Entry: ${raffle.prizeName} x${qty}`,
        createdAt: entry.createdAt,
        status: 'completed',
      }
      db.entries.unshift(entry)
      db.transactions.unshift(transaction)
      return { entry, raffle, balance: db.balance, transaction }
    }),
  )
}

/**
 * Runs the draw for a raffle whose deadline has passed. Demo rule: winners are
 * picked at random from the entrants; if the signed-in user entered, they are
 * guaranteed one of the three slots so the win flow can be demonstrated.
 * Raffs-credit prizes are paid into the balance immediately.
 */
export async function drawRaffle(raffleId: string): Promise<{ raffle: Raffle; balance: number; youWon: boolean }> {
  await jitter(600, 300)
  const now = Date.now()
  return clone(
    mutateDb((db) => {
      const raffle = db.raffles.find((r) => r.id === raffleId)
      if (!raffle) throw new ApiError('NOT_FOUND', 'That raffle no longer exists.')
      if (raffle.drawnAt) throw new ApiError('ALREADY_DRAWN', 'This raffle has already been drawn.')
      if (getRaffleStatus(raffle, now) !== 'drawing') throw new ApiError('NOT_READY', 'The deadline has not passed yet.')

      const me = db.profile?.username ?? null
      const iEntered = !!me && db.entries.some((e) => e.raffleId === raffle.id)
      const pool = raffle.entrants.filter((u) => u !== me)
      for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[pool[i], pool[j]] = [pool[j], pool[i]]
      }
      const picked = pool.slice(0, 3)
      if (iEntered && me) picked.splice(Math.floor(Math.random() * 3), 0, me)
      raffle.winners.forEach((slot, i) => {
        slot.username = picked[i] ?? pool[i] ?? null
      })
      raffle.drawnAt = new Date(now).toISOString()

      let youWon = false
      if (me) {
        const mySlot = raffle.winners.find((w) => w.username === me)
        if (mySlot) {
          youWon = true
          const credit = /([\d,]+)\s*Raffs credit/i.exec(mySlot.prizeItem)
          const raffs = credit ? Number(credit[1].replace(/,/g, '')) : 0
          db.transactions.unshift({
            id: newId('tx'),
            type: 'prize',
            raffs,
            naira: null,
            note: `${['1st', '2nd', '3rd'][mySlot.position - 1]} place prize: ${raffle.prizeName} raffle`,
            createdAt: raffle.drawnAt,
            status: 'completed',
          })
          db.balance += raffs
        }
      }
      return { raffle, balance: db.balance, youWon }
    }),
  )
}

/* ----------------------------------------------------------------------------
 * Wallet
 * -------------------------------------------------------------------------- */

export interface BuyRaffsRequest {
  packageId: string
  naira: number
  raffs: number
  feeNaira: number
  rateId: string
  /** Demo switch to exercise the failure path. Never exists in the real API. */
  simulateFailure?: boolean
}

export interface BuyRaffsResponse {
  balance: number
  transaction: Transaction
}

export async function buyRaffs(req: BuyRaffsRequest): Promise<BuyRaffsResponse> {
  await jitter(1800, 600)
  requireProfile()
  if (req.simulateFailure) {
    mutateDb((db) => {
      db.transactions.unshift({
        id: newId('tx'),
        type: 'purchase',
        raffs: 0,
        naira: req.naira + req.feeNaira,
        note: `Card payment declined (demo)`,
        createdAt: new Date().toISOString(),
        status: 'failed',
      })
    })
    throw new ApiError('PAYMENT_DECLINED', 'The demo bank declined this card. Try again or use another card.')
  }
  return clone(
    mutateDb((db) => {
      db.balance += req.raffs
      const transaction: Transaction = {
        id: newId('tx'),
        type: 'purchase',
        raffs: req.raffs,
        naira: req.naira + req.feeNaira,
        note: `Bought Raffs (demo card)`,
        createdAt: new Date().toISOString(),
        status: 'completed',
      }
      db.transactions.unshift(transaction)
      return { balance: db.balance, transaction }
    }),
  )
}

export async function getTransactions(): Promise<Transaction[]> {
  await jitter(300)
  return clone(loadDb().transactions)
}

export async function getEntries(): Promise<Entry[]> {
  await jitter(300)
  return clone(loadDb().entries)
}
