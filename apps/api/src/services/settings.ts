/**
 * Typed access to the settings table. Every key has a default here, so a
 * fresh database works before anyone has opened the admin.
 */
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { settings } from '../db/schema'

const SETTINGS = {
  /*
   * Rate and sales (admin > Settings > Rate and sales; changes need a second
   * admin). Replaced the Stars base on 19 Oct: Raffs are sold for naira on the
   * sales site, which reads all of these through the relay. The old Stars keys
   * stay in the table, unused.
   */
  /** Base price of one Raff in kobo: 1000 = ₦10 */
  'rate.base_naira_per_raff_kobo': z.number().int().min(1).max(10_000_000).default(1_000),
  /** Each clock hour's quote moves between min and max percent from the base, up or down (0 and 0 = fixed price) */
  'rate.move_min_pct': z.number().int().min(0).max(30).default(3),
  'rate.move_max_pct': z.number().int().min(0).max(30).default(15),
  /** Packages on the sales site; bonusPercent is extra Raffs on top, at most 15 */
  'sales.packages': z
    .array(z.object({ naira: z.number().int().min(100).max(10_000_000), bonusPercent: z.number().int().min(0).max(15), label: z.string().max(24).nullable() }))
    .max(8)
    .default([
      { naira: 1_000, bonusPercent: 0, label: null },
      { naira: 5_000, bonusPercent: 5, label: 'Popular' },
      { naira: 10_000, bonusPercent: 10, label: null },
      { naira: 25_000, bonusPercent: 15, label: 'Best value' },
    ]),
  /** Smallest and largest single purchase in naira (a custom amount has no bonus) */
  'sales.min_naira': z.number().int().min(100).max(10_000_000).default(500),
  'sales.max_naira': z.number().int().min(100).max(10_000_000).default(500_000),
  /** Most entries one user may hold in one raffle; null = no cap */
  'limits.max_entries_per_user_per_raffle': z.number().int().min(1).nullable().default(null),
  /** Most Raffs one user may spend on entries per Lagos calendar day; null = no cap */
  'limits.daily_spend_raffs': z.number().int().min(1).nullable().default(null),

  /* Engagement (admin > Messages). Hours are Lagos time. */
  /** An inactivity reminder goes out a random 6..10 h after the last open, then again every 6..10 h */
  'engagement.reminder_min_hours': z.number().int().min(1).max(72).default(6),
  'engagement.reminder_max_hours': z.number().int().min(1).max(72).default(10),
  /** Reminders per spell away; after that the bot stays quiet until the player opens the app again */
  'engagement.max_reminders_per_spell': z.number().int().min(0).max(50).default(8),
  /** No reminders or offers from quiet_start to quiet_end (Lagos); due ones wait for the morning */
  'engagement.quiet_start_hour': z.number().int().min(0).max(23).default(22),
  'engagement.quiet_end_hour': z.number().int().min(0).max(23).default(7),
  /** Away this long and the bot offers a free Raff for coming back */
  'engagement.comeback_after_hours': z.number().int().min(12).max(720).default(48),
  /** "max 1 Raff" (owner, 17 Oct): 0 turns the offer's credit off */
  'engagement.comeback_raffs': z.number().int().min(0).max(1).default(1),
  /** At most one come-back offer per player in this many days */
  'engagement.comeback_cooldown_days': z.number().int().min(1).max(90).default(7),
  /** Daily streak bonus by day: day 1 = [0]; past the end the last value repeats */
  'streak.rewards': z.array(z.number().int().min(0).max(1000)).min(1).max(30).default([1, 1, 2, 2, 3, 3, 5]),
  /** Send Raffs: smallest transfer, and most Raffs one player may send per Lagos day */
  'transfers.min_raffs': z.number().int().min(1).max(1_000_000).default(1),
  'transfers.daily_max_raffs': z.number().int().min(1).max(10_000_000).default(1000),
} as const

export type SettingKey = keyof typeof SETTINGS

export interface RateSettings {
  nairaPerRaffKobo: number
  moveMinPct: number
  moveMaxPct: number
}
export interface SalesSettings {
  packages: { naira: number; bonusPercent: number; label: string | null }[]
  minNaira: number
  maxNaira: number
}

export async function rateSettings(db: Reader): Promise<RateSettings> {
  return {
    nairaPerRaffKobo: await getSetting(db, 'rate.base_naira_per_raff_kobo'),
    moveMinPct: await getSetting(db, 'rate.move_min_pct'),
    moveMaxPct: await getSetting(db, 'rate.move_max_pct'),
  }
}
export async function salesSettings(db: Reader): Promise<SalesSettings> {
  return {
    packages: await getSetting(db, 'sales.packages'),
    minNaira: await getSetting(db, 'sales.min_naira'),
    maxNaira: await getSetting(db, 'sales.max_naira'),
  }
}
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]>
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[]

type Reader = Pick<Db, 'select'>

/**
 * Values are stored wrapped as {"v": value}: the column is NOT NULL, and a
 * setting whose value is null ("no cap") must still be distinguishable from
 * a setting that was never stored (which falls back to its default).
 */
function unwrap(stored: unknown): unknown {
  return stored && typeof stored === 'object' && 'v' in stored ? (stored as { v: unknown }).v : undefined
}

export async function getSetting<K extends SettingKey>(db: Reader, key: K): Promise<SettingValue<K>> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key))
  return SETTINGS[key].parse(unwrap(row?.value)) as SettingValue<K>
}

export async function getAllSettings(db: Reader): Promise<Record<SettingKey, unknown>> {
  const rows = await db.select().from(settings)
  const stored = new Map(rows.map((r) => [r.key, unwrap(r.value)]))
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].parse(stored.get(k) ?? undefined)])) as Record<
    SettingKey,
    unknown
  >
}

export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return SETTINGS[key].parse(value) as SettingValue<K>
}

export async function putSetting<K extends SettingKey>(
  db: Pick<Db, 'insert'>,
  key: K,
  value: SettingValue<K>,
  adminId: string | null,
): Promise<void> {
  const wrapped = { v: parseSetting(key, value) }
  await db
    .insert(settings)
    .values({ key, value: wrapped, updatedByAdminId: adminId })
    .onConflictDoUpdate({ target: settings.key, set: { value: wrapped, updatedByAdminId: adminId, updatedAt: sql`now()` } })
}
