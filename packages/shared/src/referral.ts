/**
 * Referral programme rules (docs/ARCHITECTURE.md section 7).
 * Single level. The referrer earns 10% of the Raffs spent on every entry their
 * referred user makes, floored to a whole Raff, paid in Raffs only.
 */

export const REFERRAL_PERCENT = 10

/** Raffs the referrer earns for an entry that cost `raffsSpent`. */
export function referralEarning(raffsSpent: number): number {
  if (!Number.isFinite(raffsSpent) || raffsSpent <= 0) return 0
  return Math.floor((Math.floor(raffsSpent) * REFERRAL_PERCENT) / 100)
}

/** No 0/O, 1/I/L: codes get read aloud and typed from screenshots. */
export const REFERRAL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const REFERRAL_CODE_LENGTH = 8
export const REFERRAL_CODE_RE = new RegExp(`^[${REFERRAL_CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`)

export function isReferralCode(value: string): boolean {
  return REFERRAL_CODE_RE.test(value)
}

export type StartParam = { kind: 'referral'; code: string } | { kind: 'raffle'; raffleId: string }

/**
 * Parses Telegram's start_param (`startapp=` on the Mini App link, `start=`
 * on the bot link). Unknown or malformed values return null, never throw:
 * the link came from somebody else's message.
 */
export function parseStartParam(raw: string | null | undefined): StartParam | null {
  if (!raw || raw.length > 64 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
  if (raw.startsWith('ref_')) {
    const code = raw.slice(4).toUpperCase()
    return isReferralCode(code) ? { kind: 'referral', code } : null
  }
  if (raw.startsWith('raffle_')) {
    const raffleId = raw.slice(7)
    return raffleId ? { kind: 'raffle', raffleId } : null
  }
  return null
}

export function referralLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername.replace(/^@/, '')}?startapp=ref_${code}`
}
