/**
 * The relay: the only channel between the sales site's backend and the main
 * API. Two operations, both POST with a JSON body, both signed:
 *
 *   account   is there a player for this Telegram id; their balance and the rate now
 *   credit    a confirmed payment: credit its Raffs once (idempotent on the reference)
 *
 * Signature (headers x-relay-timestamp, x-relay-signature):
 *
 *   message   = "<unix seconds>\n<operation>\n<raw body>"
 *   signature = "v1=" + hex(HMAC_SHA256(key = shared secret, message))
 *
 * The operation name is signed, not the URL path: the main API sits behind a
 * proxy that rewrites paths, and signing the name still stops a signed
 * "account" request from being replayed as a "credit". A timestamp older than
 * five minutes (or more than one ahead) is refused. The verifier accepts a
 * list of secrets so the secret can be rotated with no downtime: new and
 * previous both pass until the sender has switched (README, "Rotating the
 * relay secret").
 *
 * Nothing in here knows a host name. Where the main API lives is the sender's
 * server-side configuration and nobody else's.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const RELAY_OPERATIONS = ['account', 'credit'] as const
export type RelayOperation = (typeof RELAY_OPERATIONS)[number]

export const TIMESTAMP_HEADER = 'x-relay-timestamp'
export const SIGNATURE_HEADER = 'x-relay-signature'
/** How old a signed request may be */
export const MAX_AGE_SECONDS = 300
/** How far ahead a sender's clock may be */
export const MAX_AHEAD_SECONDS = 60
/** A shared secret shorter than this is refused at startup on both sides */
export const MIN_SECRET_LENGTH = 32

export function relaySignature(secret: string, timestamp: number, operation: RelayOperation, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}\n${operation}\n${rawBody}`).digest('hex')}`
}

/** Headers for one request. The body must be sent byte for byte as signed. */
export function signRelay(secret: string, operation: RelayOperation, rawBody: string, now = Date.now()): Record<string, string> {
  const timestamp = Math.floor(now / 1000)
  return {
    'content-type': 'application/json',
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: relaySignature(secret, timestamp, operation, rawBody),
  }
}

export type RelayFailure = 'missing' | 'malformed' | 'stale' | 'ahead' | 'bad_signature'

export type RelayCheck = { ok: true; secretIndex: number } | { ok: false; reason: RelayFailure }

/**
 * Checks one request against every accepted secret (current first). Every
 * secret is always compared, so the time taken does not say which one matched.
 */
export function verifyRelay(input: {
  secrets: readonly string[]
  operation: RelayOperation
  rawBody: string
  timestamp: string | undefined
  signature: string | undefined
  now?: number
}): RelayCheck {
  const { timestamp, signature } = input
  if (!timestamp || !signature) return { ok: false, reason: 'missing' }
  if (!/^\d{1,12}$/.test(timestamp) || !/^v1=[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'malformed' }
  const ts = Number(timestamp)
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000)
  if (nowSeconds - ts > MAX_AGE_SECONDS) return { ok: false, reason: 'stale' }
  if (ts - nowSeconds > MAX_AHEAD_SECONDS) return { ok: false, reason: 'ahead' }

  const given = Buffer.from(signature)
  let matched = -1
  input.secrets.forEach((secret, i) => {
    const expected = Buffer.from(relaySignature(secret, ts, input.operation, input.rawBody))
    if (expected.length === given.length && timingSafeEqual(expected, given) && matched < 0) matched = i
  })
  return matched >= 0 ? { ok: true, secretIndex: matched } : { ok: false, reason: 'bad_signature' }
}

// ---------------------------------------------------------------------------
// The contract. Amounts are integers: naira in kobo, Raffs whole.

const telegramId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export const accountRequest = z.object({ telegramId }).strict()
export type AccountRequest = z.infer<typeof accountRequest>

export const relayRate = z.object({
  /** The hourly quote this rate belongs to */
  id: z.string().uuid(),
  nairaPerRaffKobo: z.number().int().positive(),
  /** The admin's base price; quotes move within 85-115% of it */
  baseNairaPerRaffKobo: z.number().int().positive(),
  validUntil: z.string().datetime(),
})
export type RelayRate = z.infer<typeof relayRate>

/** What the admin set under Settings > Rate and sales */
export const relaySales = z.object({
  packages: z.array(z.object({ naira: z.number().int().positive(), bonusPercent: z.number().int().min(0).max(15), label: z.string().nullable() })),
  minNaira: z.number().int().positive(),
  maxNaira: z.number().int().positive(),
})
export type RelaySales = z.infer<typeof relaySales>

export const accountResponse = z.discriminatedUnion('exists', [
  z.object({ exists: z.literal(false), rate: relayRate, sales: relaySales }),
  z.object({
    exists: z.literal(true),
    /** suspended players cannot be credited */
    status: z.enum(['active', 'suspended']),
    balance: z.number().int(),
    rate: relayRate,
    sales: relaySales,
  }),
])
export type AccountResponse = z.infer<typeof accountResponse>

export const creditRequest = z
  .object({
    /** The payment provider's reference: unique, the idempotency key */
    reference: z.string().min(6).max(100).regex(/^[A-Za-z0-9_.=-]+$/),
    source: z.literal('paystack'),
    telegramId,
    quoteId: z.string().uuid(),
    nairaKobo: z.number().int().positive(),
    /** The rate stored with the quote when the buyer chose the amount */
    rateId: z.string().uuid(),
    nairaPerRaffKobo: z.number().int().positive(),
    /** Raffs the naira buys at that rate, rounded down */
    baseRaffs: z.number().int().positive(),
    /** A package bonus on top, never more than MAX_BONUS_PERCENT of baseRaffs */
    bonusRaffs: z.number().int().min(0),
    paidAt: z.string().datetime(),
  })
  .strict()
export type CreditRequest = z.infer<typeof creditRequest>

export const MAX_BONUS_PERCENT = 15

/** Raffs a naira amount buys at a rate: whole Raffs, rounded down (integers only, no float error) */
export function raffsForNaira(nairaKobo: number, nairaPerRaffKobo: number): number {
  if (!Number.isSafeInteger(nairaKobo) || !Number.isSafeInteger(nairaPerRaffKobo) || nairaKobo <= 0 || nairaPerRaffKobo <= 0) return 0
  return Math.floor(nairaKobo / nairaPerRaffKobo)
}

/** A package bonus: whole Raffs, rounded down */
export function bonusRaffs(baseRaffs: number, bonusPercent: number): number {
  const pct = Math.min(Math.max(Math.trunc(bonusPercent), 0), MAX_BONUS_PERCENT)
  return Math.floor((baseRaffs * pct) / 100)
}

export const creditResponse = z.object({
  status: z.enum(['credited', 'already_credited']),
  creditId: z.string().uuid(),
  raffs: z.number().int().positive(),
  balance: z.number().int(),
})
export type CreditResponse = z.infer<typeof creditResponse>

/**
 * Refusals. The sender must not retry these: the same request gets the same
 * answer. Anything else (5xx, timeout, no connection) is retried.
 */
export const RELAY_REFUSALS = {
  no_account: 404,
  account_suspended: 403,
  /** The same reference arrived before with different amounts */
  reference_conflict: 409,
  /** Raffs do not match the naira at a rate inside the allowed band, or above the per-credit cap */
  out_of_bounds: 422,
  invalid: 400,
} as const
export type RelayRefusal = keyof typeof RELAY_REFUSALS

export interface RelayErrorBody {
  error: { code: RelayRefusal | 'unauthorised' | 'rate_limited' | 'internal'; message: string }
}
