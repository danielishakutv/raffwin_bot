/**
 * Feature switches (packages/shared/src/features.ts lists them). Effective for
 * a player = their live override if there is one, else the global switch
 * (feature_flags), else the feature's default. Reads are cheap single queries;
 * writes are audited by the admin layer that calls them.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import { FEATURES, defaultFeatures, isFeatureKey, type FeatureKey, type FeatureMap } from '@raffwin/shared'
import type { Db } from '../db/client'
import { featureFlagOverrides, featureFlags, users } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { CACHE_KEYS, type SharedCache } from '../lib/shared-cache'

type Reader = Pick<Db, 'select'>
type Writer = Pick<Db, 'select' | 'insert' | 'update'>
export type FeatureOverrideRow = typeof featureFlagOverrides.$inferSelect

/** The switch for everyone, per feature: stored rows over the defaults. */
export async function getGlobalFlags(db: Reader): Promise<FeatureMap> {
  const rows = await db.select({ key: featureFlags.key, enabled: featureFlags.enabled }).from(featureFlags)
  const map = defaultFeatures()
  // A row for a feature no longer in the registry is ignored, not an error
  for (const r of rows) if (isFeatureKey(r.key)) map[r.key] = r.enabled
  return map
}

/** What one player gets: the global switches with that player's live overrides applied. */
export async function featuresFor(db: Reader, userId: string): Promise<FeatureMap> {
  const [map, overrides] = await Promise.all([
    getGlobalFlags(db),
    db
      .select({ key: featureFlagOverrides.flagKey, enabled: featureFlagOverrides.enabled })
      .from(featureFlagOverrides)
      .where(and(eq(featureFlagOverrides.userId, userId), isNull(featureFlagOverrides.clearedAt))),
  ])
  for (const o of overrides) if (isFeatureKey(o.key)) map[o.key] = o.enabled
  return map
}

/**
 * featuresFor for the polled snapshot: the global switches and the list of
 * players holding any override come from the shared cache, so most players
 * cost no query at all. A switch change reaches apps within the cache time.
 */
export async function featuresForLive(db: Pick<Db, 'select' | 'selectDistinct'>, userId: string, cache: SharedCache | undefined): Promise<FeatureMap> {
  if (!cache) return featuresFor(db, userId)
  const [global, withOverrides] = await Promise.all([
    cache.get(CACHE_KEYS.globalFlags, () => getGlobalFlags(db)),
    cache.get(CACHE_KEYS.overrideUsers, async () => {
      const rows = await db
        .selectDistinct({ userId: featureFlagOverrides.userId })
        .from(featureFlagOverrides)
        .where(isNull(featureFlagOverrides.clearedAt))
      return new Set(rows.map((r) => r.userId))
    }),
  ])
  const map = { ...global }
  if (!withOverrides.has(userId)) return map
  const overrides = await db
    .select({ key: featureFlagOverrides.flagKey, enabled: featureFlagOverrides.enabled })
    .from(featureFlagOverrides)
    .where(and(eq(featureFlagOverrides.userId, userId), isNull(featureFlagOverrides.clearedAt)))
  for (const o of overrides) if (isFeatureKey(o.key)) map[o.key] = o.enabled
  return map
}

/** userId null = the global switch only (no player in view). */
export async function isFeatureOn(db: Reader, key: FeatureKey, userId: string | null): Promise<boolean> {
  const map = userId ? await featuresFor(db, userId) : await getGlobalFlags(db)
  return map[key]
}

/** Refuses with FEATURE_OFF when the feature is off for this player. */
export async function requireFeature(db: Reader, key: FeatureKey, userId: string): Promise<void> {
  if (!(await isFeatureOn(db, key, userId))) {
    throw new HttpError('FEATURE_OFF', `${FEATURES[key].name} is not available right now.`)
  }
}

/**
 * "Is this feature on for users.id" as a boolean SQL expression, for bulk
 * selects FROM users (the scheduler, broadcast fan-out): override, else the
 * global row, else the default. Same rule as featuresFor, one query.
 */
export function featureSql(key: FeatureKey): SQL {
  return sql`coalesce(
    (select o.enabled from ${featureFlagOverrides} o
      where o.flag_key = ${key} and o.user_id = ${users.id} and o.cleared_at is null),
    (select f.enabled from ${featureFlags} f where f.key = ${key}),
    ${sql.raw(FEATURES[key].defaultEnabled ? 'true' : 'false')}
  )`
}

/** Sets the switch for everyone. Returns the global value before and after, for the audit row. */
export async function setGlobal(
  tx: Writer,
  key: FeatureKey,
  enabled: boolean,
  adminId: string | null,
): Promise<{ before: boolean; after: boolean }> {
  const before = (await getGlobalFlags(tx))[key]
  await tx
    .insert(featureFlags)
    .values({ key, enabled, updatedByAdminId: adminId })
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: { enabled, updatedByAdminId: adminId, updatedAt: sql`now()` },
    })
  return { before, after: enabled }
}

/**
 * Gives one player their own setting for a feature. Any live override is
 * cleared first (kept as history), so there is at most one live row.
 */
export async function setOverride(
  tx: Writer,
  key: FeatureKey,
  userId: string,
  enabled: boolean,
  note: string,
  adminId: string | null,
): Promise<FeatureOverrideRow> {
  await tx
    .update(featureFlagOverrides)
    .set({ clearedAt: sql`now()`, clearedByAdminId: adminId })
    .where(
      and(eq(featureFlagOverrides.flagKey, key), eq(featureFlagOverrides.userId, userId), isNull(featureFlagOverrides.clearedAt)),
    )
  const [row] = await tx
    .insert(featureFlagOverrides)
    .values({ flagKey: key, userId, enabled, note, createdByAdminId: adminId })
    .returning()
  if (!row) throw new Error('feature override insert returned no row')
  return row
}

/** Ends a live override (the player goes back to the global switch). Null = no such live override. */
export async function clearOverride(tx: Writer, overrideId: string, adminId: string | null): Promise<FeatureOverrideRow | null> {
  const [row] = await tx
    .update(featureFlagOverrides)
    .set({ clearedAt: sql`now()`, clearedByAdminId: adminId })
    .where(and(eq(featureFlagOverrides.id, overrideId), isNull(featureFlagOverrides.clearedAt)))
    .returning()
  return row ?? null
}
