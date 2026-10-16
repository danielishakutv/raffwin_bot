/**
 * Request bodies the API accepts. Imported from '@raffwin/shared/schemas' so
 * the Mini App bundle does not pull in zod through the main entry.
 *
 * The rules come from validation.ts, so the form and the API cannot disagree
 * about what a valid username or name is.
 */
import { z } from 'zod'
import { USERNAME_RE, validateEmail, validateFullName, validateUsername } from './validation'

/** Wraps a form validator (message or null) as a zod refinement. */
function rule(validate: (value: string) => string | null) {
  return (value: string, ctx: z.RefinementCtx) => {
    const message = validate(value)
    if (message) ctx.addIssue({ code: 'custom', message })
  }
}

const fullName = z.string().max(120).superRefine(rule(validateFullName)).transform((v) => v.trim())
const username = z
  .string()
  .max(40)
  .transform((v) => v.trim().toLowerCase())
  .superRefine(rule(validateUsername))
  .pipe(z.string().regex(USERNAME_RE))
const email = z
  .string()
  .max(254)
  .superRefine(rule(validateEmail))
  .transform((v) => v.trim().toLowerCase())
  .nullable()

export const telegramAuthBody = z.object({
  initData: z.string().min(1).max(8192),
})

export const refreshBody = z.object({
  refreshToken: z.string().min(32).max(256),
})

/** KYC: who collects a prize and at which motor park. No house address, ever. */
export const kycBody = z.object({
  fullName,
  state: z.string().trim().min(2, 'Choose your state').max(40),
  city: z.string().trim().min(2, 'Enter your city or town').max(80),
  motorPark: z.string().trim().min(3, 'Enter the motor park nearest to you').max(120),
  /** The signed string from WebApp.requestContact; required until the phone is verified */
  contactProof: z.string().min(1).max(4096).optional(),
})

export const usernameQuery = z.object({ username: z.string().max(40) })

/** Strict: the verified phone (or anything else) is refused, not silently dropped. */
export const profilePatchBody = z
  .object({ fullName, username, email })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })

export const contactPrefsBody = z.object({
  whatsapp: z.boolean(),
  telegram: z.boolean(),
  email: z.boolean(),
})

/** Entry cap per confirmation (section 8); per-raffle and daily caps are admin settings. */
export const MAX_QTY_PER_ENTRY = 50

export const enterRaffleBody = z.object({
  raffleId: z.string().uuid(),
  qty: z.number().int().min(1).max(MAX_QTY_PER_ENTRY, `At most ${MAX_QTY_PER_ENTRY} entries at a time`),
  /** One per confirmation tap: a retry with the same key returns the same entry, never a second one */
  idempotencyKey: z.string().uuid(),
})

export const cursorQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})

export type KycBody = z.infer<typeof kycBody>
export type EnterRaffleBody = z.infer<typeof enterRaffleBody>
export type ProfilePatchBody = z.infer<typeof profilePatchBody>
