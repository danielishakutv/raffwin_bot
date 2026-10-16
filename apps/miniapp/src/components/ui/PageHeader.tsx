import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from './cn'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  back?: boolean | string
  right?: ReactNode
  className?: string
}

export function PageHeader({ title, subtitle, back, right, className }: PageHeaderProps) {
  const navigate = useNavigate()
  return (
    <header className={cn('flex items-center gap-3 pb-4', className)}>
      {back && (
        <button
          type="button"
          aria-label="Back"
          onClick={() => {
            sound.play('click')
            haptics.impact('light')
            if (typeof back === 'string') navigate(back)
            else navigate(-1)
          }}
          className="tap -ml-2 flex items-center justify-center rounded-full text-mist hover:text-cloud"
        >
          <ArrowLeft size={22} />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[22px] font-bold">{title}</h1>
        {subtitle && <p className="text-[13px] text-mist">{subtitle}</p>}
      </div>
      {right}
    </header>
  )
}
