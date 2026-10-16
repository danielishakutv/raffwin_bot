import { cn } from './cn'

/** The Raffs currency token: a sunny coin with an R. */
export function RaffsCoin({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-sunny font-display font-extrabold text-ink shadow-[inset_0_-2px_0_rgba(0,0,0,0.18),0_2px_6px_rgba(255,212,59,0.45)]', className)}
      style={{ width: size, height: size, fontSize: size * 0.58, lineHeight: 1 }}
    >
      R
    </span>
  )
}
