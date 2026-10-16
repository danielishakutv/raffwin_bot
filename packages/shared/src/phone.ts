/* ----------------------------------------------------------------------------
 * Phone numbers (Nigeria)
 * -------------------------------------------------------------------------- */

/**
 * Normalise a Nigerian mobile number to E.164 (+234XXXXXXXXXX).
 * Accepts 0803..., 803..., +234803..., 234803... with spaces/dashes.
 * Returns null when the number is not a valid Nigerian mobile number.
 */
export function normalizeNigerianPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  let national: string | null = null
  if (digits.length === 13 && digits.startsWith('234')) national = digits.slice(3)
  else if (digits.length === 11 && digits.startsWith('0')) national = digits.slice(1)
  else if (digits.length === 10) national = digits
  if (!national || !/^[789][01]\d{8}$/.test(national)) return null
  return `+234${national}`
}

/** +2348031234567 -> +234 803 123 4567 */
export function formatPhoneDisplay(e164: string): string {
  const m = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `+234 ${m[1]} ${m[2]} ${m[3]}` : e164
}
