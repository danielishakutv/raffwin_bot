/**
 * Typed access to the settings table. Every key has a default here, so a
 * fresh database works before anyone has opened the admin.
 */
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { settings } from '../db/schema'

const SETTINGS = {
  /** Stars per Raff, in millionths: 500000 = 0.5 Star per Raff (2 Raffs per Star) */
  'rate.base_stars_per_raff_micro': z.number().int().min(1_000).max(1_000_000_000).default(500_000),
  /** Display only: Naira value of one Star, for "about ₦…" figures */
  'rate.naira_per_star': z.number().min(0).max(100_000).default(20),
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
