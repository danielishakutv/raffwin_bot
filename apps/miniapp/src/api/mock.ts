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
  Page,
  ReferralEarning,
  ReferralSummary,
  ReferredPerson,
  ContactPrefs,
  Entry,
  KycInput,
  LiveSnapshot,
  Profile,
  Raffle,
  Transaction,
  VerificationStatus,
} from '@/data/types'
import { normalizeNigerianPhone } from '@raffwin/shared'
import { getTelegramUser } from '@/services/telegram'
import { TAKEN_USERNAMES, seedHistoryForUser } from '@/data/seed'
import { getRaffleStatus, isEnterable } from '@/data/raffleStatus'
import { getRateProvider, type RateQuote } from '@/services/rates'
import { referralLink } from '@raffwin/shared'
import { env } from '@/services/env'
import { loadDb, mutateDb, newId, resetDb } from './db'
import { ApiError } from './errors'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const jitter = (base: number, spread = 250) => delay(base + Math.random() * spread)

/** Deep-ish clone so the UI never holds references into the mock database. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * Like the real API there is no sign-up: the demo account is created on the
 * first boot from what Telegram knows (or a demo identity in a browser).
 */
function ensureProfile(): Profile {
  const db = loadDb()
  if (db.profile) return db.profile
  const tg = getTelegramUser()
  const now = Date.now()
  const profile: Profile = {
    id: newId('usr'),
    fullName: tg ? [tg.first_name, tg.last_name].filter(Boolean).join(' ') : 'Demo Player',
    username: tg?.username?.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'demo_player',
    phone: null,
    phoneVerified: false,
    email: null,
    createdAt: new Date(now).toISOString(),
    telegramId: tg?.id ?? null,
    referralCode: 'DEMO2345',
    delivery: null,
    kycComplete: false,
    isAdmin: false,
    contactPrefs: { whatsapp: true, telegram: true, email: false },
    verification: { status: 'unverified', idImage: null, selfieImage: null, submittedAt: null },
  }
  return mutateDb((d) => {
    d.profile = profile
    const seeded = seedHistoryForUser(profile, d.raffles, now)
    d.entries = seeded.entries
    d.transactions = seeded.transactions
    d.balance = seeded.balance
    return profile
  })
}

function requireProfile(): Profile {
  return ensureProfile()
}

/* ----------------------------------------------------------------------------
 * Boot / session
 * -------------------------------------------------------------------------- */

export async function getBootstrap(): Promise<Bootstrap> {
  await jitter(500)
  ensureProfile()
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

/** KYC in the demo: the phone is typed (there is no Telegram to share it), everything else as live. */
export async function saveKyc(input: KycInput): Promise<Profile> {
  await jitter(700, 300)
  requireProfile()
  const phone = input.phone ? normalizeNigerianPhone(input.phone) : null
  return clone(
    mutateDb((db) => {
      const p = db.profile as Profile
      if (!phone && !p.phone) throw new ApiError('PHONE_NOT_VERIFIED', 'Enter your phone number so the courier can call you.')
      p.fullName = input.fullName.trim()
      if (phone) p.phone = phone
      p.delivery = { state: input.state.trim(), city: input.city.trim(), motorPark: input.motorPark.trim() }
      p.kycComplete = true
      return p
    }),
  )
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
      if (patch.email !== undefined) p.email = patch.email?.trim().toLowerCase() ?? null
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

/** Same shape as the live API's snapshot, read from the demo database. */
export async function startAdminSignIn(): Promise<{ ok: boolean }> {
  throw new ApiError('NOT_READY', 'The demo has no admin.')
}

export async function getLive(): Promise<LiveSnapshot> {
  await jitter(80, 60)
  const db = loadDb()
  return {
    serverTime: Date.now(),
    balance: db.balance,
    raffles: db.raffles.map((r) => ({
      id: r.id,
      entriesCount: r.entriesCount,
      entriesTarget: r.entriesTarget,
      status: r.drawnAt ? 'drawn' : 'open',
      deadline: r.deadline,
      drawnAt: r.drawnAt,
      // Local demo data is never edited by an admin
      version: r.id,
    })),
  }
}

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
  /** One per confirmation tap: a retry with the same key never makes a second entry */
  idempotencyKey: string
  /** Price per entry the player confirmed; the API refuses if it has changed */
  priceRaffs?: number
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
  return clone(
    mutateDb((db) => {
      const raffle = db.raffles.find((r) => r.id === req.raffleId)
      if (!raffle) throw new ApiError('NOT_FOUND', 'That raffle no longer exists.')
      if (!isEnterable(raffle, now)) throw new ApiError('RAFFLE_CLOSED', 'Entries for this raffle have closed.')
      const qty = Math.max(1, Math.floor(req.qty))
      const raffsSpent = raffle.entryPriceRaffs * qty
      if (db.balance < raffsSpent) {
        throw new ApiError('INSUFFICIENT_FUNDS', `You need ${raffsSpent - db.balance} more Raffs for this entry.`)
      }
      db.balance -= raffsSpent
      const ticketFrom = raffle.entriesCount + 1
      raffle.entriesCount += qty
      const profile = db.profile as Profile
      if (!raffle.entrants.includes(profile.username)) raffle.entrants.push(profile.username)
      const entry: Entry = {
        id: newId('en'),
        raffleId: raffle.id,
        qty,
        raffsSpent,
        ticketFrom,
        ticketTo: raffle.entriesCount,
        createdAt: new Date(now).toISOString(),
      }
      const transaction: Transaction = {
        id: newId('tx'),
        type: 'entry',
        raffs: -raffsSpent,
        naira: null,
        stars: null,
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
            stars: null,
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
        stars: null,
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
        stars: null,
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

/* ----------------------------------------------------------------------------
 * Referrals (demo data: three invented friends)
 * -------------------------------------------------------------------------- */

const DEMO_FRIENDS = [
  { username: 'tunde_k', daysAgo: 9, entries: 4, raffsEarned: 20 },
  { username: 'amaka', daysAgo: 4, entries: 2, raffsEarned: 10 },
  { username: 'yusuf_b', daysAgo: 1, entries: 0, raffsEarned: 0 },
]

export async function getReferralSummary(): Promise<ReferralSummary> {
  await jitter(400)
  const profile = requireProfile()
  const lifetime = DEMO_FRIENDS.reduce((sum, f) => sum + f.raffsEarned, 0)
  return {
    code: profile.referralCode,
    link: referralLink(env.botUsername, profile.referralCode),
    peopleReferred: DEMO_FRIENDS.length,
    activeThisMonth: DEMO_FRIENDS.filter((f) => f.entries > 0).length,
    lifetimeRaffs: lifetime,
    monthRaffs: lifetime,
  }
}

export async function getReferredPeople(): Promise<Page<ReferredPerson>> {
  await jitter(400)
  requireProfile()
  const now = Date.now()
  return {
    items: DEMO_FRIENDS.map((f) => ({
      username: f.username,
      joinedAt: new Date(now - f.daysAgo * 86_400_000).toISOString(),
      entries: f.entries,
      raffsEarned: f.raffsEarned,
    })),
    nextCursor: null,
  }
}

export async function getReferralEarnings(): Promise<Page<ReferralEarning>> {
  await jitter(400)
  requireProfile()
  const now = Date.now()
  const items: ReferralEarning[] = DEMO_FRIENDS.flatMap((f, i) =>
    Array.from({ length: f.entries }, (_, n) => ({
      id: `re-demo-${i}-${n}`,
      createdAt: new Date(now - (f.daysAgo - n * 0.5) * 86_400_000).toISOString(),
      username: f.username,
      raffleName: n % 2 ? 'Oraimo FreePods 4' : 'Samsung Galaxy A15',
      entryRaffs: 50,
      earnedRaffs: 5,
    })),
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { items, nextCursor: null }
}
