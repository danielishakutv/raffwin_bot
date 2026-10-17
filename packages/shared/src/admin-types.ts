/** Shapes the admin API returns, shared with the admin dashboard. */

export type AdminRole = 'super_admin' | 'raffle_manager' | 'finance' | 'support' | 'viewer'

export interface AdminMe {
  id: string
  name: string
  telegramId: number | null
  role: AdminRole
  permissions: string[]
}

/** POST /admin/v1/auth/telegram */
export interface AdminLoginResponse {
  /** Bearer token for the admin API: keep in memory only */
  token: string
  expiresAt: number
  /** The session ends after this many minutes without a request (longer for super admins) */
  idleMinutes: number
  admin: AdminMe
}

export interface AdminPrize {
  position: number
  prizeItem: string
  prizeType: 'physical' | 'raffs_credit'
  raffsValue: number
  costNaira: number
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
  imageUrl: string | null
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
  users: { total: number; signedUp: number; signedUpToday: number; activeLast7Days: number }
  /** All time: Raffs spent on entries (net of refunds) and their Naira value at the current base rate */
  raised: { raffs: number; naira: number; nairaPerRaff: number }
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

export interface AdminExpense {
  id: string
  raffleId: string | null
  raffleName: string | null
  category: string
  amountNaira: number
  spentOn: string
  note: string
  createdBy: string
  voidedAt: string | null
  voidReason: string | null
}

export interface FinancePrize {
  position: number
  prizeItem: string
  prizeType: 'physical' | 'raffs_credit'
  /** Physical: what you paid. Raffs credit: its Raffs value at the report rate */
  costNaira: number
  raffsValue: number
}

export interface FinanceRaffle {
  id: string
  prizeName: string
  status: string
  deadline: string
  entryPriceRaffs: number
  entriesSold: number
  entriesTarget: number
  /** Raffs spent on entries in the period, net of refunds */
  raisedRaffs: number
  raisedNaira: number
  refundedRaffs: number
  prizes: FinancePrize[]
  /** Counted for open, drawing and drawn raffles; 0 for drafts and cancelled ones */
  prizeCostNaira: number
  referralRaffs: number
  referralNaira: number
  expensesNaira: number
  /** raised - prize cost - referral payouts - linked expenses */
  marginNaira: number
}

export interface AdminFinance {
  period: { from: string | null; to: string | null }
  /** Report rate: base Stars per Raff x Naira per Star (display setting) */
  nairaPerRaff: number
  nairaPerStar: number
  raffles: FinanceRaffle[]
  totals: {
    raisedRaffs: number
    raisedNaira: number
    prizeCostNaira: number
    referralNaira: number
    raffleExpensesNaira: number
    generalExpensesNaira: number
    /** Sum of raffle margins minus general expenses */
    profitNaira: number
  }
  /** Real money in: Telegram Stars paid for Raffs */
  cash: { starsReceived: number; starsNaira: number; raffsSold: number }
  /** Raffs handed out without payment in the period: bonuses, admin credits, Raffs prizes, referral pay */
  freeRaffs: { bonus: number; adjustments: number; prizes: number; referrals: number }
  /** Raffs players hold right now: what Raffle Win owes in entries */
  outstandingRaffs: number
}

export interface AdminSettings {
  baseStarsPerRaff: number
  nairaPerStar: number
  maxEntriesPerUserPerRaffle: number | null
  dailySpendRaffs: number | null
}
