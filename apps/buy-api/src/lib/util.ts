import { createHash, randomBytes } from 'node:crypto'

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

/** Addresses are never stored raw */
export function hashIp(ip: string | undefined, salt: string): string | null {
  return ip ? sha256Hex(`${salt}:${ip}`).slice(0, 32) : null
}

export const randomToken = () => randomBytes(32).toString('base64url')

/** An error the browser may see: a code and a sentence, nothing from upstream */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** A Nigerian mobile number as +234XXXXXXXXXX, or null. Accepts 0803..., 234803..., +234 803 ... */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, '').replace(/^\+/, '')
  const local = digits.startsWith('234') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits
  return /^[789][01]\d{8}$/.test(local) ? `+234${local}` : null
}

const LAGOS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })

/** The Lagos date (YYYY-MM-DD) and hour of a moment */
export function lagos(ms: number): { day: string; hour: number } {
  const parts = Object.fromEntries(LAGOS.formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 }
}

/** Midnight at the start of a Lagos day, as epoch ms (Lagos is UTC+1 all year) */
export const lagosMidnight = (day: string) => Date.parse(`${day}T00:00:00+01:00`)
