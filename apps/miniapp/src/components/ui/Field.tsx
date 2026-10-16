import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, Minus, Plus } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'

/* ----------------------------------------------------------------------------
 * Field wrapper: label + control + inline message
 * -------------------------------------------------------------------------- */
interface FieldProps {
  label: string
  htmlFor?: string
  hint?: ReactNode
  error?: string | null
  /** Positive inline status (e.g. "Available") */
  success?: ReactNode
  children: ReactNode
  className?: string
}

export function Field({ label, htmlFor, hint, error, success, children, className }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-semibold text-mist">
        {label}
      </label>
      {children}
      <AnimatePresence initial={false} mode="wait">
        {error ? (
          <motion.p
            key="error"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="text-[13px] font-medium text-coral"
          >
            {error}
          </motion.p>
        ) : success ? (
          <motion.p
            key="success"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="flex items-center gap-1 text-[13px] font-medium text-mint"
          >
            {success}
          </motion.p>
        ) : hint ? (
          <p key="hint" className="text-[13px] text-haze">
            {hint}
          </p>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Inputs
 * -------------------------------------------------------------------------- */
const controlBase =
  'w-full rounded-field surface-2 px-4 text-[15px] text-cloud outline-none transition-[box-shadow,border-color] duration-150 placeholder:text-haze focus:border-grape-2 focus:shadow-[0_0_0_4px_rgba(138,92,255,0.25)] disabled:opacity-60'

interface InputProps extends ComponentProps<'input'> {
  invalid?: boolean
  leading?: ReactNode
  suffix?: ReactNode
}

export function Input({ invalid, leading, suffix, className, ...rest }: InputProps) {
  return (
    <div className="relative flex items-center">
      {leading && <span className="pointer-events-none absolute left-4 text-[15px] font-semibold text-mist">{leading}</span>}
      <input
        className={cn(controlBase, 'h-12', leading ? 'pl-16' : null, suffix ? 'pr-12' : null, invalid && 'border-coral/70', className)}
        {...rest}
      />
      {suffix && <span className="absolute right-3 flex items-center">{suffix}</span>}
    </div>
  )
}

export function Textarea({ invalid, className, ...rest }: ComponentProps<'textarea'> & { invalid?: boolean }) {
  return <textarea className={cn(controlBase, 'min-h-[88px] py-3', invalid && 'border-coral/70', className)} {...rest} />
}

interface SelectProps extends ComponentProps<'select'> {
  invalid?: boolean
  options: readonly string[] | readonly { value: string; label: string }[]
  placeholder?: string
}

export function Select({ invalid, options, placeholder, className, ...rest }: SelectProps) {
  return (
    <div className="relative">
      <select className={cn(controlBase, 'h-12 appearance-none pr-10', invalid && 'border-coral/70', className)} {...rest}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) =>
          typeof opt === 'string' ? (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ) : (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ),
        )}
      </select>
      <ChevronDown size={18} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-mist" />
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Toggle
 * -------------------------------------------------------------------------- */
interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}

export function Toggle({ checked, onChange, label, description, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        sound.play('click')
        haptics.select()
        onChange(!checked)
      }}
      className="tap flex w-full items-center justify-between gap-4 py-2 text-left disabled:opacity-60"
    >
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold text-cloud">{label}</span>
        {description && <span className="block text-[13px] text-haze">{description}</span>}
      </span>
      <span
        className={cn(
          'relative inline-flex h-7 w-12 shrink-0 items-center rounded-pill transition-colors duration-200',
          checked ? 'bg-mint' : 'bg-white/15',
        )}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 600, damping: 30 }}
          className={cn(
            'absolute flex h-5 w-5 items-center justify-center rounded-full bg-white shadow',
            checked ? 'left-[26px]' : 'left-1',
          )}
        >
          {checked && <Check size={12} className="text-ink" strokeWidth={3} />}
        </motion.span>
      </span>
    </button>
  )
}

/* ----------------------------------------------------------------------------
 * Stepper (quantity)
 * -------------------------------------------------------------------------- */
interface StepperProps {
  value: number
  min?: number
  max?: number
  onChange: (next: number) => void
  className?: string
}

export function Stepper({ value, min = 1, max = 99, onChange, className }: StepperProps) {
  const set = (next: number) => {
    const clamped = Math.max(min, Math.min(max, next))
    if (clamped !== value) {
      sound.play('click')
      haptics.select()
      onChange(clamped)
    }
  }
  const btn =
    'tap flex h-12 w-12 items-center justify-center rounded-full glass text-cloud disabled:opacity-35 active:scale-90 transition-transform'
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <button type="button" aria-label="Fewer" className={btn} onClick={() => set(value - 1)} disabled={value <= min}>
        <Minus size={20} />
      </button>
      <div className="relative flex h-12 min-w-[72px] items-center justify-center overflow-hidden rounded-field surface-2">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={value}
            initial={{ y: 14, opacity: 0, scale: 0.8 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -14, opacity: 0, scale: 0.8 }}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
            className="nums text-2xl font-bold"
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </div>
      <button type="button" aria-label="More" className={btn} onClick={() => set(value + 1)} disabled={value >= max}>
        <Plus size={20} />
      </button>
    </div>
  )
}
