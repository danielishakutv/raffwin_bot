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

export const telegramAuthBody = z.object({
  initData: z.string().min(1).max(8192),
})

export const refreshBody = z.object({
  refreshToken: z.string().min(32).max(256),
})

export const signUpBody = z.object({
  fullName,
  username,
  email,
  /** The signed string from WebApp.requestContact; see SignUpInput.contactProof */
  contactProof: z.string().min(1).max(4096),
})

export const usernameQuery = z.object({ username: z.string().max(40) })

/** Strict: the verified phone (or anything else) is refused, not silently dropped. */
export const profilePatchBody = z
  .object({ fullName, username, email })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })

export const addressBody = z.object({
  street: z.string().trim().min(3, 'Enter the street address').max(200),
  city: z.string().trim().min(2, 'Enter the city or town').max(80),
  state: z.string().trim().min(2, 'Choose a state').max(40),
  landmark: z.string().trim().max(120).default(''),
  phone: z.string().trim().max(20).default(''),
})

export const contactPrefsBody = z.object({
  whatsapp: z.boolean(),
  telegram: z.boolean(),
  email: z.boolean(),
})

export type SignUpBody = z.infer<typeof signUpBody>
export type ProfilePatchBody = z.infer<typeof profilePatchBody>
export type AddressBody = z.infer<typeof addressBody>
