/**
 * Demo seed data. Every name, number and timestamp here is invented.
 * Deadlines are relative to the moment the demo database is (re)seeded so the
 * countdowns are always live: one raffle closes in under an hour (urgent
 * pulse), one is "drawing now", two are already drawn with past winners.
 */
import type { Raffle, Transaction, Entry, Profile } from './types'
import { BASE_NAIRA_PER_RAFF } from '@/services/rates'

/** Usernames that already exist in the demo (used by the live "available" check). */
export const TAKEN_USERNAMES = [
  'admin',
  'raffle',
  'raffwin',
  'support',
  'ada_obi',
  'tunde_k',
  'chidi',
  'amaka',
  'yusuf_b',
  'ngozi',
  'emeka',
  'bola_a',
  'kemi',
  'segun',
  'fatima',
  'ibrahim',
  'uche',
  'test',
] as const

/** Pool of demo entrants used for winner reveals. */
export const DEMO_ENTRANTS = [
  'ada_obi',
  'tunde_k',
  'chidi',
  'amaka',
  'yusuf_b',
  'ngozi',
  'emeka',
  'bola_a',
  'kemi',
  'segun',
  'fatima',
  'ibrahim',
  'uche',
  'zainab',
  'femi_o',
  'precious',
  'musa',
  'chioma',
  'dayo',
  'halima',
  'ebuka',
  'tope',
  'nneka',
  'kola',
]

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const commonRules = [
  'One draw per raffle. Three winners are selected: 1st, 2nd and 3rd place.',
  'Entries close at the deadline shown. Entries after the deadline are not possible.',
  'Each entry is one ticket in the draw. More entries, more tickets.',
  'Winners are contacted on Telegram and must confirm within 7 days.',
  'Prize delivery requires a verified identity and a delivery address.',
]

function pick(from: string[], count: number, offset: number): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i += 1) out.push(from[(offset + i * 5) % from.length])
  return out
}

/** Builds the raffle list relative to `now`. */
export function seedRaffles(now: number): Raffle[] {
  const at = (ms: number) => new Date(now + ms).toISOString()
  // Demo raffles are written in Naira (easier to read) and priced in fixed Raffs
  // at the demo base of BASE_NAIRA_PER_RAFF, exactly like the real API prices them.
  const r = (
    partial: Omit<Raffle, 'entriesTarget' | 'rules' | 'entrants' | 'winners' | 'entryPriceRaffs' | 'seedCommitment'> & {
      entryPriceNaira: number
      poolTargetNaira: number
      winners: [string, string, string]
      winnerNames?: [string | null, string | null, string | null]
      rules?: string[]
      entrantsOffset?: number
    },
  ): Raffle => {
    const {
      winners,
      winnerNames = [null, null, null],
      rules = [],
      entrantsOffset = 0,
      entryPriceNaira,
      poolTargetNaira,
      ...rest
    } = partial
    return {
      ...rest,
      entryPriceRaffs: Math.ceil(entryPriceNaira / BASE_NAIRA_PER_RAFF),
      seedCommitment: null,
      entriesTarget: Math.round(poolTargetNaira / entryPriceNaira),
      rules: [...rules, ...commonRules],
      entrants: pick(DEMO_ENTRANTS, 14, entrantsOffset),
      winners: [
        { position: 1, prizeItem: winners[0], username: winnerNames[0] },
        { position: 2, prizeItem: winners[1], username: winnerNames[1] },
        { position: 3, prizeItem: winners[2], username: winnerNames[2] },
      ],
    }
  }

  return [
    r({
      id: 'rf-galaxy-a15',
      prizeName: 'Samsung Galaxy A15',
      model: 'Galaxy A15 5G, 8GB RAM, 256GB',
      category: 'Phones',
      kind: 'phone',
      hue: 265,
      marketPriceNaira: 185000,
      entryPriceNaira: 500,
      poolTargetNaira: 250000,
      deadline: at(42 * 60 * 1000),
      entriesCount: 412,
      description:
        'A big, bright 6.5-inch Super AMOLED screen, 50MP camera and a two-day battery. Brand new, sealed, with a one-year warranty.',
      drawnAt: null,
      winners: ['Samsung Galaxy A15 5G', '₦20,000 airtime', '500 Raffs credit'],
      rules: ['Closes in under an hour. The draw runs the moment the countdown hits zero.'],
      entrantsOffset: 0,
    }),
    r({
      id: 'rf-oraimo-freepods',
      prizeName: 'Oraimo FreePods 4',
      model: 'FreePods 4 ANC, wireless charging case',
      category: 'Audio',
      kind: 'earbuds',
      hue: 160,
      marketPriceNaira: 28500,
      entryPriceNaira: 100,
      poolTargetNaira: 40000,
      deadline: at(18 * HOUR),
      entriesCount: 288,
      description:
        'Active noise cancelling, 35 hours of playtime with the case and a fit that stays put on the go.',
      drawnAt: null,
      winners: ['Oraimo FreePods 4', '₦5,000 airtime', '200 Raffs credit'],
      entrantsOffset: 3,
    }),
    r({
      id: 'rf-hp-15',
      prizeName: 'HP 15 Laptop',
      model: 'HP 15, Intel Core i5 12th Gen, 16GB RAM, 512GB SSD',
      category: 'Laptops',
      kind: 'laptop',
      hue: 220,
      marketPriceNaira: 520000,
      entryPriceNaira: 1000,
      poolTargetNaira: 650000,
      deadline: at(2 * DAY + 6 * HOUR),
      entriesCount: 230,
      description:
        'A fast everyday laptop for school, work and side hustles. 15.6-inch FHD display, backlit keyboard and all-day battery.',
      drawnAt: null,
      winners: ['HP 15 Laptop', 'Oraimo 27,000mAh power bank', '1,000 Raffs credit'],
      entrantsOffset: 6,
    }),
    r({
      id: 'rf-oraimo-powerbank',
      prizeName: 'Oraimo 27,000mAh Power Bank',
      model: 'Oraimo Traveler 4 Plus, 22.5W fast charge',
      category: 'Accessories',
      kind: 'powerbank',
      hue: 35,
      marketPriceNaira: 24000,
      entryPriceNaira: 100,
      poolTargetNaira: 35000,
      deadline: at(3 * DAY + 12 * HOUR),
      entriesCount: 60,
      description:
        'Charge a phone six times over. Three devices at once, fast charging in and out, and an LED display that shows real numbers.',
      drawnAt: null,
      winners: ['Oraimo 27,000mAh Power Bank', '₦5,000 airtime', '150 Raffs credit'],
      entrantsOffset: 9,
    }),
    r({
      id: 'rf-hisense-tv',
      prizeName: 'Hisense 43" Smart TV',
      model: 'Hisense 43A6K, 4K UHD, VIDAA smart TV',
      category: 'Home',
      kind: 'tv',
      hue: 300,
      marketPriceNaira: 245000,
      entryPriceNaira: 500,
      poolTargetNaira: 300000,
      deadline: at(5 * DAY + 3 * HOUR),
      entriesCount: 97,
      description:
        '4K picture, Dolby Vision, built-in Netflix and YouTube, and a remote with a voice button. Delivered and installed.',
      drawnAt: null,
      winners: ['Hisense 43" Smart TV', '₦25,000 airtime', '500 Raffs credit'],
      entrantsOffset: 12,
    }),
    r({
      id: 'rf-cash-100k',
      prizeName: '₦100,000 Cash Voucher',
      model: 'Instant bank transfer voucher',
      category: 'Cash',
      kind: 'voucher',
      hue: 48,
      marketPriceNaira: 100000,
      entryPriceNaira: 200,
      poolTargetNaira: 150000,
      deadline: at(7 * DAY),
      entriesCount: 150,
      description:
        'Straight to your bank account within 24 hours of confirming your details. No strings, no delivery to wait for.',
      drawnAt: null,
      winners: ['₦100,000 cash voucher', '₦20,000 cash voucher', '₦5,000 cash voucher'],
      entrantsOffset: 15,
    }),
    r({
      id: 'rf-infinix-hot50',
      prizeName: 'Infinix Hot 50',
      model: 'Infinix Hot 50 4G, 8GB RAM, 256GB',
      category: 'Phones',
      kind: 'phone',
      hue: 190,
      marketPriceNaira: 165000,
      entryPriceNaira: 300,
      poolTargetNaira: 150000,
      deadline: at(-3 * 60 * 1000),
      entriesCount: 500,
      description: 'Slim, fast and good-looking, with a 120Hz screen and a 5,000mAh battery.',
      drawnAt: null,
      winners: ['Infinix Hot 50', '₦15,000 airtime', '300 Raffs credit'],
      entrantsOffset: 18,
    }),
    r({
      id: 'rf-ps5-slim',
      prizeName: 'PlayStation 5 Slim',
      model: 'PS5 Slim Disc Edition, 1TB, extra DualSense',
      category: 'Gaming',
      kind: 'console',
      hue: 240,
      marketPriceNaira: 890000,
      entryPriceNaira: 2000,
      poolTargetNaira: 1000000,
      deadline: at(-3 * DAY),
      entriesCount: 500,
      description: 'The full next-gen setup with a second controller and a year of PlayStation Plus.',
      drawnAt: at(-3 * DAY + 2 * 60 * 1000),
      winners: ['PlayStation 5 Slim', '₦50,000 airtime', '2,000 Raffs credit'],
      winnerNames: ['ada_obi', 'segun', 'fatima'],
      entrantsOffset: 2,
    }),
    r({
      id: 'rf-tecno-spark30',
      prizeName: 'Tecno Spark 30',
      model: 'Tecno Spark 30, 8GB RAM, 128GB',
      category: 'Phones',
      kind: 'phone',
      hue: 20,
      marketPriceNaira: 142000,
      entryPriceNaira: 200,
      poolTargetNaira: 120000,
      deadline: at(-9 * DAY),
      entriesCount: 600,
      description: 'Big battery, bright screen and a 64MP camera for the price of a weekend out.',
      drawnAt: at(-9 * DAY + 60 * 1000),
      winners: ['Tecno Spark 30', '₦15,000 airtime', '1,000 Raffs credit'],
      winnerNames: ['tunde_k', 'ngozi', 'kemi'],
      entrantsOffset: 7,
    }),
  ]
}

/**
 * Demo history created for a brand-new account so the dashboard, history,
 * entries and wins screens have something to show. Clearly labelled as seed.
 */
export function seedHistoryForUser(profile: Profile, raffles: Raffle[], now: number) {
  const at = (ms: number) => new Date(now + ms).toISOString()
  const tecno = raffles.find((x) => x.id === 'rf-tecno-spark30')
  const infinix = raffles.find((x) => x.id === 'rf-infinix-hot50')
  const entries: Entry[] = []
  const transactions: Transaction[] = []

  transactions.push({
    id: 'tx-welcome',
    type: 'bonus',
    raffs: 500,
    naira: null,
    stars: null,
    note: 'Welcome bonus (demo seed)',
    createdAt: at(-10 * DAY),
    status: 'completed',
  })

  if (tecno) {
    const cost = tecno.entryPriceRaffs
    entries.push({
      id: 'en-seed-tecno',
      raffleId: tecno.id,
      qty: 1,
      raffsSpent: cost,
      ticketFrom: tecno.entriesCount,
      ticketTo: tecno.entriesCount,
      createdAt: at(-10 * DAY + 2 * HOUR),
    })
    transactions.push({
      id: 'tx-seed-tecno-entry',
      type: 'entry',
      raffs: -cost,
      naira: null,
      stars: null,
      note: `Entry: ${tecno.prizeName} x1 (demo seed)`,
      createdAt: at(-10 * DAY + 2 * HOUR),
      status: 'completed',
    })
    // The new account came 3rd in this past draw (demo seed)
    tecno.winners[2].username = profile.username
    transactions.push({
      id: 'tx-seed-tecno-prize',
      type: 'prize',
      raffs: 1000,
      naira: null,
      stars: null,
      note: `3rd place prize: ${tecno.prizeName} raffle (demo seed)`,
      createdAt: tecno.drawnAt ?? at(-9 * DAY),
      status: 'completed',
    })
  }

  if (infinix) {
    const cost = infinix.entryPriceRaffs
    entries.push({
      id: 'en-seed-infinix',
      raffleId: infinix.id,
      qty: 2,
      raffsSpent: cost * 2,
      ticketFrom: infinix.entriesCount - 1,
      ticketTo: infinix.entriesCount,
      createdAt: at(-1 * DAY),
    })
    transactions.push({
      id: 'tx-seed-infinix-entry',
      type: 'entry',
      raffs: -cost * 2,
      naira: null,
      stars: null,
      note: `Entry: ${infinix.prizeName} x2 (demo seed)`,
      createdAt: at(-1 * DAY),
      status: 'completed',
    })
    if (!infinix.entrants.includes(profile.username)) infinix.entrants.push(profile.username)
  }

  const balance = transactions.reduce((sum, t) => sum + t.raffs, 0)
  return { entries, transactions, balance }
}
