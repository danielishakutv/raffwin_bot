import { motion } from 'framer-motion'
import { cn } from './cn'

interface ProgressBarProps {
  /** 0 - 1 */
  value: number
  className?: string
  tone?: 'brand' | 'mint' | 'sun'
  height?: number
}

const toneClass = { brand: 'bg-brand', mint: 'bg-lagoon', sun: 'bg-sunny' }

/** Animated progress track with a soft shimmer across the fill. */
export function ProgressBar({ value, className, tone = 'brand', height = 10 }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn('relative w-full overflow-hidden rounded-pill bg-white/10', className)}
      style={{ height }}
    >
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ type: 'spring', stiffness: 120, damping: 20, mass: 0.8 }}
        className={cn('relative h-full rounded-pill', toneClass[tone])}
      >
        <span className="absolute inset-y-0 left-0 w-1/3 animate-shimmer bg-white/30 blur-[2px]" />
      </motion.div>
    </div>
  )
}
