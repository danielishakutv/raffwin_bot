import { animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { TiltCard } from '@/components/ui/TiltCard'
import { cn } from '@/components/ui/cn'
import type { Raffle } from '@/data/types'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { RaffleCard } from './RaffleCard'

interface RaffleDeckProps {
  raffles: Raffle[]
  index: number
  onIndexChange: (next: number) => void
  onOpen: (raffle: Raffle) => void
  onEnter: (raffle: Raffle) => void
}

const PEEK = 26
const GAP = 14
/**
 * How far a finger may slide and still count as a tap. The drag itself starts
 * at 3px, and a fingertip on a phone wanders that far on an ordinary tap: when
 * any drag cancelled the tap, "Enter raffle" needed two or three tries.
 */
const TAP_SLOP = 10

/**
 * Horizontal swipe deck. One draggable track; each card scales and turns
 * slightly as it leaves the centre. All transform-based.
 */
export function RaffleDeck({ raffles, index, onIndexChange, onOpen, onEnter }: RaffleDeckProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const x = useMotionValue(0)
  const dragging = useRef(false)
  const reduce = useReducedMotion()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cardW = Math.max(0, width - PEEK * 2)
  const step = cardW + GAP
  const count = raffles.length

  useEffect(() => {
    if (!step) return
    const target = -index * step
    if (reduce) {
      x.set(target)
      return
    }
    const controls = animate(x, target, { type: 'spring', stiffness: 300, damping: 30, mass: 0.9 })
    return () => controls.stop()
  }, [index, step, reduce, x])

  const settle = (offset: number, velocity: number) => {
    let next = index
    if (offset < -step * 0.18 || velocity < -450) next = Math.min(index + 1, count - 1)
    else if (offset > step * 0.18 || velocity > 450) next = Math.max(index - 1, 0)
    if (next !== index) {
      sound.play('whoosh')
      haptics.select()
      onIndexChange(next)
    } else {
      animate(x, -index * step, { type: 'spring', stiffness: 300, damping: 30 })
    }
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <motion.div
        className="flex items-stretch"
        style={{ x, paddingLeft: PEEK, gap: GAP, perspective: 1200 }}
        drag="x"
        dragConstraints={{ left: -(count - 1) * step, right: 0 }}
        dragElastic={0.14}
        dragMomentum={false}
        onDragStart={() => {
          dragging.current = false
        }}
        onDrag={(_, info) => {
          if (Math.abs(info.offset.x) > TAP_SLOP) dragging.current = true
        }}
        onDragEnd={(_, info) => {
          window.setTimeout(() => {
            dragging.current = false
          }, 50)
          settle(info.offset.x, info.velocity.x)
        }}
      >
        {raffles.map((raffle, i) => (
          <DeckSlot key={raffle.id} i={i} x={x} step={step || 1} width={cardW}>
            <TiltCard className="h-full" max={7}>
              <RaffleCard
                raffle={raffle}
                onOpen={() => {
                  if (dragging.current) return
                  sound.play('click')
                  haptics.impact('light')
                  onOpen(raffle)
                }}
                onEnter={() => {
                  if (dragging.current) return
                  onEnter(raffle)
                }}
              />
            </TiltCard>
          </DeckSlot>
        ))}
      </motion.div>

      {/* Progress dots */}
      <div className="mt-4 flex items-center justify-center gap-1.5" aria-hidden>
        {raffles.map((r, i) => (
          <span
            key={r.id}
            className={cn('h-1.5 rounded-pill transition-[width,opacity] duration-300', i === index ? 'w-[22px] bg-brand opacity-100' : 'w-1.5 bg-white opacity-35')}
          />
        ))}
      </div>
    </div>
  )
}

function DeckSlot({
  i,
  x,
  step,
  width,
  children,
}: {
  i: number
  x: MotionValue<number>
  step: number
  width: number
  children: React.ReactNode
}) {
  const rel = useTransform(x, (v) => (v + i * step) / step)
  const scale = useTransform(rel, [-1, 0, 1], [0.9, 1, 0.9])
  const rotateY = useTransform(rel, [-1, 0, 1], [14, 0, -14])
  const opacity = useTransform(rel, [-1.2, 0, 1.2], [0.55, 1, 0.55])
  return (
    <motion.div style={{ width, flex: '0 0 auto', scale, rotateY, opacity, transformStyle: 'preserve-3d' }} className="will-change-transform">
      {children}
    </motion.div>
  )
}
