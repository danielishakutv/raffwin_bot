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
