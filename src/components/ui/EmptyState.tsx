import type { ReactNode } from 'react'

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="surface flex flex-col items-center gap-3 rounded-card px-6 py-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/8 text-mist">{icon}</div>
      <h3 className="text-lg font-bold">{title}</h3>
      {body && <p className="max-w-[28ch] text-[14px] text-mist">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
