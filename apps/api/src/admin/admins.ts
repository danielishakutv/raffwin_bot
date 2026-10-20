/**
 * Admin accounts, managed by a super admin from the admin screen (the first
 * one comes from the CLI). A new admin gets a generated password shown once to
 * the super admin who created them, plus the Telegram username their account
 * will be bound to on first sign-in.
 */
import { randomInt } from 'node:crypto'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../context'
import { uniqueViolation } from '../db/client'
import { ADMIN_ROLES, adminSessions, adminUsers, users, type AdminUserRow } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'
import { appendAudit } from './audit'
import { revokeAllDevices } from './devices'
import { hashPassword, verifyPassword } from './session'

export const createBody = z.object({
  name: z.string().trim().min(2).max(80),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.]{3,32}$/, '3-32 of a-z 0-9 _ .'),
  telegramUsername: z
    .string()
    .trim()
    .transform((v) => v.replace(/^@/, '').toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9_]{5,32}$/, 'Their Telegram username, e.g. @ada_obi')),
  role: z.enum(ADMIN_ROLES),
})

export interface AdminAccount {
  id: string
  name: string
  username: string | null
  telegramUsername: string | null
  /** True once the Telegram account has signed in and been bound */
  telegramBound: boolean
  role: AdminUserRow['role']
  status: AdminUserRow['status']
  lastLoginAt: string | null
  createdAt: string
}

function toAccount(a: AdminUserRow): AdminAccount {
  return {
    id: a.id,
    name: a.name,
    username: a.username,
    telegramUsername: a.telegramUsername,
    telegramBound: a.telegramId !== null,
    role: a.role,
    status: a.status,
    lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  }
}

/** 16 characters, no look-alikes: easy to read out, ~94 bits. */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 16; i += 1) out += alphabet[randomInt(alphabet.length)]
  return out
}

export async function list(ctx: AppContext): Promise<AdminAccount[]> {
  const rows = await ctx.db.select().from(adminUsers).orderBy(asc(adminUsers.createdAt))
  return rows.map(toAccount)
}

export async function create(
  ctx: AppContext,
  byAdminId: string,
  body: z.infer<typeof createBody>,
): Promise<{ admin: AdminAccount; password: string }> {
  const password = generatePassword()
  const passwordHash = await hashPassword(password)
  try {
    const row = await ctx.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(adminUsers)
        .values({ name: body.name, username: body.username, telegramUsername: body.telegramUsername, role: body.role, passwordHash })
        .returning()
      if (!created) throw new Error('admin insert returned no row')
      await appendAudit(tx, { adminId: byAdminId, action: 'admin.create', targetType: 'admin', targetId: created.id, after: body })
      return created
    })
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: 'high',
      category: 'admin',
      kind: 'admin_created',
      ipHash: null,
      route: 'POST /admin/v1/admins',
      details: { byAdminId, adminId: row.id, role: body.role },
    })
    return { admin: toAccount(row), password }
  } catch (error) {
    const c = uniqueViolation(error)
    if (c === 'admin_users_username_key') throw new HttpError('INVALID_INPUT', 'That admin username is taken.', { username: 'Taken' })
    if (c === 'admin_users_telegram_username_key') {
      throw new HttpError('INVALID_INPUT', 'That Telegram account is already an admin.', { telegramUsername: 'Already an admin' })
    }
    throw error
  }
}

export const fromPlayerBody = createBody.pick({ name: true, username: true, role: true })

const TELEGRAM_USERNAME = /^[a-z0-9_]{5,32}$/

/**
 * Makes an existing player an admin. Their Telegram account is bound at once
 * by its id (taken from the player's signed sign-in, so it is trusted), not by
 * a username they could change. The sign-in still needs the master password and
 * the generated password, shown once to the super admin.
 */
export async function createFromPlayer(
  ctx: AppContext,
  byAdminId: string,
  userId: string,
  body: z.infer<typeof fromPlayerBody>,
): Promise<{ admin: AdminAccount; password: string }> {
  const [player] = await ctx.db.select({ id: users.id, telegramId: users.telegramId, tgUsername: users.tgUsername }).from(users).where(eq(users.id, userId))
  if (!player) throw new HttpError('NOT_FOUND', 'No such player.')
  const [existing] = await ctx.db.select({ name: adminUsers.name }).from(adminUsers).where(eq(adminUsers.telegramId, player.telegramId))
  if (existing) throw new HttpError('INVALID_INPUT', `This Telegram account is already the admin ${existing.name}.`)
  const tgUsername = player.tgUsername?.toLowerCase() ?? null
  const telegramUsername = tgUsername && TELEGRAM_USERNAME.test(tgUsername) ? tgUsername : null
  const password = generatePassword()
  const passwordHash = await hashPassword(password)
  try {
    const row = await ctx.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(adminUsers)
        .values({ name: body.name, username: body.username, telegramId: player.telegramId, telegramUsername, role: body.role, passwordHash })
        .returning()
      if (!created) throw new Error('admin insert returned no row')
      await appendAudit(tx, {
        adminId: byAdminId,
        action: 'admin.create',
        targetType: 'admin',
        targetId: created.id,
        after: { ...body, fromPlayer: player.id, telegramId: player.telegramId, telegramUsername },
      })
      return created
    })
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: 'high',
      category: 'admin',
      kind: 'admin_created',
      ipHash: null,
      route: 'POST /admin/v1/users/:id/make-admin',
      details: { byAdminId, adminId: row.id, role: body.role, fromPlayer: player.id },
    })
    return { admin: toAccount(row), password }
  } catch (error) {
    const c = uniqueViolation(error)
    if (c === 'admin_users_username_key') throw new HttpError('INVALID_INPUT', 'That admin username is taken.', { username: 'Taken' })
    if (c === 'admin_users_telegram_id_key') throw new HttpError('INVALID_INPUT', 'This Telegram account is already an admin.')
    if (c === 'admin_users_telegram_username_key') {
      throw new HttpError('INVALID_INPUT', `Another admin is waiting to be bound to @${telegramUsername}. Disable or fix that admin first.`)
    }
    throw error
  }
}

/** New password, shown once; every session of that admin ends and every trusted device is revoked. */
export async function resetPassword(ctx: AppContext, byAdminId: string, id: string): Promise<{ admin: AdminAccount; password: string }> {
  const password = generatePassword()
  const passwordHash = await hashPassword(password)
  const row = await ctx.db.transaction(async (tx) => {
    const [updated] = await tx.update(adminUsers).set({ passwordHash, updatedAt: sql`now()` }).where(eq(adminUsers.id, id)).returning()
    if (!updated) throw new HttpError('NOT_FOUND', 'No such admin.')
    await tx.update(adminSessions).set({ revokedAt: sql`now()` }).where(eq(adminSessions.adminId, id))
    // A reset means the old password may be known: no device is trusted on it any more
    const devicesRevoked = await revokeAllDevices(tx, id, 'password_reset', new Date(ctx.now()))
    await appendAudit(tx, { adminId: byAdminId, action: 'admin.password.reset', targetType: 'admin', targetId: id, after: { devicesRevoked } })
    return updated
  })
  return { admin: toAccount(row), password }
}

export async function setStatus(ctx: AppContext, byAdminId: string, id: string, status: 'active' | 'disabled'): Promise<AdminAccount> {
  if (id === byAdminId && status === 'disabled') throw new HttpError('INVALID_INPUT', 'You cannot disable yourself.')
  const row = await ctx.db.transaction(async (tx) => {
    const [updated] = await tx.update(adminUsers).set({ status, updatedAt: sql`now()` }).where(eq(adminUsers.id, id)).returning()
    if (!updated) throw new HttpError('NOT_FOUND', 'No such admin.')
    if (status === 'disabled') await tx.update(adminSessions).set({ revokedAt: sql`now()` }).where(eq(adminSessions.adminId, id))
    await appendAudit(tx, { adminId: byAdminId, action: `admin.${status === 'disabled' ? 'disable' : 'enable'}`, targetType: 'admin', targetId: id })
    return updated
  })
  return toAccount(row)
}

// Trimmed like every sign-in trims, so the password set here is the one that works there
export const passwordBody = z.object({
  current: z.string().trim().min(1).max(200),
  next: z.string().trim().min(12, 'Use at least 12 characters').max(200),
})

/** An admin changes their own password; every other session of theirs ends. */
export async function changeOwnPassword(
  ctx: AppContext,
  adminId: string,
  keepSessionId: string,
  body: z.infer<typeof passwordBody>,
): Promise<void> {
  const [admin] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, adminId))
  if (!admin) throw new HttpError('NOT_FOUND', 'No such admin.')
  if (!(await verifyPassword(admin.passwordHash, body.current))) {
    await recordSecurityEvent(ctx.db, ctx.log, {
      severity: 'medium',
      category: 'admin',
      kind: 'admin_password_change_wrong_current',
      ipHash: null,
      route: 'POST /admin/v1/me/password',
      details: { adminId },
    })
    throw new HttpError('INVALID_INPUT', 'Your current password is not right.', { current: 'Not right' })
  }
  if (body.next === body.current) throw new HttpError('INVALID_INPUT', 'Choose a password you have not used here.', { next: 'Same as before' })
  const passwordHash = await hashPassword(body.next)
  await ctx.db.transaction(async (tx) => {
    await tx.update(adminUsers).set({ passwordHash, updatedAt: sql`now()` }).where(eq(adminUsers.id, adminId))
    await tx
      .update(adminSessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(adminSessions.adminId, adminId), ne(adminSessions.id, keepSessionId), sql`${adminSessions.revokedAt} is null`))
    await appendAudit(tx, { adminId, action: 'admin.password.changed', targetType: 'admin', targetId: adminId })
  })
}
