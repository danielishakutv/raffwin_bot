/** Shapes the admin API returns, shared with the admin dashboard. */

export type AdminRole = 'super_admin' | 'raffle_manager' | 'finance' | 'support' | 'viewer'

export interface AdminMe {
  id: string
  email: string
  name: string
  role: AdminRole
  permissions: string[]
}

export interface AdminPrize {
  position: 1 | 2 | 3
  prizeItem: string
  prizeType: 'physical' | 'raffs_credit'
  raffsValue: number
  winnerUsername: string | null
  winnerTicket: number | null
}

export interface AdminRaffle {
  id: string
  slug: string
  status: 'draft' | 'open' | 'drawing' | 'drawn' | 'cancelled'
  prizeName: string
  model: string
  category: string
  kind: string
  hue: number
  marketPriceNaira: number
  entryPriceRaffs: number
  entriesTarget: number
  entriesCount: number
  /** entriesCount x entryPriceRaffs */
  raffsCollected: number
  deadline: string
  description: string
  rules: string[]
  prizes: AdminPrize[]
  seedCommitment: string | null
  openedAt: string | null
  drawnAt: string | null
  cancelledAt: string | null
  createdAt: string
}

export interface AdminUserSummary {
  id: string
  telegramId: number
  username: string | null
  fullName: string | null
  phone: string | null
  email: string | null
  status: 'active' | 'suspended' | 'banned'
  balance: number
  signedUpAt: string | null
  lastSeenAt: string | null
  referredByUsername: string | null
}

export interface AdminLedgerRow {
  id: string
  type: string
  raffs: number
  stars: number | null
  balanceAfter: number
  note: string
  createdAt: string
}

export interface AdminUserDetail {
  user: AdminUserSummary & { referralCode: string; tgUsername: string | null; createdAt: string }
  /** SUM(ledger) recomputed now; must equal user.balance */
  ledgerBalance: number
  ledger: AdminLedgerRow[]
  entries: { id: string; raffleName: string; qty: number; raffsSpent: number; ticketFrom: number; ticketTo: number; createdAt: string }[]
  sessions: { id: string; createdAt: string; expiresAt: string; revokedAt: string | null; revokedReason: string | null }[]
  referrals: { people: number; raffsEarned: number }
}

export interface AdminApproval {
  id: string
  action: 'rate_base_change' | 'balance_adjustment' | 'raffle_cancel'
  /** One line a human can approve or reject from */
  summary: string
  payload: Record<string, unknown>
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'failed'
  requestedBy: string
  decidedBy: string | null
  decidedAt: string | null
  result: unknown
  expiresAt: string
  createdAt: string
}

export interface AdminSecurityEvent {
  id: string
  occurredAt: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  category: string
  kind: string
  ipHash: string | null
  userId: string | null
  route: string | null
  requestId: string | null
  details: unknown
  actionTaken: string
}

export interface AdminAuditRow {
  seq: number
  createdAt: string
  admin: string | null
  action: string
  targetType: string | null
  targetId: string | null
  before: unknown
  after: unknown
}

export interface AdminOverview {
  users: { total: number; signedUp: number; signedUpToday: number }
  entries: { today: number; raffsToday: number }
  raffles: { open: number; drafts: number }
  /** Sum of every balance: Raffs Raffle Win owes its players */
  raffsOutstanding: number
  /** SUM(ledger) == SUM(balance_cache) across all users */
  ledgerConsistent: boolean
  pendingApprovals: number
  securityLast24h: Record<'low' | 'medium' | 'high' | 'critical', number>
  rate: { starsPerRaff: number; baseStarsPerRaff: number; movePct: number; expiresAt: string }
}

export interface AdminSettings {
  baseStarsPerRaff: number
  nairaPerStar: number
  maxEntriesPerUserPerRaffle: number | null
  dailySpendRaffs: number | null
}
