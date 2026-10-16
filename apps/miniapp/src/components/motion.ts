import type { Transition, Variants } from 'framer-motion'

/** Shared springs so the whole app bounces the same way. */
export const springBouncy: Transition = { type: 'spring', stiffness: 520, damping: 18, mass: 0.7 }
export const springSoft: Transition = { type: 'spring', stiffness: 260, damping: 26 }
export const springSnappy: Transition = { type: 'spring', stiffness: 700, damping: 30 }

/** Staggered entrance for lists and card grids. */
export const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
}

export const popIn: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.96 },
  show: { opacity: 1, y: 0, scale: 1, transition: springSoft },
  exit: { opacity: 0, scale: 0.9, transition: { duration: 0.18 } },
}

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.18 } },
}

export const pageVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.16 } },
}
