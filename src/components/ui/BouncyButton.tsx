import { motion, type HTMLMotionProps } from 'framer-motion'
import type { ReactNode } from 'react'
import { cn } from './cn'
import { sound, type SoundName } from '@/services/sound'
import { haptics } from '@/services/haptics'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'sun' | 'mint' | 'outline' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface BouncyButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Pulsing glow for the main call to action */
  pulse?: boolean
  /** Sound to play on press. null = silent */
  sfx?: SoundName | null
  loading?: boolean
  block?: boolean
  icon?: ReactNode
  children?: ReactNode
}

const variantClass: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white shadow-glow',
  secondary: 'surface-2 text-cloud',
  ghost: 'bg-transparent text-mist hover:text-cloud',
  sun: 'bg-sunny text-ink shadow-glow-sun',
  mint: 'bg-lagoon text-ink shadow-glow-mint',
  outline: 'bg-transparent text-cloud border border-white/20',
  danger: 'bg-coral/15 text-coral border border-coral/30',
}

const sizeClass: Record<ButtonSize, string> = {
  sm: 'h-10 px-4 text-sm gap-1.5',
  md: 'h-12 px-5 text-[15px] gap-2',
  lg: 'h-14 px-6 text-base gap-2',
}

/**
 * The app's button. Squashes on press and springs back with overshoot,
 * plays a pop and a light haptic. Use `pulse` on the single most important
 * action on a screen.
 */
export function BouncyButton({
  variant = 'primary',
  size = 'md',
  pulse = false,
  sfx = 'pop',
  loading = false,
  block = false,
  icon,
  className,
  children,
  disabled,
  onClick,
  ...rest
}: BouncyButtonProps) {
  const isDisabled = disabled || loading
  return (
    <motion.button
      type="button"
      whileTap={isDisabled ? undefined : { scale: 0.92 }}
      transition={{ type: 'spring', stiffness: 520, damping: 15, mass: 0.6 }}
      className={cn(
        'tap relative inline-flex items-center justify-center rounded-field font-display font-bold tracking-tight select-none',
        'transition-[filter,opacity] duration-150 will-change-transform',
        variantClass[variant],
        sizeClass[size],
        block && 'w-full',
        pulse && !isDisabled && 'animate-pulse-glow',
        isDisabled ? 'opacity-55 saturate-50 cursor-not-allowed' : 'active:brightness-110',
        className,
      )}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      onClick={(event) => {
        if (isDisabled) return
        if (sfx) sound.play(sfx)
        haptics.impact('light')
        onClick?.(event)
      }}
      {...rest}
    >
      {loading ? <Spinner className="h-5 w-5" /> : icon}
      {children && <span className={cn(loading && 'opacity-80')}>{children}</span>}
    </motion.button>
  )
}
