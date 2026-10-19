/**
 * Admin API request bodies, shared with the admin dashboard so its forms
 * validate exactly like the server. Import from '@raffwin/shared/admin-schemas'.
 */
import { z } from 'zod'
import { MAX_PRIZES, ordinal } from './prizes'

export const RAFFLE_KINDS = ['phone', 'laptop', 'tv', 'earbuds', 'powerbank', 'voucher', 'console'] as const

/**
 * Raffle photos are always uploads stored on the API, served at /v1/media/<uuid>
 * and never larger than MEDIA_MAX_BYTES. A photo from a link is fetched through
 * the API (POST /admin/v1/media/fetch), shrunk in the app and uploaded like any other.
 */
export const MEDIA_PATH = /^\/v1\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const imageUrl = z.string().trim().regex(MEDIA_PATH, 'Upload the photo (or import it from a link) so it is stored and kept small')

export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
/** Hard limit on a stored raffle photo; the app shrinks photos to fit */
export const MEDIA_MAX_BYTES = 500_000
/** Largest original the API will fetch from a link for the app to shrink */
export const MEDIA_FETCH_MAX_BYTES = 15_000_000

export const mediaFetchBody = z.object({
  url: z.string().trim().max(1000).regex(/^https:\/\/[^\s"'<>]+$/i, 'Use a full address that starts with https://'),
})

const prize = z.object({
  position: z.number().int().min(1).max(MAX_PRIZES),
  prizeItem: z.string().trim().min(2).max(120),
  prizeType: z.enum(['physical', 'raffs_credit']),
  raffsValue: z.number().int().min(0).max(10_000_000).default(0),
  /** What the prize costs to buy, in Naira (physical prizes), for the finance report */
  costNaira: z.number().int().min(0).max(1_000_000_000).default(0),
})

export const raffleBody = z
  .object({
    prizeName: z.string().trim().min(2).max(80),
    model: z.string().trim().max(80).default(''),
    category: z.string().trim().min(2).max(40),
    kind: z.enum(RAFFLE_KINDS),
    hue: z.number().int().min(0).max(360).default(260),
    /**
     * Prize photo: the path an upload returned (/v1/media/<id>).
     * Null shows the drawn illustration for the kind.
     */
    imageUrl: imageUrl.nullable().default(null),
    marketPriceNaira: z.number().int().min(0).max(1_000_000_000),
    entryPriceRaffs: z.number().int().min(1).max(1_000_000),
    entriesTarget: z.number().int().min(1).max(1_000_000),
    deadline: z.string().datetime({ offset: true }),
    description: z.string().trim().max(2000).default(''),
    rules: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    prizes: z.array(prize).min(1, 'A raffle needs at least one prize').max(MAX_PRIZES, `At most ${MAX_PRIZES} prizes`),
  })
  .superRefine((v, ctx) => {
    const positions = v.prizes.map((p) => p.position).sort((a, b) => a - b)
    if (positions.some((p, i) => p !== i + 1)) {
      ctx.addIssue({ code: 'custom', path: ['prizes'], message: `Prizes must be numbered 1 to ${v.prizes.length} with no gaps` })
    }
    if (v.entriesTarget < v.prizes.length) {
      ctx.addIssue({ code: 'custom', path: ['entriesTarget'], message: `Sell at least ${v.prizes.length} entries: one ticket wins one prize` })
    }
    v.prizes.forEach((p, i) => {
      if (p.prizeType === 'raffs_credit' && p.raffsValue <= 0) {
        ctx.addIssue({ code: 'custom', path: ['prizes', i, 'raffsValue'], message: `The ${ordinal(p.position)} prize is Raffs, so it needs a Raffs value` })
      }
    })
  })

export const reasonBody = z.object({
  reason: z.string().trim().min(5, 'Say why, in a few words').max(500),
})

export const rateBaseBody = reasonBody
  .extend({
    /** Naira per Raff, e.g. 10 or 12.50 */
    nairaPerRaff: z
      .number()
      .min(0.01)
      .max(100_000)
      .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'At most two decimal places (kobo)'),
    /** Each hour moves between these percents from the base; 0 and 0 = a fixed price */
    moveMinPct: z.number().int().min(0).max(30),
    moveMaxPct: z.number().int().min(0).max(30),
  })
  .refine((b) => b.moveMinPct <= b.moveMaxPct, { message: 'The smallest move cannot be above the largest', path: ['moveMinPct'] })

export const salesOptionsBody = reasonBody
  .extend({
    packages: z
      .array(
        z.object({
          naira: z.number().int().min(100).max(10_000_000),
          /** Extra Raffs on top, at most 15% */
          bonusPercent: z.number().int().min(0).max(15),
          label: z.string().trim().max(24).nullable(),
        }),
      )
      .max(8),
    minNaira: z.number().int().min(100).max(10_000_000),
    maxNaira: z.number().int().min(100).max(10_000_000),
  })
  .refine((b) => b.minNaira <= b.maxNaira, { message: 'The minimum cannot be above the maximum', path: ['minNaira'] })
  .refine((b) => b.packages.every((p) => p.naira >= b.minNaira && p.naira <= b.maxNaira), {
    message: 'Every package must be between the minimum and the maximum',
    path: ['packages'],
  })

export const voucherBatchBody = reasonBody.extend({
  vendor: z.string().trim().min(2, 'Who sells them?').max(80),
  note: z.string().trim().max(200).default(''),
  /** Raffs each code adds */
  valueRaffs: z.number().int().min(1).max(100_000),
  count: z.number().int().min(1).max(5000),
  /** Optional; codes stop working at this moment */
  expiresAt: z.string().datetime().nullable(),
})

export const voucherCodeBody = z.object({ code: z.string().trim().min(1).max(40) })

export const limitsBody = z.object({
  maxEntriesPerUserPerRaffle: z.number().int().min(1).nullable(),
  dailySpendRaffs: z.number().int().min(1).nullable(),
})

export const adjustmentBody = reasonBody.extend({
  /** Signed: positive credits, negative debits */
  raffs: z
    .number()
    .int()
    .refine((n) => n !== 0, 'Enter a non-zero amount')
    .refine((n) => Math.abs(n) <= 1_000_000, 'At most 1,000,000 Raffs in one adjustment'),
})

export const decisionBody = z.object({
  note: z.string().trim().max(500).default(''),
})

export const EXPENSE_CATEGORIES = ['prize_purchase', 'delivery', 'marketing', 'fees', 'operations', 'other'] as const

export const expenseBody = z.object({
  /** Link to a raffle (its prize delivery, its ads), or leave out for a general cost */
  raffleId: z.string().uuid().nullable().default(null),
  category: z.enum(EXPENSE_CATEGORIES),
  amountNaira: z.number().int().min(1, 'Enter an amount').max(1_000_000_000),
  spentOn: z.string().datetime({ offset: true }),
  note: z.string().trim().min(3, 'Say what it was for').max(300),
})

/* Browser (desktop) sign-in --------------------------------------------------- */

/** POST /admin/v1/auth/web/start: the same secrets as the bot sign-in */
// Secrets are trimmed, as the bot sign-in trims what it reads: a space picked up
// by copy and paste or a phone keyboard must not make a right password wrong
export const webLoginStartBody = z.object({
  master: z.string().trim().min(1).max(200),
  username: z.string().trim().min(1).max(64),
  password: z.string().trim().min(1).max(200),
})

/** POST /admin/v1/auth/web/verify: the code the bot sent to the admin's Telegram */
export const webLoginVerifyBody = z.object({
  challengeId: z.string().uuid(),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the bot'),
  /** Trust this browser from now on: next time only the admin password is asked (admin/devices.ts) */
  rememberDevice: z.boolean().optional().default(false),
})

/* Features -------------------------------------------------------------------- */

/** PUT /admin/v1/features/:key */
export const featureToggleBody = z.object({
  enabled: z.boolean(),
  /** Message every player through the bot (only when turning on) */
  announce: z.boolean().default(false),
  /** The announcement text; defaults to the feature's suggested text */
  message: z.string().trim().min(5).max(3000).optional(),
  reason: z.string().trim().max(500).default(''),
})

/** POST /admin/v1/features/:key/overrides */
export const featureOverrideBody = z.object({
  /** Username (with or without @) or Telegram id */
  user: z.string().trim().min(2).max(41),
  enabled: z.boolean(),
  note: z.string().trim().min(3, 'Say why, in a few words').max(300),
  /** Tell that player through the bot (only when enabling) */
  notify: z.boolean().default(false),
  message: z.string().trim().min(5).max(3000).optional(),
})

/* Messages -------------------------------------------------------------------- */

export const BROADCAST_AUDIENCES = ['all', 'no_phone', 'inactive', 'users'] as const

export const broadcastAudience = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  /** Players who have not shared a phone number yet */
  z.object({ type: z.literal('no_phone') }),
  /** Players who have not opened the app for at least this many days */
  z.object({ type: z.literal('inactive'), days: z.number().int().min(1).max(365) }),
  /** Named players: usernames (with or without @) or Telegram ids */
  z.object({ type: z.literal('users'), users: z.array(z.string().trim().min(2).max(41)).min(1).max(500) }),
])

/** POST /admin/v1/broadcasts: a notice or announcement sent by the bot to players' private chats */
export const broadcastBody = z.object({
  /** Bold first line; optional */
  title: z.string().trim().max(120).default(''),
  /** Plain text; line breaks kept. Sent escaped, so nothing in it is treated as markup. */
  text: z.string().trim().min(2, 'Write the message').max(3500),
  /** Adds an "Open Raffle Win" button under the message */
  openButton: z.boolean().default(true),
  audience: broadcastAudience,
  /** true: send only to the admin's own Telegram, to see how it looks */
  test: z.boolean().default(false),
})

/** PUT /admin/v1/engagement: reminders, come-back offer, streak rewards, transfer caps */
export const engagementBody = z
  .object({
    reminderMinHours: z.number().int().min(1).max(72),
    reminderMaxHours: z.number().int().min(1).max(72),
    maxRemindersPerSpell: z.number().int().min(0).max(50),
    quietStartHour: z.number().int().min(0).max(23),
    quietEndHour: z.number().int().min(0).max(23),
    comebackAfterHours: z.number().int().min(12).max(24 * 30),
    /** "max 1 Raff": the offer is 0 (off) or 1 */
    comebackRaffs: z.number().int().min(0).max(1),
    comebackCooldownDays: z.number().int().min(1).max(90),
    streakRewards: z.array(z.number().int().min(0).max(1000)).min(1).max(30),
    transferMinRaffs: z.number().int().min(1).max(1_000_000),
    transferDailyMaxRaffs: z.number().int().min(1).max(10_000_000),
  })
  .superRefine((v, ctx) => {
    if (v.reminderMaxHours < v.reminderMinHours) {
      ctx.addIssue({ code: 'custom', path: ['reminderMaxHours'], message: 'Must be at least the minimum' })
    }
    if (v.transferDailyMaxRaffs < v.transferMinRaffs) {
      ctx.addIssue({ code: 'custom', path: ['transferDailyMaxRaffs'], message: 'Must be at least the minimum transfer' })
    }
  })

export type RaffleBody = z.infer<typeof raffleBody>
export type FeatureToggleBody = z.infer<typeof featureToggleBody>
export type FeatureOverrideBody = z.infer<typeof featureOverrideBody>
export type BroadcastBody = z.infer<typeof broadcastBody>
export type BroadcastAudience = z.infer<typeof broadcastAudience>
export type EngagementBody = z.infer<typeof engagementBody>
export type ExpenseBody = z.infer<typeof expenseBody>
export type RateBaseBody = z.infer<typeof rateBaseBody>
export type LimitsBody = z.infer<typeof limitsBody>
export type AdjustmentBody = z.infer<typeof adjustmentBody>
