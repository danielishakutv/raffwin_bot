/**
 * Admin API request bodies, shared with the admin dashboard so its forms
 * validate exactly like the server. Import from '@raffwin/shared/admin-schemas'.
 */
import { z } from 'zod'

export const RAFFLE_KINDS = ['phone', 'laptop', 'tv', 'earbuds', 'powerbank', 'voucher', 'console'] as const

const prize = z.object({
  position: z.union([z.literal(1), z.literal(2), z.literal(3)]),
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
    marketPriceNaira: z.number().int().min(0).max(1_000_000_000),
    entryPriceRaffs: z.number().int().min(1).max(1_000_000),
    entriesTarget: z.number().int().min(3).max(1_000_000),
    deadline: z.string().datetime({ offset: true }),
    description: z.string().trim().max(2000).default(''),
    rules: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    prizes: z.array(prize).length(3, 'Every raffle has exactly three prizes'),
  })
  .superRefine((v, ctx) => {
    const positions = v.prizes.map((p) => p.position).sort()
    if (positions.join() !== '1,2,3') ctx.addIssue({ code: 'custom', path: ['prizes'], message: 'Prizes must be 1st, 2nd and 3rd' })
    v.prizes.forEach((p, i) => {
      if (p.prizeType === 'raffs_credit' && p.raffsValue <= 0) {
        ctx.addIssue({ code: 'custom', path: ['prizes', i, 'raffsValue'], message: 'A Raffs prize needs a Raffs value' })
      }
    })
  })

export const reasonBody = z.object({
  reason: z.string().trim().min(5, 'Say why, in a few words').max(500),
})

export const rateBaseBody = reasonBody.extend({
  /** Stars per Raff, e.g. 0.5 */
  starsPerRaff: z.number().min(0.001).max(1000),
})

export const limitsBody = z.object({
  maxEntriesPerUserPerRaffle: z.number().int().min(1).nullable(),
  dailySpendRaffs: z.number().int().min(1).nullable(),
  nairaPerStar: z.number().min(0).max(100_000),
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

export type RaffleBody = z.infer<typeof raffleBody>
export type ExpenseBody = z.infer<typeof expenseBody>
export type RateBaseBody = z.infer<typeof rateBaseBody>
export type LimitsBody = z.infer<typeof limitsBody>
export type AdjustmentBody = z.infer<typeof adjustmentBody>
