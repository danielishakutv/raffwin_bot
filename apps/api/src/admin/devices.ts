/**
 * Trusted devices (decision of 19 Oct): the full admin sign-in is for a device
 * the admin has never used. Once a full sign-in succeeds on a device, it is
 * registered (unless the admin unticks "Trust this device"), and from then on:
 *
 *   telegram  the Mini App on that phone or computer, opened by the bound
 *             Telegram account, signs in with one tap: fresh initData from that
 *             account + the device secret kept in Telegram's device storage
 *   browser   the device secret kept in that browser + the admin's own password
 *             (no master password, no code from the bot)
 *
 * The secret is 32 random bytes; only its SHA-256 is stored. A device is
 * revoked (never removed) by its admin in Settings, by a password reset, after
 * 5 wrong passwords in a row on a browser device, and all at once when two
 * admins mark the account at risk (admin/risk.ts). An account at risk cannot
 * register or use devices until two admins clear it.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Request } from 'express'
import { z } from 'zod'
import type { AdminDevice } from '@raffwin/shared/admin-types'
import type { AppContext, RequestMeta } from '../context'
import { adminDevices, adminSessions, adminUsers, type AdminDeviceRow, type AdminUserRow } from '../db/schema'
import { newRefreshToken, sha256Hex } from '../lib/crypto'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'
import { readInitDataUser, verifyTelegramData } from '../lib/telegram-auth'
import { requestMeta } from '../http/middleware'
import type { Tx } from '../services/ledger'
import { appendAudit } from './audit'
import { openSession, verifyPassword, type AdminChannel, type AdminLogin } from './session'

/** Wrong passwords in a row on one browser device before it is revoked */
export const DEVICE_MAX_FAILED = 5

const deviceToken = z.string().min(30).max(100)
export const telegramDeviceBody = z.object({ deviceToken, initData: z.string().min(1).max(8192) })
// Trimmed like every other admin secret (the bot trims what it reads)
export const browserDeviceBody = z.object({ deviceToken, password: z.string().trim().min(1).max(200) })

const NOT_TRUSTED = 'This device is no longer trusted. Sign in with the full checks to trust it again.'

/** "Telegram on ios", "Chrome on Windows": enough for an admin to recognise their own devices. */
export function deviceLabel(channel: AdminChannel, userAgent: string | null, platform?: string | null): string {
  if (channel === 'telegram') return `Telegram${platform ? ` on ${platform.slice(0, 20)}` : ''}`
  const ua = userAgent ?? ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null
  return os ? `${browser} on ${os}` : browser
}

/**
 * Registers the device a full sign-in just succeeded on, inside that sign-in's
 * transaction. Returns the secret for the device to keep, or null when the
 * account is marked at risk (no device is trusted while it is).
 */
export async function registerDevice(
  _ctx: AppContext,
  tx: Tx,
  input: { admin: AdminUserRow; channel: AdminChannel; userAgent: string | null; ipHash: string | null; platform?: string | null },
): Promise<{ token: string; deviceId: string } | null> {
  if (input.admin.riskFlaggedAt) return null
  const token = newRefreshToken()
  const label = deviceLabel(input.channel, input.userAgent, input.platform)
  const [row] = await tx
    .insert(adminDevices)
    .values({
      adminId: input.admin.id,
      channel: input.channel,
      secretHash: sha256Hex(token),
      label,
      userAgent: input.userAgent?.slice(0, 400) ?? null,
      ipHash: input.ipHash,
    })
    .returning({ id: adminDevices.id })
  if (!row) throw new Error('device insert returned no row')
  await appendAudit(tx, { adminId: input.admin.id, action: 'admin.device.trusted', targetType: 'admin_device', targetId: row.id, after: { channel: input.channel, label }, ipHash: input.ipHash })
  return { token, deviceId: row.id }
}

async function refuse(ctx: AppContext, meta: RequestMeta, kind: string, details: Record<string, unknown>, message = NOT_TRUSTED): Promise<never> {
  await recordSecurityEvent(ctx.db, ctx.log, {
    severity: 'high',
    category: 'admin',
    kind,
    ipHash: meta.ipHash,
    route: meta.route,
    requestId: meta.requestId,
    details,
    actionTaken: 'blocked',
  })
  throw new HttpError('AUTH_INVALID', message)
}

type DeviceProblem = 'unknown' | 'revoked' | 'wrong_channel' | 'admin_unavailable' | 'at_risk'

/** The device row and its admin, both usable, or why not. */
async function usableDevice(
  tx: Tx,
  token: string,
  channel: AdminChannel,
): Promise<{ device: AdminDeviceRow; admin: AdminUserRow } | { problem: DeviceProblem; device?: AdminDeviceRow }> {
  const [device] = await tx.select().from(adminDevices).where(eq(adminDevices.secretHash, sha256Hex(token))).for('update')
  if (!device) return { problem: 'unknown' }
  if (device.revokedAt) return { problem: 'revoked', device }
  if (device.channel !== channel) return { problem: 'wrong_channel', device }
  const [admin] = await tx.select().from(adminUsers).where(eq(adminUsers.id, device.adminId))
  if (!admin || admin.status !== 'active') return { problem: 'admin_unavailable', device }
  if (admin.riskFlaggedAt) return { problem: 'at_risk', device }
  return { device, admin }
}

/** Telegram, one tap: the device secret + fresh initData from the admin's bound account. */
export async function deviceSignInTelegram(ctx: AppContext, req: Request): Promise<AdminLogin> {
  const body = telegramDeviceBody.parse(req.body)
  const meta = requestMeta(ctx, req)
  const now = ctx.now()
  const verified = verifyTelegramData(body.initData, ctx.config.BOT_TOKEN, { maxAgeSeconds: ctx.config.INITDATA_MAX_AGE_SECONDS, now })
  const tg = verified.ok ? readInitDataUser(verified.fields) : null
  if (!tg) return refuse(ctx, meta, `admin_device_initdata_${verified.ok ? 'no_user' : verified.reason}`, {}, 'Open the admin from inside Telegram.')

  const result = await ctx.db.transaction(async (tx) => {
    const found = await usableDevice(tx, body.deviceToken, 'telegram')
    if ('problem' in found) return { kind: found.problem, deviceId: found.device?.id ?? null, adminId: found.device?.adminId ?? null, left: 0 }
    const { device, admin } = found
    if (admin.telegramId !== tg.id) return { kind: 'other_account' as const, deviceId: device.id, adminId: admin.id, left: 0 }
    await tx.update(adminDevices).set({ lastUsedAt: new Date(now), failedCount: 0 }).where(eq(adminDevices.id, device.id))
    await tx.update(adminUsers).set({ lastLoginAt: new Date(now), failedLogins: 0, updatedAt: sql`now()` }).where(eq(adminUsers.id, admin.id))
    const session = await openSession(ctx, tx, {
      admin,
      channel: 'telegram',
      deviceId: device.id,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
      auditAfter: { telegramId: tg.id, deviceId: device.id, via: 'trusted_device' },
    })
    return { kind: 'ok' as const, admin, ...session }
  })
  if (result.kind !== 'ok') {
    return refuse(ctx, meta, `admin_device_${result.kind}`, { telegramId: tg.id, deviceId: result.deviceId, adminId: result.adminId })
  }
  return { admin: result.admin, token: result.token, expiresAt: result.expiresAt }
}

/** Browser: the device secret + the admin's own password. Five wrong passwords in a row revoke the device. */
export async function deviceSignInBrowser(ctx: AppContext, req: Request): Promise<AdminLogin> {
  const body = browserDeviceBody.parse(req.body)
  const meta = requestMeta(ctx, req)
  const now = ctx.now()

  const result = await ctx.db.transaction(async (tx) => {
    const found = await usableDevice(tx, body.deviceToken, 'browser')
    if ('problem' in found) return { kind: found.problem, deviceId: found.device?.id ?? null, adminId: found.device?.adminId ?? null, left: 0 }
    const { device, admin } = found
    if (!(await verifyPassword(admin.passwordHash, body.password))) {
      const failed = device.failedCount + 1
      const revoke = failed >= DEVICE_MAX_FAILED
      await tx
        .update(adminDevices)
        .set(revoke ? { failedCount: failed, revokedAt: new Date(now), revokedReason: 'wrong_passwords' } : { failedCount: failed })
        .where(eq(adminDevices.id, device.id))
      await appendAudit(tx, { adminId: admin.id, action: 'admin.device.wrong_password', targetType: 'admin_device', targetId: device.id, after: { failedInARow: failed, revoked: revoke }, ipHash: meta.ipHash })
      return { kind: 'wrong_password' as const, deviceId: device.id, adminId: admin.id, left: DEVICE_MAX_FAILED - failed }
    }
    await tx.update(adminDevices).set({ lastUsedAt: new Date(now), failedCount: 0 }).where(eq(adminDevices.id, device.id))
    await tx.update(adminUsers).set({ lastLoginAt: new Date(now), failedLogins: 0, updatedAt: sql`now()` }).where(eq(adminUsers.id, admin.id))
    const session = await openSession(ctx, tx, {
      admin,
      channel: 'browser',
      deviceId: device.id,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
      auditAfter: { channel: 'browser', deviceId: device.id, via: 'trusted_device' },
    })
    return { kind: 'ok' as const, admin, ...session }
  })

  if (result.kind === 'ok') return { admin: result.admin, token: result.token, expiresAt: result.expiresAt }
  if (result.kind === 'wrong_password') {
    // Committed above, so the count stands even though this request fails
    const message =
      result.left > 0
        ? `That password is not right. ${result.left} ${result.left === 1 ? 'try' : 'tries'} left on this device.`
        : 'That password is not right, and this device is no longer trusted. Sign in with the full checks.'
    return refuse(ctx, meta, 'admin_device_wrong_password', { deviceId: result.deviceId, adminId: result.adminId, left: result.left }, message)
  }
  return refuse(ctx, meta, `admin_device_${result.kind}`, { deviceId: result.deviceId, adminId: result.adminId })
}

export async function listDevices(ctx: AppContext, adminId: string, currentDeviceId: string | null): Promise<AdminDevice[]> {
  const rows = await ctx.db.select().from(adminDevices).where(eq(adminDevices.adminId, adminId)).orderBy(desc(adminDevices.createdAt)).limit(100)
  return rows.map((d) => ({
    id: d.id,
    channel: d.channel,
    label: d.label,
    createdAt: d.createdAt.toISOString(),
    lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
    revokedAt: d.revokedAt?.toISOString() ?? null,
    revokedReason: d.revokedReason,
    current: d.id === currentDeviceId,
  }))
}

/** Ends trust in every device of an admin (callers end the sessions themselves); returns how many devices. */
export async function revokeAllDevices(tx: Tx, adminId: string, reason: string, at: Date): Promise<number> {
  const revoked = await tx
    .update(adminDevices)
    .set({ revokedAt: at, revokedReason: reason })
    .where(and(eq(adminDevices.adminId, adminId), isNull(adminDevices.revokedAt)))
    .returning({ id: adminDevices.id })
  return revoked.length
}

/** An admin stops trusting one of their own devices; sessions it opened end too. */
export async function revokeDevice(ctx: AppContext, adminId: string, deviceId: string): Promise<AdminDevice[]> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(adminDevices)
      .set({ revokedAt: new Date(ctx.now()), revokedReason: 'removed_by_admin' })
      .where(and(eq(adminDevices.id, deviceId), eq(adminDevices.adminId, adminId), isNull(adminDevices.revokedAt)))
      .returning({ id: adminDevices.id })
    if (!row) throw new HttpError('NOT_FOUND', 'No such trusted device.')
    await tx.update(adminSessions).set({ revokedAt: sql`now()` }).where(and(eq(adminSessions.deviceId, deviceId), isNull(adminSessions.revokedAt)))
    await appendAudit(tx, { adminId, action: 'admin.device.revoked', targetType: 'admin_device', targetId: deviceId })
  })
  return listDevices(ctx, adminId, null)
}
