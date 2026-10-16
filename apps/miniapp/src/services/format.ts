/** Formatting helpers. Naira and Raffs always go through these so the UI is consistent. */

const intFormatter = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 })

export function formatInt(value: number): string {
  return intFormatter.format(Math.round(value))
}

export function formatNaira(value: number): string {
  return `₦${intFormatter.format(Math.round(value))}`
}

export function formatRaffs(value: number): string {
  return `${intFormatter.format(Math.round(value))} Raffs`
}

export function formatRateValue(nairaPerRaff: number): string {
  return `₦${nairaPerRaff.toFixed(2)}`
}

export function formatDateTime(iso: string | number | Date): string {
  const d = new Date(iso)
  return d.toLocaleString('en-NG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

export function formatDate(iso: string | number | Date): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatRelative(iso: string | number | Date, now: number = Date.now()): string {
  const diff = now - new Date(iso).getTime()
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  return formatDate(iso)
}

export interface Duration {
  days: number
  hours: number
  minutes: number
  seconds: number
  totalMs: number
}

export function splitDuration(ms: number): Duration {
  const totalMs = Math.max(0, ms)
  const totalSeconds = Math.floor(totalMs / 1000)
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalMs,
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Compact countdown text, e.g. "2d 04h", "04:12:33", "12:05" */
export function formatCountdown(ms: number): string {
  const d = splitDuration(ms)
  if (d.days > 0) return `${d.days}d ${pad(d.hours)}h ${pad(d.minutes)}m`
  if (d.hours > 0) return `${pad(d.hours)}:${pad(d.minutes)}:${pad(d.seconds)}`
  return `${pad(d.minutes)}:${pad(d.seconds)}`
}

/* Phone numbers live in the shared package so the API normalises them the same way. */
export { formatPhoneDisplay, normalizeNigerianPhone } from '@raffwin/shared'

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

/** Simple string hash to a hue, for stable per-user avatar gradients. */
export function hueFromString(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) % 360
  return h
}
