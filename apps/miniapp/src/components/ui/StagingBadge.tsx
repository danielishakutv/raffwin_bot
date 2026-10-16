import { env } from '@/services/env'

/** Small fixed badge so testers never confuse staging with production. */
export function StagingBadge() {
  if (!env.isStaging) return null
  return (
    <div
      className="pointer-events-none fixed right-3 z-[70] rounded-pill border border-sun/60 bg-sun/20 px-2.5 py-1 font-display text-[11px] font-extrabold tracking-wide text-sun backdrop-blur"
      style={{ top: 'calc(var(--safe-top) + 10px)' }}
    >
      STAGING
    </div>
  )
}
