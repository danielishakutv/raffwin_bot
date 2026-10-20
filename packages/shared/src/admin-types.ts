/** Shapes the admin API returns, shared with the admin dashboard. */
import type { FeatureKey } from './features'

export type AdminRole = 'super_admin' | 'raffle_manager' | 'finance' | 'support' | 'viewer'

export interface AdminMe {
  id: string
  name: string
  telegramId: number | null
  role: AdminRole
  permissions: string[]
  /** How this session signed in: the bot's Open admin button, or the browser sign-in with a code from the bot */
  channel: 'telegram' | 'browser'
  /** Two admins marked this account at risk: no trusted devices, full checks on every sign-in */
  atRisk: boolean
  /** This session came from a trusted device */
  trustedDevice: boolean
}

/** POST /admin/v1/auth/web/start: secrets accepted, a 6-digit code went to the admin's bound Telegram */
export interface AdminWebLoginChallenge {
  challengeId: string
  expiresAt: number
  /** Where the code went, masked, e.g. "@tok***" */
  sentTo: string
}

/** POST /admin/v1/auth/telegram */
export interface AdminLoginResponse {
  /** Bearer token for the admin API: keep in memory only */
  token: string
  expiresAt: number
  /** The session ends after this many minutes without a request (longer for super admins) */
  idleMinutes: number
  admin: AdminMe
  /** Set when this sign-in trusted the device: keep it on this device only (never send it anywhere else) */
  deviceToken?: string | null
}

/** A device an admin has trusted (Settings > My devices) */
export interface AdminDevice {
  id: string
  channel: 'telegram' | 'browser'
  label: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  revokedReason: string | null
  /** The device this session came from */
  current: boolean
}

/** GET /admin/v1/team: every admin, as any admin may see them, for marking an account at risk */
export interface AdminTeamMember {
  id: string
  name: string
  role: AdminRole
  status: 'active' | 'disabled'
  atRisk: boolean
  riskFlaggedAt: string | null
  riskReason: string | null
  isMe: boolean
  /** A request waiting for a second admin, if any */
  pending: { approvalId: string; action: 'admin_risk_flag' | 'admin_risk_clear'; requestedBy: string; reason: string; requestedByMe: boolean } | null
}

export interface AdminPrize {
  position: number
  prizeItem: string
  prizeType: 'physical' | 'raffs_credit'
  raffsValue: number
  costNaira: number
  winnerUsername: string | null
  /** The winner's verified phone, to arrange delivery (null until drawn, or if they have none) */
  winnerPhone?: string | null
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
  /** "Run again": the raffle this one was copied from */
  copiedFrom: { id: string; prizeName: string } | null
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
  /** True when the phone came from Telegram's signed contact share (app or bot chat) */
  phoneVerified: boolean
  /** The player blocked the bot (or deleted their account): bot messages cannot reach them */
  botBlocked: boolean
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
  /** The admin account bound to this player's Telegram account, if there is one */
  admin: { name: string; role: AdminRole; status: 'active' | 'disabled' } | null
  /** SUM(ledger) recomputed now; must equal user.balance */
  ledgerBalance: number
  ledger: AdminLedgerRow[]
  entries: { id: string; raffleName: string; qty: number; raffsSpent: number; ticketFrom: number; ticketTo: number; createdAt: string }[]
  sessions: { id: string; createdAt: string; expiresAt: string; revokedAt: string | null; revokedReason: string | null }[]
  referrals: { people: number; raffsEarned: number }
  /** Reminders, offers and the streak */
  engagement: {
    remindersOn: boolean
    nextReminderAt: string | null
    remindersSinceLastOpen: number
    lastReminderAt: string | null
    botBlockedAt: string | null
    streak: { current: number; best: number; lastClaimedDay: string | null }
    comebackOffers: { offeredAt: string; expiresAt: string; claimedAt: string | null; raffs: number }[]
  }
  /** Every feature as it applies to this player */
  features: AdminUserFeature[]
  /** Latest bot messages to this player */
  notifications: AdminNotification[]
  /** Delivery details from KYC, for reaching a winner */
  delivery: { state: string; city: string; motorPark: string } | null
}

export interface AdminUserFeature {
  key: FeatureKey
  name: string
  /** The switch for everyone */
  global: boolean
  /** This player's own override, or null */
  override: boolean | null
  /** The live override's id (to clear it), or null when there is none */
  overrideId: string | null
  /** What applies: override ?? global */
  effective: boolean
}

export interface AdminFeature {
  key: FeatureKey
  name: string
  description: string
  audience: 'player' | 'automation'
  /** The switch for everyone */
  enabled: boolean
  defaultEnabled: boolean
  /** Suggested announcement when turning it on for everyone, or null */
  announce: string | null
  /** Live per-player overrides */
  overrides: { on: number; off: number }
  updatedAt: string | null
  updatedBy: string | null
}

export interface AdminFeatureOverride {
  id: string
  userId: string
  username: string | null
  telegramId: number
  enabled: boolean
  note: string
  createdAt: string
  createdBy: string | null
}

export type NotificationKind =
  | 'reminder'
  | 'comeback'
  | 'announcement'
  | 'feature'
  | 'raffle_new'
  | 'raffle_cancelled'
  | 'raffle_drawn'
  | 'raffle_won'
  | 'raffle_soon'
  | 'credit'
  | 'purchase'
  | 'transfer'
  | 'system'

export interface AdminNotification {
  id: string
  kind: NotificationKind
  /** Which reminder text (r01..r16) or template, when there is one */
  templateKey: string | null
  username: string | null
  text: string
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'
  attempts: number
  error: string | null
  notBefore: string
  sentAt: string | null
  createdAt: string
}

export interface AdminBroadcast {
  id: string
  kind: 'announcement' | 'feature' | 'raffle_new' | 'raffle_cancelled' | 'raffle_drawn' | 'raffle_soon'
  title: string
  text: string
  openButton: boolean
  /** Human-readable audience, e.g. "Everyone" or "Inactive 3+ days" */
  audienceLabel: string
  status: 'fanning_out' | 'sending' | 'done' | 'cancelled'
  /** Players queued so far */
  total: number
  sent: number
  /** Telegram refused or errored after retries */
  failed: number
  /** Not attempted: stopped by an admin, the player blocked the bot, or was suspended */
  skipped: number
  pending: number
  createdBy: string | null
  createdAt: string
  finishedAt: string | null
}

/** One of the rotating reminder texts, for the admin to read */
export interface AdminReminderText {
  key: string
  text: string
}

export interface AdminEngagement {
  reminderMinHours: number
  reminderMaxHours: number
  maxRemindersPerSpell: number
  quietStartHour: number
  quietEndHour: number
  comebackAfterHours: number
  comebackRaffs: number
  comebackCooldownDays: number
  streakRewards: number[]
  transferMinRaffs: number
  transferDailyMaxRaffs: number
  reminderTexts: AdminReminderText[]
  /** Outbox health */
  outbox: { pending: number; sentLast24h: number; failedLast24h: number; blockedPlayers: number }
}

export interface AdminApproval {
  id: string
  action: 'rate_base_change' | 'balance_adjustment' | 'raffle_cancel' | 'admin_risk_flag' | 'admin_risk_clear' | 'sales_options_change' | 'voucher_batch_create' | 'balance_adjustment_bulk'
  /** One line a human can approve or reject from */
  summary: string
  payload: Record<string, unknown>
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'failed'
  requestedBy: string
  requestedByAdminId: string
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
  rate: { nairaPerRaff: number; baseNairaPerRaff: number; movePct: number; expiresAt: string }
  /** Players with a phone on file (verified through Telegram) and without */
  phones: { withPhone: number; withoutPhone: number }
  /** Bot reach: players who blocked the bot can get no messages */
  bot: { reachable: number; blocked: number; sentLast24h: number; pending: number }
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
  /** Report rate: the base naira price of a Raff (Settings > Rate and sales) */
  nairaPerRaff: number
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
  /** Real money in: naira paid on the sales site, and the Raffs it bought (bonus included) */
  cash: { purchases: number; nairaReceived: number; raffsSold: number; bonusRaffs: number }
  /** Raffs handed out without payment in the period: bonuses, admin credits, Raffs prizes, referral pay */
  freeRaffs: { bonus: number; adjustments: number; prizes: number; referrals: number }
  /** Raffs players hold right now: what Raffle Win owes in entries */
  outstandingRaffs: number
}

export interface AdminVoucherBatch {
  id: string
  vendor: string
  note: string
  valueRaffs: number
  count: number
  redeemed: number
  voided: number
  expiresAt: string | null
  createdAt: string
  /** When the codes were generated and handed over; null = approved, not yet issued */
  codesIssuedAt: string | null
  voidedAt: string | null
  voidReason: string | null
  status: 'ready' | 'issued' | 'expired' | 'void'
}

export type AdminVoucherLookup =
  | { found: false }
  | {
      found: true
      status: 'active' | 'redeemed' | 'void' | 'expired'
      batchId: string
      vendor: string
      valueRaffs: number
      expiresAt: string | null
      redeemedAt: string | null
      redeemedBy: { userId: string; username: string | null; telegramId: number | null } | null
    }

export interface AdminSettings {
  /** The base price and how far each hour may move from it */
  rate: { nairaPerRaff: number; moveMinPct: number; moveMaxPct: number }
  /** What the sales site offers */
  sales: { packages: { naira: number; bonusPercent: number; label: string | null }[]; minNaira: number; maxNaira: number }
  maxEntriesPerUserPerRaffle: number | null
  dailySpendRaffs: number | null
}
