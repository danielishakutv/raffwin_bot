import { cn } from './cn'

/** Ticket mark + wordmark. */
export function LogoMark({ size = 48, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="rw-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6b2cf5" />
          <stop offset="1" stopColor="#f2358d" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#rw-g)" />
      <path
        d="M18 24h28a3 3 0 0 1 3 3v4a4 4 0 0 0 0 8v4a3 3 0 0 1-3 3H18a3 3 0 0 1-3-3v-4a4 4 0 0 0 0-8v-4a3 3 0 0 1 3-3z"
        fill="#ffd43b"
      />
      <circle cx="32" cy="35" r="4" fill="#140c33" />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-display text-2xl font-extrabold tracking-tight', className)}>
      Raffle<span className="text-sun">Win</span>
    </span>
  )
}
