import { AnimatePresence, motion } from 'framer-motion'
import { RefreshCw } from 'lucide-react'
import { cn } from './cn'
import { RaffsCoin } from './RaffsCoin'
import { useRate } from '@/hooks/useRate'
import { formatCountdown, formatRateValue } from '@/services/format'

/**
 * The current Naira-per-Raff rate with its one-hour expiry countdown.
 * While the quote is expired or loading it says "Refreshing rate" instead of
 * showing a stale number.
 */
export function RateChip({ className }: { className?: string }) {
  const { quote, valid, remainingMs } = useRate()
  const urgent = valid && remainingMs < 5 * 60 * 1000
  return (
    <div
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-pill border px-2.5 text-[12px] font-bold',
        valid ? 'border-sun/30 bg-sun/10 text-sun' : 'border-white/15 bg-white/8 text-mist',
        className,
      )}
      aria-live="polite"
    >
      <AnimatePresence mode="wait" initial={false}>
        {valid && quote ? (
          <motion.span
            key={quote.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="flex items-center gap-2"
          >
            <RaffsCoin size={14} />
            <span className="nums">1 Raff = {formatRateValue(quote.nairaPerRaff)}</span>
            <span className="h-3 w-px bg-sun/40" />
            <span className={cn('nums', urgent && 'text-magenta-2')} title="Rate expires in">
              {formatCountdown(remainingMs)}
            </span>
          </motion.span>
        ) : (
          <motion.span
            key="refreshing"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="flex items-center gap-1.5"
          >
            <RefreshCw size={13} className="animate-spin" />
            Refreshing rate
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  )
}
