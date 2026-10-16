import { motion, useMotionValue, useReducedMotion, useSpring } from 'framer-motion'
import type { PointerEvent, ReactNode } from 'react'
import { cn } from './cn'

interface TiltCardProps {
  children: ReactNode
  className?: string
  /** Max tilt in degrees */
  max?: number
  disabled?: boolean
}

/**
 * Subtle 3D tilt that follows the pointer/finger. Transform-only, so it stays
 * cheap on mid-range phones. Disabled automatically for reduced motion.
 */
export function TiltCard({ children, className, max = 9, disabled = false }: TiltCardProps) {
  const reduce = useReducedMotion()
  const rx = useMotionValue(0)
  const ry = useMotionValue(0)
  const srx = useSpring(rx, { stiffness: 220, damping: 18, mass: 0.5 })
  const sry = useSpring(ry, { stiffness: 220, damping: 18, mass: 0.5 })
  const active = !disabled && !reduce

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!active) return
    const rect = event.currentTarget.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width
    const py = (event.clientY - rect.top) / rect.height
    ry.set((px - 0.5) * 2 * max)
    rx.set(-(py - 0.5) * 2 * max)
  }

  const reset = () => {
    rx.set(0)
    ry.set(0)
  }

  return (
    <div style={{ perspective: 1000 }} className={cn('[transform-style:preserve-3d]', className)}>
      <motion.div
        style={{ rotateX: active ? srx : 0, rotateY: active ? sry : 0, transformStyle: 'preserve-3d' }}
        onPointerMove={onMove}
        onPointerLeave={reset}
        onPointerUp={reset}
        onPointerCancel={reset}
        className="h-full w-full will-change-transform"
      >
        {children}
      </motion.div>
    </div>
  )
}
