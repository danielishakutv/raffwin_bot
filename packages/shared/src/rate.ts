/**
 * The price of a Raff in naira (docs/ARCHITECTURE.md section 6).
 *
 * An admin sets a base and a movement range (3% to 15% unless changed). Each
 * clock hour gets one quote: a magnitude inside the range and a random sign,
 * applied to the base. Always from the base, never from the previous hour, so
 * with the default range a quote stays within 85% to 115% of base.
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
export function hourlyQuote(
  base: number,
  magnitudeUnit: number,
  signUnit: number,
  range: { min: number; max: number } = { min: RATE_MOVE_MIN, max: RATE_MOVE_MAX },
): { value: number; move: number } {
  if (!(base > 0)) throw new Error(`rate base must be positive, got ${base}`)
  if (!(range.min >= 0 && range.max >= range.min && range.max < 1)) throw new Error(`bad rate move range ${range.min}..${range.max}`)
  const u = Math.min(Math.max(magnitudeUnit, 0), 1)
  const magnitude = range.min + u * (range.max - range.min)
  const move = signUnit < 0.5 ? -magnitude : magnitude
  return { value: roundRate(base * (1 + move)), move: roundRate(move) }
}

/** Start of the clock hour containing `ms`, in epoch ms (hours are UTC-aligned; Lagos is UTC+1, no DST). */
export function hourStart(ms: number): number {
  return Math.floor(ms / RATE_TTL_MS) * RATE_TTL_MS
}

