import { animate, useReducedMotion } from 'framer-motion'
import { useEffect, useRef } from 'react'
import { cn } from './cn'
import { formatInt } from '@/services/format'

interface AnimatedNumberProps {
  value: number
  /** Formats the in-flight value. Defaults to a grouped integer. */
  format?: (value: number) => string
  /** Seconds for the count animation */
  duration?: number
  /** Start from 0 on mount (count-up) instead of snapping to the first value */
  countUpOnMount?: boolean
  className?: string
}

/**
 * Number that counts up on mount and ticks to every new value.
 * Writes straight to the DOM node, so each frame costs no React render.
 */
export function AnimatedNumber({
  value,
  format = formatInt,
  duration = 0.9,
  countUpOnMount = true,
  className,
}: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const current = useRef<number>(countUpOnMount ? 0 : value)
  const reduce = useReducedMotion()

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const from = current.current
    const to = value
    if (reduce || from === to) {
      node.textContent = format(to)
      current.current = to
      return
    }
    const controls = animate(from, to, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => {
        node.textContent = format(v)
        current.current = v
      },
      onComplete: () => {
        node.textContent = format(to)
        current.current = to
      },
    })
    return () => controls.stop()
  }, [value, format, duration, reduce])

  return (
    <span ref={ref} className={cn('nums', className)}>
      {format(reduce ? value : current.current)}
    </span>
  )
}
