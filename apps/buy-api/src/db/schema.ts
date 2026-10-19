/**
 * The sales site's own database. It holds who bought what and whether the
 * Raffs arrived; balances live in the main API, never here.
 *
 *   buyers          one per Telegram account (the permanent key), with phone and email
 *   sessions        a random token per sign-in, stored as SHA-256
 *   quotes          what the buyer was shown: naira, rate, Raffs. Credits come from here.
 *   payments        what Paystack confirmed for a quote, after our own verify call
 *   credits         the outbox to the main API: pending until it confirms
 *   flags           payments a person must settle, reported to the main API's admins
 *   webhook_events  every webhook received, signed or not
 *   security_events failed signatures, mismatches, guessing
 *   reconcile_runs  the daily comparison with Paystack
 */
import { sql } from 'drizzle-orm'
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { CreditRequest } from '@raffwin/relay'

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const buyers = pgTable(
  'buyers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
    username: text('username'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    photoUrl: text('photo_url'),
    /** +234XXXXXXXXXX */
    phone: text('phone'),
    email: text('email'),
    createdAt: createdAt(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('buyers_telegram_id_key').on(t.telegramId)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id),
    tokenHash: text('token_hash').notNull(),
    ipHash: text('ip_hash'),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('sessions_token_hash_key').on(t.tokenHash), index('sessions_buyer_idx').on(t.buyerId)],
)

export const QUOTE_STATUSES = ['awaiting_payment', 'paid', 'late', 'mismatch', 'failed'] as const

export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id),
    telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
    nairaKobo: integer('naira_kobo').notNull(),
    /** The main API's hourly quote the price came from */
    rateId: uuid('rate_id').notNull(),
    nairaPerRaffKobo: integer('naira_per_raff_kobo').notNull(),
    baseRaffs: integer('base_raffs').notNull(),
    bonusRaffs: integer('bonus_raffs').notNull(),
    bonusPercent: integer('bonus_percent').notNull(),
    packageLabel: text('package_label'),
    /** Our Paystack reference, unique */
    reference: text('reference').notNull(),
    status: text('status', { enum: QUOTE_STATUSES }).notNull().default('awaiting_payment'),
    authorizationUrl: text('authorization_url'),
    /** Payment may start until then */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Confirmed by then: credited at this quote; later: flagged for an admin */
    creditUntil: timestamp('credit_until', { withTimezone: true }).notNull(),
    /** The last time the buyer's return page asked Paystack about it */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('quotes_reference_key').on(t.reference), index('quotes_buyer_idx').on(t.buyerId, t.createdAt)],
)

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: text('reference').notNull(),
    quoteId: uuid('quote_id').references(() => quotes.id),
    paystackId: bigint('paystack_id', { mode: 'number' }),
    amountKobo: integer('amount_kobo').notNull(),
    currency: text('currency').notNull(),
    paystackStatus: text('paystack_status').notNull(),
    channel: text('channel'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** What we decided: credit it, or leave it to an admin */
    outcome: text('outcome', { enum: ['credit', 'late', 'mismatch', 'unmatched'] }).notNull(),
    /** Who noticed first: the webhook, the buyer coming back, or reconciliation */
    source: text('source', { enum: ['webhook', 'return', 'reconcile'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payments_reference_key').on(t.reference)],
)

export const credits = pgTable(
  'credits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: text('reference').notNull(),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => quotes.id),
    /** Exactly what is signed and sent, every attempt */
    payload: jsonb('payload').$type<CreditRequest>().notNull(),
    status: text('status', { enum: ['pending', 'delivered', 'refused'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    /** The main API's answer once delivered: credit id, Raffs, balance */
    response: jsonb('response'),
    refusedCode: text('refused_code'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    stuckFlagged: boolean('stuck_flagged').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('credits_reference_key').on(t.reference), index('credits_due_idx').on(t.status, t.nextAttemptAt)],
)

export const flags = pgTable(
  'flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: text('reference').notNull(),
    kind: text('kind').notNull(),
    telegramId: bigint('telegram_id', { mode: 'number' }),
    nairaKobo: integer('naira_kobo'),
    detail: text('detail').notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('flags_reference_kind_key').on(t.reference, t.kind), index('flags_due_idx').on(t.reportedAt, t.nextAttemptAt)],
)

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    event: text('event'),
    reference: text('reference'),
    signatureOk: boolean('signature_ok').notNull(),
    ipHash: text('ip_hash'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhook_events_reference_idx').on(t.reference)],
)

export const securityEvents = pgTable(
  'security_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    severity: text('severity', { enum: ['low', 'medium', 'high'] }).notNull(),
    ipHash: text('ip_hash'),
    buyerId: uuid('buyer_id'),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('security_events_kind_idx').on(t.kind, t.occurredAt)],
)

export const reconcileRuns = pgTable('reconcile_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The Lagos day it covered, YYYY-MM-DD; null for a run by hand */
  day: text('day'),
  fromAt: timestamp('from_at', { withTimezone: true }).notNull(),
  toAt: timestamp('to_at', { withTimezone: true }).notNull(),
  seen: integer('seen').notNull().default(0),
  recovered: integer('recovered').notNull().default(0),
  flagged: integer('flagged').notNull().default(0),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})

export type BuyerRow = typeof buyers.$inferSelect
export type QuoteRow = typeof quotes.$inferSelect
export type CreditRow = typeof credits.$inferSelect
export type FlagRow = typeof flags.$inferSelect
