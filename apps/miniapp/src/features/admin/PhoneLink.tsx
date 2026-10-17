/**
 * A player's phone as admins need it: large enough to read, a verified tick
 * when it came from Telegram's signed contact share, tap to call, and copy.
 */
import { useState } from 'react'
import { BadgeCheck, Check as CheckIcon, Copy, Phone } from 'lucide-react'
import { cn } from '@/components/ui/cn'

export function PhoneLink({ phone, verified, size = 'md', className }: { phone: string | null; verified: boolean; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  if (!phone) {
    return <span className={cn('inline-flex items-center gap-1 text-neutral-500', size === 'sm' ? 'text-[12px]' : 'text-[13px]', className)}>No phone yet</span>
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(phone)
      setCopied('yes')
    } catch (error) {
      console.warn('[admin] could not copy the phone number', error)
      setCopied('failed')
    }
    window.setTimeout(() => setCopied(null), 1600)
  }
  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5', className)}>
      <a
        href={`tel:${phone}`}
        className={cn(
          'inline-flex items-center gap-1 font-bold tabular-nums underline decoration-black/30 underline-offset-4 hover:decoration-black',
          size === 'lg' ? 'text-[18px]' : size === 'md' ? 'text-[14px]' : 'text-[12.5px]',
        )}
        title={`Call ${phone}`}
        onClick={(e) => e.stopPropagation()}
      >
        <Phone size={size === 'lg' ? 15 : 12} />
        {phone}
      </a>
      {verified ? (
        <span className="inline-flex items-center text-black" title="Verified: shared through Telegram from the player's own account" aria-label="Verified">
          <BadgeCheck size={size === 'lg' ? 17 : 14} />
        </span>
      ) : (
        <span className="text-[10.5px] font-bold uppercase tracking-wide text-neutral-500" title="Typed in, not verified through Telegram">
          unverified
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          void copy()
        }}
        className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold text-neutral-600 hover:bg-neutral-100 hover:text-black"
        aria-label={`Copy ${phone}`}
      >
        {copied === 'yes' ? <CheckIcon size={12} /> : <Copy size={12} />}
        {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy blocked' : 'Copy'}
      </button>
    </span>
  )
}
