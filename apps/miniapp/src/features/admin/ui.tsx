/**
 * Admin building blocks: black and white, soft CSS transitions, nothing
 * beyond React and Tailwind. Every control wraps on narrow phones.
 */
import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/components/ui/cn'
import { useAsk } from './ask'

/* Buttons --------------------------------------------------------------------- */

type ButtonVariant = 'solid' | 'outline' | 'ghost' | 'danger'

const VARIANT: Record<ButtonVariant, string> = {
  solid: 'bg-black text-white hover:bg-neutral-800 active:bg-neutral-700',
  outline: 'border border-black/80 bg-white text-black hover:bg-neutral-100 active:bg-neutral-200',
  ghost: 'text-black hover:bg-neutral-100 active:bg-neutral-200',
  danger: 'border border-black bg-white text-black underline decoration-dotted underline-offset-4 hover:bg-black hover:text-white hover:no-underline',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: ReactNode
  busy?: boolean
}

export function Button({ variant = 'outline', size = 'md', icon, busy, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-semibold transition-[background-color,color,transform,opacity] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-8 px-2.5 text-[12.5px]' : 'h-10 px-3.5 text-[13.5px]',
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Dots /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ label, className, ...rest }: ButtonProps & { label: string }) {
  return <Button aria-label={label} title={label} variant="ghost" size="sm" className={cn('w-8 px-0', className)} {...rest} />
}

function Dots() {
  return (
    <span className="inline-flex gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1 w-1 animate-pulse rounded-full bg-current" style={{ animationDelay: `${i * 150}ms` }} />
      ))}
    </span>
  )
}

/* Layout ---------------------------------------------------------------------- */
/** Page heading used by every tab. */
export function TabHeading({ title, sub, aside }: { title: string; sub?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-[20px] font-extrabold tracking-tight">{title}</h2>
        {sub && <p className="text-[12.5px] leading-snug text-neutral-600">{sub}</p>}
      </div>
      {aside}
    </div>
  )
}


export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('admin-in min-w-0 rounded-xl border border-black/15 bg-white', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-black/10 px-4 py-3">
          <div className="min-w-0">
            {title && <h3 className="text-[14.5px] font-bold leading-tight">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-[12px] leading-snug text-neutral-600">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  )
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 mt-6 flex flex-wrap items-end justify-between gap-2 first:mt-0">
      <h2 className="text-[12px] font-bold uppercase tracking-[0.08em] text-neutral-600">{children}</h2>
      {aside}
    </div>
  )
}

export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn('admin-in min-w-0 rounded-xl border border-black/15 bg-white p-3.5 sm:p-4', className)}>
      <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-neutral-600">{label}</p>
      <p className="mt-1.5 break-words text-[24px] font-extrabold leading-none tracking-tight sm:text-[28px]">{value}</p>
      {sub && <p className="mt-1.5 text-[12px] leading-snug text-neutral-600">{sub}</p>}
    </div>
  )
}

/** Label / value rows that stack on narrow screens instead of squeezing. */
export function KeyValues({ rows, className }: { rows: [ReactNode, ReactNode, ('strong' | 'total')?][]; className?: string }) {
  return (
    <dl className={cn('divide-y divide-black/10 text-[13.5px]', className)}>
      {rows.map(([k, v, tone], i) => (
        <div key={i} className={cn('flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2', tone === 'total' && 'border-y-2 border-black font-bold')}>
          <dt className="min-w-0 text-neutral-700">{k}</dt>
          <dd className={cn('min-w-0 text-right font-semibold [overflow-wrap:anywhere]', tone === 'strong' && 'font-extrabold')}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/* Inputs ---------------------------------------------------------------------- */

const control =
  'w-full min-w-0 rounded-lg border border-black/25 bg-white px-3 text-[14px] text-black transition-[border-color,box-shadow] duration-150 placeholder:text-neutral-400 hover:border-black/45 focus:border-black focus:outline-none focus:ring-2 focus:ring-black/10 disabled:bg-neutral-50 disabled:text-neutral-500'

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function TextInput(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'h-10', invalid && 'border-black ring-2 ring-black/20', className)} {...rest} />
})

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function TextArea(
  { className, invalid, ...rest },
  ref,
) {
  return <textarea ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'min-h-24 py-2 leading-relaxed', invalid && 'border-black ring-2 ring-black/20', className)} {...rest} />
})

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(control, 'h-10 appearance-none bg-[length:12px] bg-[right_12px_center] bg-no-repeat pr-8', className)} style={{ backgroundImage: CHEVRON }} {...rest}>
      {children}
    </select>
  )
}
const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='black' stroke-width='1.6'/%3E%3C/svg%3E")`

/** A labelled control with an optional hint and error under it. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  aside,
  group,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  className?: string
  aside?: ReactNode
  /** Wraps a group of buttons (Segmented): a <label> would press the first one when its text is clicked */
  group?: boolean
}) {
  const Tag = group ? 'div' : 'label'
  return (
    <Tag role={group ? 'group' : undefined} className={cn('grid min-w-0 content-start gap-1', className)}>
      <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-[12.5px] font-semibold text-neutral-800">
        {label}
        {aside && <span className="text-[11.5px] font-medium text-neutral-500">{aside}</span>}
      </span>
      {children}
      {error ? (
        <span className="admin-in text-[12px] font-semibold text-black">⚠ {error}</span>
      ) : hint ? (
        <span className="text-[11.5px] leading-snug text-neutral-500">{hint}</span>
      ) : null}
    </Tag>
  )
}

/** A row of choices; scrolls sideways on phones rather than wrapping into a mess. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  size = 'md',
}: {
  options: { value: T; label: ReactNode; count?: number }[]
  value: T
  onChange: (v: T) => void
  className?: string
  size?: 'sm' | 'md'
}) {
  return (
    <div className={cn('-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}>
      <div role="tablist" className="inline-flex gap-1 rounded-xl bg-neutral-100 p-1">
        {options.map((o) => {
          const on = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(o.value)}
              className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg font-semibold transition-[background-color,color,box-shadow] duration-200',
                size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
                on ? 'bg-white text-black shadow-[0_1px_2px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.08)]' : 'text-neutral-600 hover:text-black',
              )}
            >
              {o.label}
              {o.count !== undefined && <span className={cn('rounded-full px-1.5 text-[10.5px] leading-4', on ? 'bg-black text-white' : 'bg-black/10')}>{o.count}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** An on/off switch. `label` names it for screen readers when no visible text sits beside it. */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  busy,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
  busy?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-[background-color,border-color,opacity] duration-200 disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'border-black bg-black' : 'border-black/30 bg-neutral-100',
        busy && 'animate-pulse',
      )}
    >
      <span
        className={cn(
          'absolute top-[3px] h-5 w-5 rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-[left,background-color] duration-200',
          checked ? 'left-[24px] bg-white' : 'left-[3px] bg-white ring-1 ring-black/20',
        )}
      />
    </button>
  )
}

/** A checkbox with its label beside it. */
export function Check({ checked, onChange, children, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <label className={cn('inline-flex min-w-0 cursor-pointer select-none items-start gap-2 text-[13px] leading-snug', disabled && 'cursor-not-allowed opacity-50', className)}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-black" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">{children}</span>
    </label>
  )
}

/* Feedback -------------------------------------------------------------------- */

export function Notice({ tone = 'info', children, onClose, className }: { tone?: 'info' | 'error' | 'success'; children: ReactNode; onClose?: () => void; className?: string }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'admin-in flex items-start gap-2 rounded-lg px-3 py-2.5 text-[13px] leading-snug',
        tone === 'error' ? 'border-2 border-black bg-white font-semibold' : tone === 'success' ? 'bg-black text-white' : 'border border-black/15 bg-neutral-50',
        className,
      )}
    >
      <span className="mt-px shrink-0 font-bold">{tone === 'error' ? '!' : tone === 'success' ? '✓' : 'i'}</span>
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
      {onClose && (
        <button type="button" onClick={onClose} className="-my-1 -mr-1 shrink-0 rounded px-1.5 text-[16px] leading-none opacity-70 hover:opacity-100" aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  )
}

export function Err({ message, className }: { message: string | null | undefined; className?: string }) {
  return message ? (
    <Notice tone="error" className={cn('my-2', className)}>
      {message}
    </Notice>
  ) : null
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="admin-in rounded-xl border border-dashed border-black/25 px-4 py-10 text-center">
      <p className="text-[14px] font-bold">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-sm text-[13px] text-neutral-600">{children}</div>}
    </div>
  )
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid gap-2" aria-label="Loading" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-neutral-100" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  )
}

export function Badge({ children, tone = 'outline', className }: { children: ReactNode; tone?: 'solid' | 'outline' | 'muted' | 'dashed'; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[10.5px] font-bold uppercase tracking-[0.06em]',
        tone === 'solid' && 'bg-black text-white',
        tone === 'outline' && 'border border-black text-black',
        tone === 'muted' && 'bg-neutral-100 text-neutral-600',
        tone === 'dashed' && 'border border-dashed border-black/60 text-neutral-700',
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Bar({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-neutral-200', className)}>
      <div className="h-full rounded-full bg-black transition-[width] duration-700 ease-out" style={{ width: `${pct}%` }} />
    </div>
  )
}

/* Ask dialog (window.prompt is unreliable inside Telegram's webview) ----------- */

export function AskDialog() {
  const { label, options, resolve } = useAsk()
  const [value, setValue] = useState('')
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!label) return
    setValue(options.value ?? '')
    const t = window.setTimeout(() => (inputRef.current ?? areaRef.current)?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [label, options.value])
  if (!label || !resolve) return null
  const done = (v: string | null) => {
    useAsk.setState({ label: null, options: {}, resolve: null })
    resolve(v === null ? null : v.trim() ? v.trim() : options.optional ? '' : null)
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal aria-labelledby={id}>
      <button type="button" aria-label="Cancel" className="admin-fade absolute inset-0 bg-black/40" onClick={() => done(null)} />
      <form
        className="admin-sheet relative w-full max-w-md rounded-t-2xl bg-white p-4 pb-[max(16px,env(safe-area-inset-bottom))] shadow-[0_-10px_40px_rgba(0,0,0,0.25)] sm:rounded-2xl sm:pb-4"
        onSubmit={(e) => {
          e.preventDefault()
          done(value)
        }}
        onKeyDown={(e) => e.key === 'Escape' && done(null)}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-black/15 sm:hidden" />
        <p id={id} className="text-[14.5px] font-bold leading-snug">
          {label}
        </p>
        {options.confirmOnly ? null : options.multiline ? (
          <TextArea ref={areaRef} className="mt-3" placeholder={options.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
        ) : (
          <TextInput ref={inputRef} className="mt-3" placeholder={options.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => done(null)}>
            Cancel
          </Button>
          <Button type="submit" variant={options.danger ? 'danger' : 'solid'} disabled={!options.optional && !value.trim()}>
            {options.confirm ?? 'OK'}
          </Button>
        </div>
      </form>
    </div>
  )
}
