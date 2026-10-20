/**
 * Database schema, milestone 1: accounts, sessions, addresses, security events.
 * docs/ARCHITECTURE.md section 4 is the full model; tables arrive with the
 * milestone that uses them.
 *
 * Production runs PostgreSQL 14, development 17: nothing here
 * may need a feature newer than 14.
 */
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  customType,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

/**
 * One row per Telegram account, created the first time it opens the Mini App.
 * The Raffle Win profile (username, name, email, verified phone) is filled at
 * sign-up; until then signed_up_at is null and the app shows the sign-up form.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
    // What Telegram reported on the latest auth; display only, never trusted for identity
    tgUsername: text('tg_username'),
    tgFirstName: text('tg_first_name'),
    tgLastName: text('tg_last_name'),
    tgLanguageCode: text('tg_language_code'),
    tgIsPremium: boolean('tg_is_premium').notNull().default(false),
    tgPlatform: text('tg_platform'),

    // Raffle Win profile, set at sign-up. Usernames are stored lower-case.
    username: text('username'),
    fullName: text('full_name'),
    email: text('email'),
    phone: text('phone'),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),

    status: text('status', { enum: ['active', 'suspended', 'banned'] }).notNull().default('active'),
    referralCode: text('referral_code').notNull(),
    /** The referral code seen on the first open(s) before sign-up; resolved at sign-up. */
    pendingReferralCode: text('pending_referral_code'),
    referredByUserId: uuid('referred_by_user_id').references((): AnyPgColumn => users.id),
    referredAt: timestamp('referred_at', { withTimezone: true }),

    contactWhatsapp: boolean('contact_whatsapp').notNull().default(true),
    contactTelegram: boolean('contact_telegram').notNull().default(true),
    contactEmail: boolean('contact_email').notNull().default(false),

    /** Maintained in the same transaction as every ledger row (milestone 2). */
    balanceCache: integer('balance_cache').notNull().default(0),

    /** Set on first open (there is no sign-up form since 16 Oct) */
    signedUpAt: timestamp('signed_up_at', { withTimezone: true }),
    /** Name, verified phone and delivery point all given on the KYC page */
    kycCompletedAt: timestamp('kyc_completed_at', { withTimezone: true }),
    onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),

    /* Bot messages (reminders, offers, announcements) ----------------------- */
    /** Telegram refused a message because the player blocked the bot (or left); cleared when they start it again */
    botBlockedAt: timestamp('bot_blocked_at', { withTimezone: true }),
    /** The player turned reminders and offers off (app, or the button under a reminder) */
    remindersOptOutAt: timestamp('reminders_opt_out_at', { withTimezone: true }),
    /** When the next inactivity reminder is due: last open + 6..10 h (random), reset on every open */
    nextReminderAt: timestamp('next_reminder_at', { withTimezone: true }),
    /** Reminders sent since the player last opened the app */
    remindersSinceOpen: integer('reminders_since_open').notNull().default(0),
    lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_telegram_id_key').on(t.telegramId),
    index('users_next_reminder_idx').on(t.nextReminderAt).where(sql`${t.nextReminderAt} is not null`),
    index('users_last_seen_idx').on(t.lastSeenAt),
    uniqueIndex('users_username_key').on(t.username).where(sql`${t.username} is not null`),
    // One verified phone, one account (section 5)
    uniqueIndex('users_phone_key').on(t.phone).where(sql`${t.phone} is not null`),
    uniqueIndex('users_referral_code_key').on(t.referralCode),
    index('users_referred_by_idx').on(t.referredByUserId),
  ],
)

/**
 * Refresh-token sessions. Each refresh replaces the row with a new one in the
 * same family; presenting a token that was already replaced means it was
 * copied, and the whole family is revoked.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    familyId: uuid('family_id').notNull(),
    /** sha256 of the opaque refresh token; the token itself is never stored */
    refreshTokenHash: text('refresh_token_hash').notNull(),
    replacedBySessionId: uuid('replaced_by_session_id'),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sessions_refresh_token_hash_key').on(t.refreshTokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_family_idx').on(t.familyId),
  ],
)

/** Every initData string exchanged for a session, for replay detection. */
export const initDataUses = pgTable('initdata_uses', {
  /** sha256 of the full initData string */
  hash: text('hash').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
  useCount: integer('use_count').notNull().default(1),
  /** auth_date + max age: past this the row has no further use */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  firstUsedAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * DEPRECATED (16 Oct): street addresses are no longer collected; prizes go to
 * the winner's nearest motor park (delivery_points). Kept, unused, rather
 * than dropped, so no migration removes data.
 */
export const addresses = pgTable('addresses', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  street: text('street').notNull(),
  city: text('city').notNull(),
  state: text('state').notNull(),
  landmark: text('landmark').notNull().default(''),
  phone: text('phone').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/**
 * Rejected or suspicious requests (section 9). Insert-only from the API.
 * fingerprint groups repeats: ip_hash + category + route.
 */
export const securityEvents = pgTable(
  'security_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    severity: text('severity', { enum: ['low', 'medium', 'high', 'critical'] }).notNull(),
    category: text('category', {
      enum: ['auth', 'initdata', 'webhook', 'ratelimit', 'waf', 'fraud', 'admin', 'integrity', 'relay'],
    }).notNull(),
    /** Short machine name of what happened, e.g. initdata_bad_hash */
    kind: text('kind').notNull(),
    fingerprint: text('fingerprint').notNull(),
    ipHash: text('ip_hash'),
    userId: uuid('user_id'),
    route: text('route'),
    requestId: text('request_id'),
    details: jsonb('details').notNull().default({}),
    actionTaken: text('action_taken', { enum: ['none', 'throttled', 'blocked', 'banned'] })
      .notNull()
      .default('none'),
  },
  (t) => [
    index('security_events_occurred_idx').on(t.occurredAt),
    index('security_events_fingerprint_idx').on(t.fingerprint, t.occurredAt),
  ],
)

/**
 * Where a winner collects a physical prize: their city and the nearest motor
 * park, never a house address (security decision of 16 Oct). Filled on the
 * KYC page together with the name and the Telegram-verified phone.
 */
export const deliveryPoints = pgTable('delivery_points', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  state: text('state').notNull(),
  city: text('city').notNull(),
  motorPark: text('motor_park').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/**
 * A referral code seen by the bot before the person ever opened the app
 * (`/start ref_<code>` from a https://t.me/<bot>?start=ref_<code> link). Used
 * once, when that Telegram account's app account is created. First invite wins.
 */
export const referralHints = pgTable('referral_hints', {
  telegramId: bigint('telegram_id', { mode: 'number' }).primaryKey(),
  code: text('code').notNull(),
  createdAt: createdAt(),
})

export type UserRow = typeof users.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type AddressRow = typeof addresses.$inferSelect
export type DeliveryPointRow = typeof deliveryPoints.$inferSelect

/* ============================================================================
 * Milestone 2: settings, rates, raffles, entries, ledger, referrals, admin
 * ========================================================================== */

/** Remote config and feature flags, edited from the admin (the rate base needs approval). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedByAdminId: uuid('updated_by_admin_id'),
  updatedAt: updatedAt(),
})

/**
 * One quote per clock hour, issued on first use by whoever asks first (the
 * unique hour_start makes concurrent issuers agree). Rates are integers in
 * millionths of a Star per Raff, so no float ever touches money.
 */
export const rateQuotes = pgTable(
  'rate_quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hourStart: timestamp('hour_start', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Quotes before 19 Oct were in Stars; null since the naira base */
    starsPerRaffMicro: integer('stars_per_raff_micro'),
    baseStarsPerRaffMicro: integer('base_stars_per_raff_micro'),
    /** Signed move from the base in millionths, e.g. -84000 = -8.4% */
    moveMicro: integer('move_micro').notNull(),
    /** The price of one Raff this hour, in kobo. What a purchase is credited at. */
    nairaPerRaffKobo: integer('naira_per_raff_kobo').notNull(),
    /** The admin's base the move was applied to; null on the old Stars quotes */
    baseNairaPerRaffKobo: integer('base_naira_per_raff_kobo'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('rate_quotes_hour_start_key').on(t.hourStart)],
)

export const RAFFLE_KINDS = ['phone', 'laptop', 'tv', 'earbuds', 'powerbank', 'voucher', 'console'] as const

export const raffles = pgTable(
  'raffles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    prizeName: text('prize_name').notNull(),
    model: text('model').notNull().default(''),
    category: text('category').notNull(),
    kind: text('kind', { enum: RAFFLE_KINDS }).notNull(),
    hue: integer('hue').notNull().default(260),
    /** https address or /v1/media/<id> (an upload in the media table); null = drawn illustration */
    imageUrl: text('image_url'),
    marketPriceNaira: integer('market_price_naira').notNull(),
    /** Fixed once the raffle opens */
    entryPriceRaffs: integer('entry_price_raffs').notNull(),
    entriesTarget: integer('entries_target').notNull(),
    /** Maintained inside the entry transaction, under the raffle's row lock */
    entriesCount: integer('entries_count').notNull().default(0),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    status: text('status', { enum: ['draft', 'open', 'drawing', 'drawn', 'cancelled'] }).notNull().default('draft'),
    description: text('description').notNull().default(''),
    rules: jsonb('rules').$type<string[]>().notNull().default([]),
    /** sha256 of the secret seed, published when the raffle opens (milestone 4) */
    seedCommitment: text('seed_commitment'),
    /**
     * The secret seed behind seed_commitment (32 random bytes, hex). Never shown
     * before the draw; published with the winners so anyone can re-run it.
     */
    drawSeed: text('draw_seed'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    drawnAt: timestamp('drawn_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdByAdminId: uuid('created_by_admin_id'),
    /** "Run again": the raffle this draft was copied from (which itself never changes) */
    copiedFromRaffleId: uuid('copied_from_raffle_id').references((): AnyPgColumn => raffles.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('raffles_slug_key').on(t.slug), index('raffles_status_deadline_idx').on(t.status, t.deadline)],
)

export const rafflePrizes = pgTable(
  'raffle_prizes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    raffleId: uuid('raffle_id')
      .notNull()
      .references(() => raffles.id),
    position: integer('position').notNull(),
    prizeItem: text('prize_item').notNull(),
    prizeType: text('prize_type', { enum: ['physical', 'raffs_credit'] }).notNull(),
    /** For raffs_credit prizes: credited to the winner by the draw */
    raffsValue: integer('raffs_value').notNull().default(0),
    /** What this prize costs Raffle Win to buy, in Naira (physical prizes); for finance */
    costNaira: integer('cost_naira').notNull().default(0),
    winnerUserId: uuid('winner_user_id').references(() => users.id),
    winnerTicket: integer('winner_ticket'),
    fulfilmentStatus: text('fulfilment_status', {
      enum: ['pending', 'contacted', 'confirmed', 'dispatched', 'delivered', 'forfeited'],
    }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('raffle_prizes_position_key').on(t.raffleId, t.position)],
)

export const entries = pgTable(
  'entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    raffleId: uuid('raffle_id')
      .notNull()
      .references(() => raffles.id),
    qty: integer('qty').notNull(),
    raffsSpent: integer('raffs_spent').notNull(),
    /** Contiguous, assigned under the raffle's row lock; inclusive */
    ticketFrom: integer('ticket_from').notNull(),
    ticketTo: integer('ticket_to').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('entries_idempotency_key').on(t.userId, t.idempotencyKey),
    uniqueIndex('entries_ticket_from_key').on(t.raffleId, t.ticketFrom),
    index('entries_user_idx').on(t.userId, t.createdAt),
    index('entries_raffle_idx').on(t.raffleId, t.createdAt),
  ],
)

export const LEDGER_TYPES = [
  'purchase',
  'entry',
  'bonus',
  'prize',
  'refund',
  'referral',
  'referral_reversal',
  'adjustment',
  /** Raffs received from another player (raffs_transfers) */
  'transfer_in',
  /** Raffs sent to another player */
  'transfer_out',
  /** A voucher code redeemed in the Mini App (vouchers) */
  'voucher',
] as const

/**
 * Every Raffs movement. Insert-only; a user's balance is SUM(raffs), and
 * users.balance_cache is kept equal to it in the same transaction.
 */
export const ledger = pgTable(
  'ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type', { enum: LEDGER_TYPES }).notNull(),
    raffs: integer('raffs').notNull(),
    stars: integer('stars'),
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    note: text('note').notNull(),
    /** Balance after this row, for statements and the nightly integrity check */
    balanceAfter: integer('balance_after').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_user_idx').on(t.userId, t.createdAt),
    index('ledger_reference_idx').on(t.referenceType, t.referenceId),
  ],
)

/**
 * Raffs bought on the sales site, credited through the relay. Insert-only.
 * The payment reference is unique: a repeat of the same payment can never
 * credit twice. Amounts are what the buyer was quoted, checked against the
 * hourly quote they name (services/purchases.ts).
 */
export const purchases = pgTable(
  'purchases',
  {
    id: uuid('id').primaryKey(),
    reference: text('reference').notNull(),
    source: text('source', { enum: ['paystack'] }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
    /** The sales site's quote */
    quoteId: uuid('quote_id').notNull(),
    nairaKobo: integer('naira_kobo').notNull(),
    rateId: uuid('rate_id')
      .notNull()
      .references(() => rateQuotes.id),
    nairaPerRaffKobo: integer('naira_per_raff_kobo').notNull(),
    baseRaffs: integer('base_raffs').notNull(),
    bonusRaffs: integer('bonus_raffs').notNull(),
    raffs: integer('raffs').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => ledger.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('purchases_reference_key').on(t.reference), index('purchases_user_idx').on(t.userId, t.createdAt), index('purchases_created_idx').on(t.createdAt)],
)

/**
 * Vouchers sold offline by vendors. An admin asks for a batch (vendor, value,
 * how many) and a second admin approves it; the codes are then generated and
 * handed over once (services/vouchers.ts). Only a SHA-256 of each code is
 * stored: 16 random characters from a 32-letter alphabet are 80 bits, beyond
 * guessing, and a stolen table cannot be turned back into codes.
 */
export const voucherBatches = pgTable(
  'voucher_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vendor: text('vendor').notNull(),
    note: text('note').notNull().default(''),
    valueRaffs: integer('value_raffs').notNull(),
    codeCount: integer('code_count').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    approvalId: uuid('approval_id').references(() => approvals.id),
    requestedByAdminId: uuid('requested_by_admin_id')
      .notNull()
      .references(() => adminUsers.id),
    /** Set once, when the codes were generated and handed to an admin; never again */
    codesIssuedAt: timestamp('codes_issued_at', { withTimezone: true }),
    codesIssuedByAdminId: uuid('codes_issued_by_admin_id').references(() => adminUsers.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByAdminId: uuid('voided_by_admin_id').references(() => adminUsers.id),
    voidReason: text('void_reason'),
    createdAt: createdAt(),
  },
  (t) => [index('voucher_batches_created_idx').on(t.createdAt)],
)

export const vouchers = pgTable(
  'vouchers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => voucherBatches.id),
    codeHash: text('code_hash').notNull(),
    /** The last 4 characters, so support can talk about a code without holding it */
    codeTail: text('code_tail').notNull(),
    status: text('status', { enum: ['active', 'redeemed', 'void'] }).notNull().default('active'),
    redeemedByUserId: uuid('redeemed_by_user_id').references(() => users.id),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    ledgerId: uuid('ledger_id').references(() => ledger.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByAdminId: uuid('voided_by_admin_id').references(() => adminUsers.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('vouchers_code_hash_key').on(t.codeHash), index('vouchers_batch_idx').on(t.batchId, t.status), index('vouchers_redeemed_by_idx').on(t.redeemedByUserId)],
)

export const referralEarnings = pgTable(
  'referral_earnings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    referrerUserId: uuid('referrer_user_id')
      .notNull()
      .references(() => users.id),
    referredUserId: uuid('referred_user_id')
      .notNull()
      .references(() => users.id),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entries.id),
    raffs: integer('raffs').notNull(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => ledger.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalLedgerId: uuid('reversal_ledger_id').references(() => ledger.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('referral_earnings_entry_key').on(t.entryId),
    index('referral_earnings_referrer_idx').on(t.referrerUserId, t.createdAt),
  ],
)

/* Admin ------------------------------------------------------------------- */

export const ADMIN_ROLES = ['super_admin', 'raffle_manager', 'finance', 'support', 'viewer'] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]

export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Two ways in (decision of 16 Oct):
     *  - Telegram: opening the bot as this Telegram account is enough. The id
     *    is linked automatically the first time the account whose username
     *    matches telegram_username opens the bot.
     *  - Browser: the secret admin URL, the master password, then username + password.
     */
    telegramId: bigint('telegram_id', { mode: 'number' }),
    /** Lower-case, without @; used only to link telegram_id on first open */
    telegramUsername: text('telegram_username'),
    /** Browser sign-in name, lower-case */
    username: text('username'),
    /** argon2id; null = this admin works from Telegram only */
    passwordHash: text('password_hash'),
    /** Optional contact, stored lower-case */
    email: text('email'),
    name: text('name').notNull(),
    /** Not used since 16 Oct (no codes); kept nullable rather than dropped */
    totpSecretEnc: text('totp_secret_enc'),
    /** Last accepted TOTP time step, so one code cannot be used twice */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    role: text('role', { enum: ADMIN_ROLES }).notNull(),
    status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /**
     * Marked at risk by two other admins (approval admin_risk_flag). While set,
     * trusted devices do not work and every sign-in takes the full checks;
     * cleared the same way (admin_risk_clear).
     */
    riskFlaggedAt: timestamp('risk_flagged_at', { withTimezone: true }),
    riskReason: text('risk_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('admin_users_email_key').on(t.email),
    uniqueIndex('admin_users_telegram_id_key').on(t.telegramId).where(sql`${t.telegramId} is not null`),
    uniqueIndex('admin_users_username_key').on(t.username).where(sql`${t.username} is not null`),
    uniqueIndex('admin_users_telegram_username_key').on(t.telegramUsername).where(sql`${t.telegramUsername} is not null`),
  ],
)

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => adminUsers.id),
    tokenHash: text('token_hash').notNull(),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** telegram: the bot's Open admin button; browser: desktop sign-in with a code from the bot */
    channel: text('channel', { enum: ['telegram', 'browser'] }).notNull().default('telegram'),
    /** The trusted device that opened it (admin_devices); null = a full sign-in. Revoking the device ends it. */
    deviceId: uuid('device_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('admin_sessions_token_key').on(t.tokenHash), index('admin_sessions_admin_idx').on(t.adminId)],
)

/**
 * The bot's admin login conversation (hidden command -> master password ->
 * username -> password). Kept in the database so it survives restarts and
 * works across API processes. One row per Telegram account.
 */
export const adminLoginFlows = pgTable(
  'admin_login_flows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    step: text('step', { enum: ['master', 'username', 'password', 'idle'] }).notNull(),
    username: text('username'),
    /** Wrong master passwords or admin passwords in a row; 5 locks this Telegram account for an hour */
    failedCount: integer('failed_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('admin_login_flows_telegram_key').on(t.telegramId)],
)

/** One-time, 5-minute tickets the bot hands out after a successful command login. */
export const adminTickets = pgTable(
  'admin_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => adminUsers.id),
    telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('admin_tickets_token_key').on(t.tokenHash)],
)

/**
 * Tamper-evident log of every admin action: each row's hash covers its own
 * content and the previous row's hash, so editing or removing any row breaks
 * the chain from that point on. Insert-only.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    adminId: uuid('admin_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ipHash: text('ip_hash'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('audit_log_seq_key').on(t.seq), index('audit_log_target_idx').on(t.targetType, t.targetId)],
)

export const APPROVAL_ACTIONS = ['rate_base_change', 'balance_adjustment', 'raffle_cancel', 'admin_risk_flag', 'admin_risk_clear', 'sales_options_change', 'voucher_batch_create', 'balance_adjustment_bulk'] as const

/** Maker-checker: a sensitive action runs only when a second admin approves it. */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: text('action', { enum: APPROVAL_ACTIONS }).notNull(),
    payload: jsonb('payload').notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'failed'] }).notNull().default('pending'),
    requestedByAdminId: uuid('requested_by_admin_id')
      .notNull()
      .references(() => adminUsers.id),
    decidedByAdminId: uuid('decided_by_admin_id').references(() => adminUsers.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** What executing it produced, or why it failed */
    result: jsonb('result'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('approvals_status_idx').on(t.status, t.createdAt)],
)

export const EXPENSE_CATEGORIES = ['prize_purchase', 'delivery', 'marketing', 'fees', 'operations', 'other'] as const

/**
 * Money spent, recorded by finance admins: per raffle (delivery of its prize,
 * its ads) or general (servers, fees). Never deleted: a wrong entry is voided
 * with a reason and stops counting.
 */
export const financeExpenses = pgTable(
  'finance_expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    raffleId: uuid('raffle_id').references(() => raffles.id),
    category: text('category', { enum: EXPENSE_CATEGORIES }).notNull(),
    amountNaira: integer('amount_naira').notNull(),
    spentOn: timestamp('spent_on', { withTimezone: true }).notNull(),
    note: text('note').notNull(),
    createdByAdminId: uuid('created_by_admin_id')
      .notNull()
      .references(() => adminUsers.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByAdminId: uuid('voided_by_admin_id').references(() => adminUsers.id),
    voidReason: text('void_reason'),
    createdAt: createdAt(),
  },
  (t) => [index('finance_expenses_spent_idx').on(t.spentOn), index('finance_expenses_raffle_idx').on(t.raffleId)],
)

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

/**
 * Images admins upload for raffles, served publicly at GET /v1/media/<id>.
 * Kept in the database so they are in the nightly backup with everything else.
 * The same file uploaded twice is stored once (sha256).
 */
export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mime: text('mime').notNull(),
    bytes: bytea('bytes').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    sha256: text('sha256').notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminUsers.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('media_sha256_key').on(t.sha256)],
)

/* ============================================================================
 * Engagement: feature switches, bot messages, offers, streaks, transfers,
 * browser admin sign-in
 * ========================================================================== */

/**
 * The global switch per feature (packages/shared/src/features.ts lists them).
 * No row = the feature's default.
 */
export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull(),
  updatedByAdminId: uuid('updated_by_admin_id').references(() => adminUsers.id),
  updatedAt: updatedAt(),
})

/**
 * Per-player overrides of a feature switch. Removing one sets cleared_at, so
 * the history of who had what stays; at most one live override per player.
 */
export const featureFlagOverrides = pgTable(
  'feature_flag_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flagKey: text('flag_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    enabled: boolean('enabled').notNull(),
    note: text('note').notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminUsers.id),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    clearedByAdminId: uuid('cleared_by_admin_id').references(() => adminUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('feature_flag_overrides_live_key').on(t.flagKey, t.userId).where(sql`${t.clearedAt} is null`),
    index('feature_flag_overrides_user_idx').on(t.userId),
  ],
)

export const BROADCAST_KINDS = ['announcement', 'feature', 'raffle_new', 'raffle_cancelled', 'raffle_drawn', 'raffle_soon'] as const

/**
 * One message to many players. Created by an admin (notice, announcement), by
 * turning a feature on, or by a raffle opening. A worker fans it out into
 * notifications in batches (cursor_user_id), so a million players never means
 * one huge transaction.
 */
export const broadcasts = pgTable(
  'broadcasts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: BROADCAST_KINDS }).notNull(),
    title: text('title').notNull().default(''),
    /** Plain text as the admin wrote it (escaped when sent) */
    text: text('text').notNull(),
    openButton: boolean('open_button').notNull().default(true),
    /** BroadcastAudience (admin-schemas); for type 'users', usernames are already resolved to user ids */
    audience: jsonb('audience').notNull(),
    status: text('status', { enum: ['fanning_out', 'sending', 'done', 'cancelled'] }).notNull().default('fanning_out'),
    /** Fan-out progress: users are queued in id order after this one */
    cursorUserId: uuid('cursor_user_id'),
    total: integer('total').notNull().default(0),
    /** What caused it, e.g. raffle + <id> or feature + <key> */
    refType: text('ref_type'),
    refId: text('ref_id'),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminUsers.id),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('broadcasts_status_idx').on(t.status, t.createdAt)],
)

export const NOTIFICATION_KINDS = [
  'reminder',
  'comeback',
  'announcement',
  'feature',
  'raffle_new',
  'raffle_cancelled',
  /** Winners announced: to the raffle's entrants and to players with new-raffle alerts on */
  'raffle_drawn',
  /** A winner's own message */
  'raffle_won',
  /** Before a draw (1 h, 30 min, 5 min): to entrants with their tickets, and "last chance" to everyone else */
  'raffle_soon',
  /** Raffs credited by an admin (an approved or direct balance adjustment) */
  'credit',
  /** Raffs bought on the sales site arrived */
  'purchase',
  'transfer',
  /** To a referrer: someone joined with their link, or one of their referrals topped up */
  'referral',
  'system',
] as const

export interface NotificationButton {
  text: string
  /** Opens the Mini App at this URL */
  webApp?: string
  /** Sent back to the bot as a callback query */
  callbackData?: string
}

/**
 * The bot's outbox: one row per message to one player. The sender claims
 * pending rows (FOR UPDATE SKIP LOCKED), sends at a pace Telegram accepts, and
 * records the outcome. Never deleted, so the admin can always see what each
 * player was sent and why something failed.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Private chat id = the player's Telegram id */
    telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
    kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
    /** Which reminder text (r01..) or template produced it */
    templateKey: text('template_key'),
    /** Telegram HTML, ready to send */
    text: text('text').notNull(),
    /** Inline keyboard rows */
    buttons: jsonb('buttons').$type<NotificationButton[][]>(),
    broadcastId: uuid('broadcast_id').references(() => broadcasts.id),
    /** Makes an enqueue idempotent per player, e.g. raffle_new:<raffleId> */
    dedupeKey: text('dedupe_key'),
    status: text('status', { enum: ['pending', 'sending', 'sent', 'failed', 'skipped'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Not sent before this (quiet hours, Telegram's retry_after, backoff) */
    notBefore: timestamp('not_before', { withTimezone: true }).notNull().defaultNow(),
    /** When a sender claimed it; a claim older than a few minutes is taken back */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_due_idx').on(t.status, t.notBefore),
    index('notifications_user_idx').on(t.userId, t.createdAt),
    index('notifications_broadcast_idx').on(t.broadcastId, t.status),
    uniqueIndex('notifications_dedupe_key').on(t.userId, t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
  ],
)

/**
 * "Come back and get 1 free Raff": offered once per spell away (a spell starts
 * at the last open, spell_started_at), credited on the next open before it expires.
 */
export const comebackOffers = pgTable(
  'comeback_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    raffs: integer('raffs').notNull(),
    /** users.last_seen_at when the offer was made: one offer per spell away */
    spellStartedAt: timestamp('spell_started_at', { withTimezone: true }).notNull(),
    offeredAt: timestamp('offered_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    ledgerId: uuid('ledger_id').references(() => ledger.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('comeback_offers_spell_key').on(t.userId, t.spellStartedAt),
    index('comeback_offers_user_idx').on(t.userId, t.offeredAt),
  ],
)

/** One row per Lagos calendar day a player claimed the daily streak bonus. Insert-only. */
export const dailyCheckins = pgTable(
  'daily_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Lagos calendar day, YYYY-MM-DD */
    day: date('day', { mode: 'string' }).notNull(),
    /** Streak length including this day */
    streak: integer('streak').notNull(),
    raffs: integer('raffs').notNull(),
    ledgerId: uuid('ledger_id').references(() => ledger.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('daily_checkins_user_day_key').on(t.userId, t.day)],
)

/** Raffs sent from one player to another (feature raffs_transfer). Insert-only. */
export const raffsTransfers = pgTable(
  'raffs_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id),
    raffs: integer('raffs').notNull(),
    note: text('note').notNull().default(''),
    idempotencyKey: uuid('idempotency_key').notNull(),
    outLedgerId: uuid('out_ledger_id')
      .notNull()
      .references(() => ledger.id),
    inLedgerId: uuid('in_ledger_id')
      .notNull()
      .references(() => ledger.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('raffs_transfers_idempotency_key').on(t.fromUserId, t.idempotencyKey),
    index('raffs_transfers_from_idx').on(t.fromUserId, t.createdAt),
    index('raffs_transfers_to_idx').on(t.toUserId, t.createdAt),
  ],
)

/**
 * Browser (desktop) admin sign-in: after the master password, username and
 * password are accepted, a 6-digit code goes to the admin's bound Telegram
 * account through the bot. Five wrong codes or five minutes end the challenge.
 */
/**
 * Trusted devices (decision of 19 Oct): the full sign-in (master password,
 * username, password, and the bot's code or ticket) is needed on a device
 * the first time only. It then registers the device, which holds a random
 * secret (sha256 stored here). From then on:
 *   telegram: the bound Telegram account opening the Mini App on that device
 *             signs in with one tap (initData + device secret);
 *   browser:  the device secret plus the admin's own password.
 * Revoked by the admin (Settings), by a password reset, and all at once when
 * two admins mark the account at risk.
 */
export const adminDevices = pgTable(
  'admin_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => adminUsers.id),
    channel: text('channel', { enum: ['telegram', 'browser'] }).notNull(),
    secretHash: text('secret_hash').notNull(),
    /** What the admin sees in the device list, e.g. "Telegram (ios)" or a browser name */
    label: text('label').notNull(),
    userAgent: text('user_agent'),
    ipHash: text('ip_hash'),
    /** Wrong admin passwords in a row on this browser device; 5 revoke it */
    failedCount: integer('failed_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('admin_devices_secret_key').on(t.secretHash), index('admin_devices_admin_idx').on(t.adminId, t.createdAt)],
)

/**
 * Draw reminders already sent: one row per raffle, stage (minutes before the
 * draw: 60, 30, 5) and deadline, so each goes out once, and moving a deadline
 * arms them again. Written in the transaction that queues the messages.
 */
export const raffleReminders = pgTable(
  'raffle_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    raffleId: uuid('raffle_id')
      .notNull()
      .references(() => raffles.id),
    stage: integer('stage').notNull(),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    /** Entrants messaged directly; null for a stage passed over (a closer one was sent instead) */
    entrantsTold: integer('entrants_told'),
    /** The "last chance" broadcast to everyone else, if one went out */
    broadcastId: uuid('broadcast_id').references(() => broadcasts.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('raffle_reminders_once_key').on(t.raffleId, t.stage, t.deadline)],
)

export const adminWebLogins = pgTable(
  'admin_web_logins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => adminUsers.id),
    /** sha256 of challenge id + code */
    codeHash: text('code_hash').notNull(),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('admin_web_logins_admin_idx').on(t.adminId, t.createdAt)],
)

export type NotificationRow = typeof notifications.$inferSelect
export type BroadcastRow = typeof broadcasts.$inferSelect
export type RaffleRow = typeof raffles.$inferSelect
export type RafflePrizeRow = typeof rafflePrizes.$inferSelect
export type EntryRow = typeof entries.$inferSelect
export type LedgerRow = typeof ledger.$inferSelect
export type VoucherBatchRow = typeof voucherBatches.$inferSelect
export type VoucherRow = typeof vouchers.$inferSelect
export type PurchaseRow = typeof purchases.$inferSelect
export type AdminUserRow = typeof adminUsers.$inferSelect
export type AdminDeviceRow = typeof adminDevices.$inferSelect
