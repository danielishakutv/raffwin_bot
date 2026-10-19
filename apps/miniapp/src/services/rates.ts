/**
 * The hourly Stars-per-Raff quote, as the UI sees it.
 *
 * Entries are priced in fixed Raffs (raffle.entryPriceRaffs); the quote only
 * prices buying Raffs, and gives the "about ₦…" display figures. The rule
 * itself (3% to 15% up or down from the base, every clock hour) lives in
 * @raffwin/shared so the demo and the API cannot disagree.
 *
 * The real API supplies live quotes (GET /v1/rate). The demo provider derives
 * the same kind of quote deterministically from the hour, so a reload inside
 * the hour shows the same rate and the expiry countdown stays truthful.
 */
import { hourlyQuote, hourStart, RATE_TTL_MS, roundRate, type RateQuote } from '@raffwin/shared'

export type { RateQuote }
export { RATE_TTL_MS }

export interface RateProvider {
  fetchRate(): Promise<RateQuote>
}

/** Demo base: 1 Raff = ₦10, the API's default (Settings > Rate and sales) */
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

/** Demo-only salt bumped by the "refresh rate" control so a new quote visibly differs. */
let demoSalt = 0
let demoWindowStart: number | null = null

export function bumpDemoRate(): void {
  demoSalt += 1
  demoWindowStart = Date.now()
}

/** Synchronous demo quote for a moment in time. */
export function demoQuoteAt(now: number = Date.now()): RateQuote {
  const windowStart = hourStart(now)
  const hourIndex = windowStart / RATE_TTL_MS
  const seed = hourIndex * 31 + demoSalt * 101
  const { value } = hourlyQuote(BASE_NAIRA_PER_RAFF, unitRandom(seed), unitRandom(seed * 7 + 1))
  return {
    id: `demo-${hourIndex}-${demoSalt}`,
    nairaPerRaff: roundRate(value),
    issuedAt: demoWindowStart && demoWindowStart >= windowStart ? demoWindowStart : windowStart,
    expiresAt: windowStart + RATE_TTL_MS,
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

export function setRateProvider(next: RateProvider): void {
  provider = next
}

export function getRateProvider(): RateProvider {
  return provider
}

/* ----------------------------------------------------------------------------
 * Conversion helpers - the only legal way to turn Naira and Raffs into each other
 * -------------------------------------------------------------------------- */

export function isRateValid(quote: RateQuote | null | undefined, now: number = Date.now()): quote is RateQuote {
  return !!quote && now >= quote.issuedAt && now < quote.expiresAt
}

/** Raffs received for a Naira amount (demo card purchases; rounds down in the house's favour). */
export function nairaToRaffs(naira: number, quote: RateQuote): number {
  return Math.max(0, Math.floor(naira / quote.nairaPerRaff))
}

/** About how many Naira a Raffs amount is worth at a quote. Display only. */
export function raffsToNaira(raffs: number, quote: RateQuote): number {
  return Math.round(raffs * quote.nairaPerRaff)
}
