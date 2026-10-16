import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { cn } from '@/components/ui/cn'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'

interface SectionCardProps {
  id: string
  icon: ReactNode
  title: string
  summary?: ReactNode
  badge?: ReactNode
  open: boolean
  onToggle: (id: string) => void
  children: ReactNode
}

/** Expandable profile section. Height animates; only one is open at a time. */
export function SectionCard({ id, icon, title, summary, badge, open, onToggle, children }: SectionCardProps) {
  return (
    <section className={cn('surface overflow-hidden rounded-card transition-colors', open && 'border-grape-2/40')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          sound.play('click')
          haptics.select()
          onToggle(id)
        }}
        className="tap flex w-full items-center gap-3 p-4 text-left"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/8 text-mist">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[15px] font-bold">{title}</span>
            {badge}
          </span>
          {summary && <span className="block truncate text-[12px] text-haze">{summary}</span>}
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ type: 'spring', stiffness: 400, damping: 26 }} className="text-mist">
          <ChevronDown size={20} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

/** Save button that turns into a check mark for a moment after a successful save. */
export function SaveButton({ saving, saved, disabled, onClick, label = 'Save changes' }: { saving: boolean; saved: boolean; disabled?: boolean; onClick: () => void; label?: string }) {
  return (
    <BouncyButton
      block
      variant={saved ? 'mint' : 'primary'}
      loading={saving}
      disabled={disabled}
      onClick={onClick}
      sfx={saved ? null : 'pop'}
      icon={
        saved ? (
          <motion.span initial={{ scale: 0, rotate: -40 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 14 }}>
            <Check size={18} strokeWidth={3} />
          </motion.span>
        ) : undefined
      }
    >
      {saved ? 'Saved' : label}
    </BouncyButton>
  )
}
