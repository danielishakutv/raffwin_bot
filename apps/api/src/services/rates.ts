/**
 * The hourly Stars-per-Raff quote. The first request in a clock hour issues
 * it from the current base with CSPRNG randomness; the unique index on
 * hour_start makes every concurrent issuer end up with the same row.
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
    starsPerRaff: row.starsPerRaffMicro / MICRO,
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

  const baseMicro = await getSetting(db, 'rate.base_stars_per_raff_micro')
  const nairaPerStar = await getSetting(db, 'rate.naira_per_star')
  const { value, move } = hourlyQuote(baseMicro / MICRO, secureUnit(), secureUnit())
  const starsPerRaffMicro = Math.max(1, Math.round(value * MICRO))
  await db
    .insert(rateQuotes)
    .values({
      hourStart: start,
      expiresAt: new Date(start.getTime() + RATE_TTL_MS),
      starsPerRaffMicro,
      baseStarsPerRaffMicro: baseMicro,
      moveMicro: Math.round(move * MICRO),
      nairaPerRaffKobo: Math.round((starsPerRaffMicro / MICRO) * nairaPerStar * 100),
    })
    .onConflictDoNothing({ target: rateQuotes.hourStart })
  const [row] = await db.select().from(rateQuotes).where(eq(rateQuotes.hourStart, start))
  if (!row) throw new Error(`rate quote for ${start.toISOString()} missing after insert`)
  return row
}
