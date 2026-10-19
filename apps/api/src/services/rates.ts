/**
 * The hourly naira price of a Raff. The first request in a clock hour issues
 * it from the admin's base and movement range with CSPRNG randomness; the
 * unique index on hour_start makes every concurrent issuer end up with the
 * same row. A purchase is credited at the quote the buyer was shown, which
 * the relay names by id (services/purchases.ts).
 */
import { randomInt } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { hourlyQuote, hourStart, RATE_TTL_MS, type RateQuote } from '@raffwin/shared'
import type { Db } from '../db/client'
import { rateQuotes } from '../db/schema'
import { getSetting } from './settings'

const MICRO = 1_000_000

/** Uniform in [0, 1) from the OS CSPRNG. */
function secureUnit(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32
}

type QuoteRow = typeof rateQuotes.$inferSelect

export function toRateQuote(row: QuoteRow): RateQuote {
  return {
    id: row.id,
    nairaPerRaff: row.nairaPerRaffKobo / 100,
    issuedAt: row.hourStart.getTime(),
    expiresAt: row.expiresAt.getTime(),
    source: 'live',
  }
}

export async function currentQuote(db: Db, now: number): Promise<QuoteRow> {
  const start = new Date(hourStart(now))
  const [existing] = await db.select().from(rateQuotes).where(eq(rateQuotes.hourStart, start))
  if (existing) return existing

  const baseKobo = await getSetting(db, 'rate.base_naira_per_raff_kobo')
  const minPct = await getSetting(db, 'rate.move_min_pct')
  const maxPct = await getSetting(db, 'rate.move_max_pct')
  const range = { min: Math.min(minPct, maxPct) / 100, max: Math.max(minPct, maxPct) / 100 }
  const { value, move } = hourlyQuote(baseKobo, secureUnit(), secureUnit(), range)
  await db
    .insert(rateQuotes)
    .values({
      hourStart: start,
      expiresAt: new Date(start.getTime() + RATE_TTL_MS),
      moveMicro: Math.round(move * MICRO),
      nairaPerRaffKobo: Math.max(1, Math.round(value)),
      baseNairaPerRaffKobo: baseKobo,
    })
    .onConflictDoNothing({ target: rateQuotes.hourStart })
  const [row] = await db.select().from(rateQuotes).where(eq(rateQuotes.hourStart, start))
  if (!row) throw new Error(`rate quote for ${start.toISOString()} missing after insert`)
  return row
}
