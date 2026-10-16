import type { ReactNode } from 'react'
import { cn } from './cn'

type Tone = 'neutral' | 'brand' | 'mint' | 'sun' | 'magenta' | 'electric' | 'coral'

const tones: Record<Tone, string> = {
  neutral: 'bg-white/10 text-mist',
  brand: 'bg-grape/30 text-cloud',
  mint: 'bg-mint/15 text-mint',
  sun: 'bg-sun/15 text-sun',
  magenta: 'bg-magenta/18 text-magenta-2',
  electric: 'bg-electric/20 text-electric-2',
  coral: 'bg-coral/15 text-coral',
}

export function Chip({ tone = 'neutral', className, children, icon }: { tone?: Tone; className?: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={cn('inline-flex h-7 items-center gap-1 rounded-pill px-2.5 text-[12px] font-bold', tones[tone], className)}>
      {icon}
      {children}
    </span>
  )
}
