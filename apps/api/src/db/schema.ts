/**
 * Database schema, milestone 1: accounts, sessions, addresses, security events.
 * docs/ARCHITECTURE.md section 4 is the full model; tables arrive with the
 * milestone that uses them.
 *
 * Production runs PostgreSQL 14 (jmnews server), development 17: nothing here
 * may need a feature newer than 14.
 */
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
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

    signedUpAt: timestamp('signed_up_at', { withTimezone: true }),
    onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_telegram_id_key').on(t.telegramId),
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
      enum: ['auth', 'initdata', 'webhook', 'ratelimit', 'waf', 'fraud', 'admin', 'integrity'],
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

export type UserRow = typeof users.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type AddressRow = typeof addresses.$inferSelect
