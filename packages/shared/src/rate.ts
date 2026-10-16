/**
 * Stars-per-Raff rate rules (docs/ARCHITECTURE.md section 6).
 *
 * An admin sets a base. Each clock hour gets one quote: a magnitude between
 * 3% and 15% and a random sign, applied to the base. Always from the base,
 * never from the previous hour, so a quote stays within 85% to 115% of base.
 */

export const RATE_TTL_MS = 60 * 60 * 1000
export const RATE_MOVE_MIN = 0.03
export const RATE_MOVE_MAX = 0.15

/** Rates are stored and compared at this precision. */
export const RATE_DECIMALS = 6

export function roundRate(value: number): number {
  const f = 10 ** RATE_DECIMALS
  return Math.round(value * f) / f
}

/**
 * The hourly quote for a base, given two uniform random numbers in [0, 1):
 * one picks the size of the move, the other its direction. The caller
 * supplies the randomness (a CSPRNG on the server, a seeded hash in the demo).
 */
export function hourlyQuote(base: number, magnitudeUnit: number, signUnit: number): { value: number; move: number } {
  if (!(base > 0)) throw new Error(`rate base must be positive, got ${base}`)
  const u = Math.min(Math.max(magnitudeUnit, 0), 1)
  const magnitude = RATE_MOVE_MIN + u * (RATE_MOVE_MAX - RATE_MOVE_MIN)
  const move = signUnit < 0.5 ? -magnitude : magnitude
  return { value: roundRate(base * (1 + move)), move: roundRate(move) }
}

/** Start of the clock hour containing `ms`, in epoch ms (hours are UTC-aligned; Lagos is UTC+1, no DST). */
export function hourStart(ms: number): number {
  return Math.floor(ms / RATE_TTL_MS) * RATE_TTL_MS
}

/** Raffs bought with a number of Stars at a quote; rounds down in the house's favour. */
export function raffsForStars(stars: number, starsPerRaff: number): number {
  if (!(stars > 0) || !(starsPerRaff > 0)) return 0
  // A tiny epsilon stops 100 / 0.5 landing on 199.99999999 because of float error
  return Math.floor(stars / starsPerRaff + 1e-9)
}
