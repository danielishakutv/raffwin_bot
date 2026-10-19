/**
 * Role -> permissions. Checked on every admin route; the role list lives in
 * the schema (ADMIN_ROLES). Sensitive changes are only ever *requested* by a
 * permission here and executed when a second admin approves (approvals.ts).
 */
import type { AdminRole } from '../db/schema'

export const PERMISSIONS = [
  'overview.read',
  'raffles.read',
  'raffles.write',
  'raffles.cancel.request',
  'users.read',
  'users.suspend',
  'users.adjust.request',
  /** Attach a referrer to an account that has none (super_admin only) */
  'users.referrer.assign',
  'settings.read',
  'settings.limits.write',
  'settings.rate.request',
  'approvals.read',
  'approvals.decide',
  'security.read',
  'audit.read',
  /** Add, disable and reset admins: super_admin only */
  'admins.manage',
  /** Finance report and expenses: super_admin and finance */
  'finance.read',
  'finance.write',
  /** Feature switches: everyone reads them; only a super admin turns them on or off */
  'features.read',
  'features.manage',
  /** Bot messages: the outbox and broadcast history; sending to players is super_admin only */
  'messages.read',
  'messages.send',
  /** Reminder timing, come-back offer, streak rewards, transfer caps (super_admin) */
  'engagement.write',
  /** Voucher batches: see them and look a code up; ask for a batch, hand out its codes, void */
  'vouchers.read',
  'vouchers.write',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const READ: Permission[] = [
  'overview.read',
  'raffles.read',
  'users.read',
  'settings.read',
  'approvals.read',
  'security.read',
  'audit.read',
  'features.read',
  'messages.read',
  'vouchers.read',
]

const ROLE_PERMISSIONS: Record<AdminRole, ReadonlySet<Permission>> = {
  viewer: new Set(READ),
  support: new Set([...READ, 'users.suspend']),
  raffle_manager: new Set([...READ, 'raffles.write', 'raffles.cancel.request']),
  finance: new Set([...READ, 'settings.rate.request', 'users.adjust.request', 'approvals.decide', 'finance.read', 'finance.write', 'vouchers.write']),
  super_admin: new Set(PERMISSIONS),
}

export function can(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission)
}

export function permissionsOf(role: AdminRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]]
}
