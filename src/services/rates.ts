/**
 * Naira <-> Raffs rate service.
 *
 * This is THE one place that knows how Naira converts to Raffs. Every Raffs
 * figure in the UI is derived from a RateQuote through the helpers below;
 * nothing else in the app may hard-code a conversion.
 *
 * Convention: the quote is expressed as **Naira per 1 Raff** (nairaPerRaff).
 *
 * A quote is valid for exactly one hour. The demo provider aligns quotes to
 * the clock hour and derives a deterministic +/-3-5% fluctuation around the
 * base rate from the hour index, so reloading the page inside the same hour
 * shows the same rate and the expiry countdown stays truthful.
 *
 * To plug in the real conversion table later, implement RateProvider against
 * the real endpoint and call setRateProvider(...) on boot.
 */

export interface RateQuote {
  id: string
  /** How many Naira one Raff costs for the life of this quote */
  nairaPerRaff: number
  /** Epoch ms when the quote became valid */
  issuedAt: number
  /** Epoch ms when the quote stops being valid (issuedAt + 1 hour) */
  expiresAt: number
  source: 'demo' | 'live'
}

export interface RateProvider {
  fetchRate(): Promise<RateQuote>
}

export const RATE_TTL_MS = 60 * 60 * 1000
export const BASE_NAIRA_PER_RAFF = 10

/* ----------------------------------------------------------------------------
 * Demo provider
 * -------------------------------------------------------------------------- */

/** Small deterministic hash -> [0, 1) so the same hour always yields the same rate. */
function unitRandom(seed: number): number {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

/** +/- 3% to 5% fluctuation, sign and magnitude both derived from the seed. */
function fluctuation(seed: number): number {
  const magnitude = 0.03 + unitRandom(seed) * 0.02
  const sign = unitRandom(seed * 7 + 1) < 0.5 ? -1 : 1
  return sign * magnitude
}

/** Demo-only salt bumped by the "refresh rate" control so a new quote visibly differs. */
let demoSalt = 0
let demoWindowStart: number | null = null

export function bumpDemoRate(): void {
  demoSalt += 1
  demoWindowStart = Date.now()
}

/** Synchronous quote for a moment in time; used by the mock API to price entries server-side. */
export function demoQuoteAt(now: number = Date.now()): RateQuote {
  const hourIndex = Math.floor(now / RATE_TTL_MS)
  const windowStart = hourIndex * RATE_TTL_MS
  const windowEnd = windowStart + RATE_TTL_MS
  const issuedAt = demoWindowStart && demoWindowStart >= windowStart ? demoWindowStart : windowStart
  const value = BASE_NAIRA_PER_RAFF * (1 + fluctuation(hourIndex * 31 + demoSalt * 101))
  return {
    id: `demo-${hourIndex}-${demoSalt}`,
    nairaPerRaff: Math.round(value * 100) / 100,
    issuedAt,
    expiresAt: windowEnd,
    source: 'demo',
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const demoRateProvider: RateProvider = {
  async fetchRate() {
    await wait(700 + Math.random() * 600)
    return demoQuoteAt()
  },
}

let provider: RateProvider = demoRateProvider

/** Swap in the real rate provider when the backend exists. */
export function setRateProvider(next: RateProvider): void {
  provider = next
}

export function getRateProvider(): RateProvider {
  return provider
}

/* ----------------------------------------------------------------------------
 * Conversion helpers - the only legal way to turn Naira into Raffs
 * -------------------------------------------------------------------------- */

export function isRateValid(quote: RateQuote | null | undefined, now: number = Date.now()): quote is RateQuote {
  return !!quote && now >= quote.issuedAt && now < quote.expiresAt
}

/** Raffs received for a Naira amount (purchases round down in the house's favour). */
export function nairaToRaffs(naira: number, quote: RateQuote): number {
  return Math.max(0, Math.floor(naira / quote.nairaPerRaff))
}

/** Raffs cost of one raffle entry priced in Naira (rounds up). */
export function entryCostRaffs(entryPriceNaira: number, quote: RateQuote): number {
  return Math.max(1, Math.ceil(entryPriceNaira / quote.nairaPerRaff))
}

/** Naira value of a Raffs amount at a given quote. */
export function raffsToNaira(raffs: number, quote: RateQuote): number {
  return Math.round(raffs * quote.nairaPerRaff)
}
