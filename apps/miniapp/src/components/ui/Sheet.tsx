import { AnimatePresence, motion, useDragControls } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { cn } from './cn'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'

interface SheetProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  /** Tailwind max-height class for the panel. Defaults to 92dvh */
  heightClass?: string
  className?: string
}

/**
 * Bottom sheet. Slides up with a springy bounce, drags down to dismiss from
 * the handle, scrolls inside, and respects the Telegram safe area.
 */
export function Sheet({ open, onClose, title, children, heightClass = 'max-h-[92dvh]', className }: SheetProps) {
  const controls = useDragControls()

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true">
          <motion.button
            type="button"
            aria-label="Close"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="absolute inset-0 bg-ink/70 backdrop-blur-sm"
          />
          <motion.div
            drag="y"
            dragControls={controls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.7 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 110 || info.velocity.y > 700) {
                sound.play('whoosh')
                onClose()
              }
            }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%', transition: { type: 'tween', duration: 0.22, ease: [0.4, 0, 1, 1] } }}
            transition={{ type: 'spring', stiffness: 380, damping: 30, mass: 0.9 }}
            className={cn(
              'relative flex w-full max-w-[520px] flex-col rounded-t-[28px] bg-ink-2 shadow-float',
              'border-t border-white/10',
              heightClass,
              className,
            )}
            style={{ paddingBottom: 'var(--safe-bottom)' }}
          >
            <div
              onPointerDown={(e) => {
                haptics.select()
                controls.start(e)
              }}
              className="flex cursor-grab touch-none flex-col items-center pt-3 pb-1 active:cursor-grabbing"
            >
              <span className="h-1.5 w-12 rounded-pill bg-white/25" />
            </div>
            <div className="flex items-center justify-between px-5 pb-2 pt-1">
                <div className="font-display text-lg font-bold">{title}</div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="tap -mr-2 flex items-center justify-center rounded-full text-mist hover:text-cloud"
                >
                  <X size={22} />
                </button>
              </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
