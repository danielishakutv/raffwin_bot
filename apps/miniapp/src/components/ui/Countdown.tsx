import { cn } from './cn'
import { useCountdown } from '@/hooks/useCountdown'

interface CountdownProps {
  target: string | number | Date
  /** 'segments' shows boxed d/h/m/s; 'inline' shows compact text */
  variant?: 'segments' | 'inline'
  className?: string
  doneLabel?: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Live countdown to the draw. Under one hour it turns magenta and pulses. */
export function Countdown({ target, variant = 'inline', className, doneLabel = 'Drawing now' }: CountdownProps) {
  const c = useCountdown(target)

  if (c.done) {
    return (
      <span className={cn('nums inline-flex items-center gap-1.5 font-bold text-mint', className)}>
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-mint" />
        </span>
        {doneLabel}
      </span>
    )
  }

  if (variant === 'inline') {
    const text =
      c.days > 0
        ? `${c.days}d ${pad(c.hours)}h ${pad(c.minutes)}m`
        : `${pad(c.hours)}:${pad(c.minutes)}:${pad(c.seconds)}`
    return (
      <span className={cn('nums inline-block font-bold', c.urgent ? 'animate-throb text-magenta-2' : 'text-cloud', className)} aria-live="off">
        {text}
      </span>
    )
  }

  const segments = c.days > 0
    ? [
        [c.days, 'days'],
        [c.hours, 'hrs'],
        [c.minutes, 'min'],
        [c.seconds, 'sec'],
      ]
    : [
        [c.hours, 'hrs'],
        [c.minutes, 'min'],
        [c.seconds, 'sec'],
      ]

  return (
    <div className={cn('flex items-stretch gap-2', className)}>
      {segments.map(([value, label]) => (
        <div
          key={label}
          className={cn(
            'flex min-w-[58px] flex-col items-center rounded-2xl px-2 py-2',
            c.urgent ? 'animate-pulse-glow bg-magenta/15 border border-magenta/40' : 'glass',
          )}
        >
          <span className={cn('nums text-2xl font-bold leading-none', c.urgent ? 'text-magenta-2' : 'text-cloud')}>
            {pad(value as number)}
          </span>
          <span className="mt-1 text-[11px] font-semibold text-mist">{label}</span>
        </div>
      ))}
    </div>
  )
}
