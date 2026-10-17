import type { AdminRaffle } from '@raffwin/shared/admin-types'
import { Badge } from '../ui'

const LOOK: Record<AdminRaffle['status'], { label: string; tone: 'solid' | 'outline' | 'muted' | 'dashed' }> = {
  draft: { label: 'draft', tone: 'dashed' },
  open: { label: 'live', tone: 'solid' },
  drawing: { label: 'drawing', tone: 'outline' },
  drawn: { label: 'drawn', tone: 'muted' },
  cancelled: { label: 'cancelled', tone: 'muted' },
}

export function StatusBadge({ status }: { status: AdminRaffle['status'] }) {
  const look = LOOK[status]
  return (
    <Badge tone={look.tone} className={status === 'cancelled' ? 'line-through' : undefined}>
      {status === 'open' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />}
      {look.label}
    </Badge>
  )
}
