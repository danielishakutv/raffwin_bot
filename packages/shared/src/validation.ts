/**
 * Field rules shared by the sign-up form and the API. Each validator returns
 * the message to show, or null when the value is acceptable.
 */
import { normalizeNigerianPhone } from './phone'

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function validateFullName(value: string): string | null {
  const v = value.trim()
  if (v.length < 3) return 'Enter your full name'
  if (!/\s/.test(v)) return 'Add your surname too, e.g. Ada Obi'
  if (v.length > 60) return 'That name is a bit long (60 characters max)'
  return null
}

export function validateUsername(value: string): string | null {
  const v = value.trim().toLowerCase()
  if (v.length < 3) return 'At least 3 characters'
  if (v.length > 20) return '20 characters max'
  if (!USERNAME_RE.test(v)) return 'Only letters, numbers and underscores'
  return null
}

export function validatePhone(value: string): string | null {
  if (!value.trim()) return 'Enter your phone number'
  if (!normalizeNigerianPhone(value)) return 'Enter a valid Nigerian number, e.g. 0803 123 4567'
  return null
}

export function validateEmail(value: string): string | null {
  const v = value.trim()
  if (!v) return 'Enter your email address'
  if (!EMAIL_RE.test(v)) return 'That email does not look right'
  return null
}

export function validateRequired(value: string, label: string): string | null {
  return value.trim() ? null : `Enter ${label}`
}
