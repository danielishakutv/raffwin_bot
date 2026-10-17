/**
 * Admin > Features: the switch for everyone per feature, and per-player
 * overrides (packages/shared/src/features.ts lists the features; the rules
 * live in services/features.ts). Every change is audited with before/after.
 * Turning a feature on can tell every player (a broadcast); an override that
 * turns one on for a player can tell that player.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { FEATURE_KEYS, FEATURES, isFeatureKey, type FeatureKey } from '@raffwin/shared'
import type { FeatureOverrideBody, FeatureToggleBody } from '@raffwin/shared/admin-schemas'
import type { AdminFeature, AdminFeatureOverride, AdminUserFeature } from '@raffwin/shared/admin-types'
import type { AppContext } from '../context'
import type { Db } from '../db/client'
import { adminUsers, featureFlagOverrides, featureFlags, users } from '../db/schema'
import { escapeHtml } from '../lib/html'
import { HttpError } from '../lib/http-error'
import { clearOverride, getGlobalFlags, setGlobal, setOverride, type FeatureOverrideRow } from '../services/features'
import { createBroadcast, enqueue, openAppButton } from '../services/notify'
import { appendAudit } from './audit'
import { normaliseHandle, resolvePlayers } from './messages'

type Reader = Pick<Db, 'select'>

/** The :key route parameter as a FeatureKey, or NOT_FOUND */
export function featureKeyParam(value: unknown): FeatureKey {
  if (!isFeatureKey(value)) throw new HttpError('NOT_FOUND', 'No such feature.')
  return value
}

/** Every feature in registry order, with its switch for everyone and how many players have their own setting. */
export async function listFeatures(ctx: AppContext): Promise<AdminFeature[]> {
  const global = await getGlobalFlags(ctx.db)
  const stored = await ctx.db
    .select({ key: featureFlags.key, updatedAt: featureFlags.updatedAt, updatedBy: adminUsers.name })
    .from(featureFlags)
    .leftJoin(adminUsers, eq(adminUsers.id, featureFlags.updatedByAdminId))
  const counts = await ctx.db
    .select({
      key: featureFlagOverrides.flagKey,
      on: sql<number>`count(*) filter (where ${featureFlagOverrides.enabled})::int`,
      off: sql<number>`count(*) filter (where not ${featureFlagOverrides.enabled})::int`,
    })
    .from(featureFlagOverrides)
    .where(isNull(featureFlagOverrides.clearedAt))
    .groupBy(featureFlagOverrides.flagKey)
  return FEATURE_KEYS.map((key) => {
    const f = FEATURES[key]
    const row = stored.find((s) => s.key === key)
    const c = counts.find((x) => x.key === key)
    return {
      key,
      name: f.name,
      description: f.description,
      audience: f.audience,
      enabled: global[key],
      defaultEnabled: f.defaultEnabled,
      announce: f.announce,
      overrides: { on: c?.on ?? 0, off: c?.off ?? 0 },
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    }
  })
}

async function getFeature(ctx: AppContext, key: FeatureKey): Promise<AdminFeature> {
  return (await listFeatures(ctx)).find((f) => f.key === key) as AdminFeature
}

/**
 * The switch for everyone. announce (only when turning on, and only when it
 * was off) queues a bot message to every player: the admin's text, else the
 * feature's suggested one.
 */
export async function toggleFeature(ctx: AppContext, adminId: string, key: FeatureKey, body: FeatureToggleBody): Promise<AdminFeature> {
  await ctx.db.transaction(async (tx) => {
    // Serialises two admins flipping the same switch, so before/after and the announcement agree
    await tx.execute(sql`select pg_advisory_xact_lock(727201, hashtext(${key}))`)
    const before = (await getGlobalFlags(tx))[key]
    const announce = body.enabled && body.announce
    const text = body.message ?? FEATURES[key].announce
    if (announce && before) {
      throw new HttpError('INVALID_INPUT', `${FEATURES[key].name} is already on for everyone. To tell players again, send a message from Messages.`)
    }
    if (announce && !text) {
      throw new HttpError('INVALID_INPUT', 'Write the message players should get.', { message: 'Required for this feature' })
    }
    const change = await setGlobal(tx, key, body.enabled, adminId)
    const broadcast = announce
      ? await createBroadcast(tx, {
          kind: 'feature',
          text: text as string,
          openButton: true,
          audience: { type: 'all' },
          refType: 'feature',
          refId: key,
          adminId,
        })
      : null
    await appendAudit(tx, {
      adminId,
      action: 'feature.global',
      targetType: 'feature',
      targetId: key,
      before: { enabled: change.before },
      after: { enabled: change.after, reason: body.reason, broadcastId: broadcast?.id ?? null },
    })
  })
  return getFeature(ctx, key)
}

function toOverride(o: FeatureOverrideRow, user: { username: string | null; telegramId: number }, createdBy: string | null): AdminFeatureOverride {
  return {
    id: o.id,
    userId: o.userId,
    username: user.username,
    telegramId: user.telegramId,
    enabled: o.enabled,
    note: o.note,
    createdAt: o.createdAt.toISOString(),
    createdBy,
  }
}

/** Live overrides of one feature, newest first. */
export async function listOverrides(ctx: AppContext, key: FeatureKey): Promise<AdminFeatureOverride[]> {
  const rows = await ctx.db
    .select({ o: featureFlagOverrides, username: users.username, telegramId: users.telegramId, createdBy: adminUsers.name })
    .from(featureFlagOverrides)
    .innerJoin(users, eq(users.id, featureFlagOverrides.userId))
    .leftJoin(adminUsers, eq(adminUsers.id, featureFlagOverrides.createdByAdminId))
    .where(and(eq(featureFlagOverrides.flagKey, key), isNull(featureFlagOverrides.clearedAt)))
    .orderBy(sql`${featureFlagOverrides.createdAt} desc`)
    .limit(500)
  return rows.map((r) => toOverride(r.o, r, r.createdBy))
}

/**
 * One player's own setting for a feature (replacing any earlier one). With
 * notify, turning it on also queues a bot message to that player.
 */
export async function addOverride(ctx: AppContext, adminId: string, key: FeatureKey, body: FeatureOverrideBody): Promise<AdminFeatureOverride> {
  if (body.notify && !body.enabled) {
    throw new HttpError('INVALID_INPUT', 'Players are only told when a feature is turned on for them. Untick "Tell the player" to turn it off.', {
      notify: 'Only when turning on',
    })
  }
  const handle = normaliseHandle(body.user)
  const { found } = await resolvePlayers(ctx.db, [handle])
  const player = found.get(handle)
  if (!player) throw new HttpError('NOT_FOUND', `No Raffle Win player found for ${/^\d+$/.test(handle) ? handle : `@${handle}`}.`, { user: 'Not found' })

  const row = await ctx.db.transaction(async (tx) => {
    const o = await setOverride(tx, key, player.id, body.enabled, body.note, adminId)
    let notified: 'queued' | 'duplicate' | null = null
    if (body.notify && body.enabled) {
      const button = openAppButton(ctx)
      notified = await enqueue(tx, {
        userId: player.id,
        telegramId: player.telegramId,
        kind: 'feature',
        text: escapeHtml(body.message ?? FEATURES[key].announce ?? `"${FEATURES[key].name}" is now on for you.`),
        buttons: button ? [[button]] : null,
        dedupeKey: `feature:${key}:${o.id}`,
      })
    }
    await appendAudit(tx, {
      adminId,
      action: 'feature.override.set',
      targetType: 'user',
      targetId: player.id,
      after: { key, enabled: body.enabled, note: body.note, overrideId: o.id, notified },
    })
    return o
  })
  const [by] = await ctx.db.select({ name: adminUsers.name }).from(adminUsers).where(eq(adminUsers.id, adminId))
  return toOverride(row, player, by?.name ?? null)
}

/** Ends an override: the player goes back to the switch for everyone. */
export async function removeOverride(ctx: AppContext, adminId: string, overrideId: string, reason: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const row = await clearOverride(tx, overrideId, adminId)
    if (!row) throw new HttpError('NOT_FOUND', 'No such override, or it was already removed.')
    await appendAudit(tx, {
      adminId,
      action: 'feature.override.clear',
      targetType: 'user',
      targetId: row.userId,
      before: { key: row.flagKey, enabled: row.enabled, note: row.note, overrideId: row.id },
      after: { reason },
    })
  })
}

/** Every feature as it applies to one player (admin > player detail). */
export async function userFeatures(db: Reader, userId: string): Promise<AdminUserFeature[]> {
  const global = await getGlobalFlags(db)
  const overrides = await db
    .select({ id: featureFlagOverrides.id, key: featureFlagOverrides.flagKey, enabled: featureFlagOverrides.enabled })
    .from(featureFlagOverrides)
    .where(and(eq(featureFlagOverrides.userId, userId), isNull(featureFlagOverrides.clearedAt)))
  return FEATURE_KEYS.map((key) => {
    const live = overrides.find((o) => o.key === key)
    const own = live?.enabled ?? null
    return { key, name: FEATURES[key].name, global: global[key], override: own, overrideId: live?.id ?? null, effective: own ?? global[key] }
  })
}
