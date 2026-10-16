import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, CheckCircle2, Info } from 'lucide-react'
import { cn } from './cn'
import { useToast } from './toastStore'

const icons = { info: Info, success: CheckCircle2, error: AlertCircle }
const tones = { info: 'border-electric/40', success: 'border-mint/40', error: 'border-coral/50' }
const iconTone = { info: 'text-electric-2', success: 'text-mint', error: 'text-coral' }

export function Toaster() {
  const items = useToast((s) => s.items)
  const dismiss = useToast((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4" style={{ paddingTop: 'calc(var(--safe-top) + 12px)' }}>
      <AnimatePresence>
        {items.map((t) => {
          const Icon = icons[t.kind]
          return (
            <motion.button
              key={t.id}
              type="button"
              onClick={() => dismiss(t.id)}
              initial={{ opacity: 0, y: -16, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              className={cn('pointer-events-auto flex max-w-[420px] items-start gap-2.5 rounded-2xl border bg-ink-3/95 px-4 py-3 text-left text-[14px] font-medium text-cloud shadow-float backdrop-blur', tones[t.kind])}
            >
              <Icon size={18} className={cn('mt-0.5 shrink-0', iconTone[t.kind])} />
              <span>{t.message}</span>
            </motion.button>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
