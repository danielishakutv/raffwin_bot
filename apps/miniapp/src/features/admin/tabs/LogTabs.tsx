import { useState } from 'react'
import type { AdminAuditRow, AdminSecurityEvent } from '@raffwin/shared/admin-types'
import { ShieldCheck } from 'lucide-react'
import { adminCall } from '../adminSession'
import { fmt, usePaged, useAction, when } from '../hooks'
import { Badge, Button, Empty, Err, Loading, Notice, Segmented, TabHeading } from '../ui'

type Severity = '' | 'critical' | 'high' | 'medium' | 'low'

export function SecurityTab() {
  const [severity, setSeverity] = useState<Severity>('')
  const page = usePaged<AdminSecurityEvent>(`/security-events${severity ? `?severity=${severity}` : ''}`)
  return (
    <>
      <TabHeading
        title="Security"
        sub="Attempts and anomalies, newest first."
        aside={
          <Segmented<Severity>
            value={severity}
            onChange={setSeverity}
            options={(['', 'critical', 'high', 'medium', 'low'] as Severity[]).map((s) => ({ value: s, label: s ? s[0]?.toUpperCase() + s.slice(1) : 'All' }))}
          />
        }
      />
      <Err message={page.error} />
      {!page.loaded ? (
        <Loading />
      ) : page.items.length === 0 ? (
        <Empty title="Nothing recorded" />
      ) : (
        <ul className="divide-y divide-black/10 overflow-hidden rounded-xl border border-black/15 bg-white">
          {page.items.map((e) => {
            const details = e.details && Object.keys(e.details as object).length ? JSON.stringify(e.details, null, 2) : null
            return (
              <li key={e.id} className="admin-in px-4 py-3 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge tone={e.severity === 'critical' || e.severity === 'high' ? 'solid' : e.severity === 'medium' ? 'outline' : 'muted'}>{e.severity}</Badge>
                  <span className="font-bold [overflow-wrap:anywhere]">{e.kind}</span>
                  <span className="ml-auto text-neutral-500">{when(e.occurredAt)}</span>
                </div>
                <p className="mt-1 text-neutral-600 [overflow-wrap:anywhere]">
                  {e.route ?? 'no route'} · {e.actionTaken}
                </p>
                {details && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer select-none text-[12px] font-semibold text-neutral-700">Details</summary>
                    <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-2 font-mono text-[11.5px] [overflow-wrap:anywhere]">{details}</pre>
                  </details>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {page.cursor && (
        <Button className="mt-3" busy={page.busy} onClick={page.more}>
          Load older
        </Button>
      )}
    </>
  )
}

export function AuditTab() {
  const page = usePaged<AdminAuditRow>('/audit-log')
  const action = useAction()
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null)
  return (
    <>
      <TabHeading
        title="Audit log"
        sub="Every admin request, chained by hash so no row can be changed unnoticed."
        aside={
          <Button
            icon={<ShieldCheck size={15} />}
            busy={action.busy}
            onClick={() =>
              void action
                .run(() => adminCall<{ ok: boolean; rows: number; brokenAt: number | null }>('GET', '/audit-log/verify'))
                .then((r) => r && setCheck(r.ok ? { ok: true, text: `Chain intact: ${fmt(r.rows)} entries.` } : { ok: false, text: `CHAIN BROKEN at entry ${r.brokenAt}. Escalate now.` }))
            }
          >
            Verify the hash chain
          </Button>
        }
      />
      {check && (
        <Notice tone={check.ok ? 'success' : 'error'} className="mb-3" onClose={() => setCheck(null)}>
          {check.text}
        </Notice>
      )}
      <Err message={page.error ?? action.error} />
      {!page.loaded ? (
        <Loading />
      ) : page.items.length === 0 ? (
        <Empty title="Nothing recorded yet" />
      ) : (
        <ul className="divide-y divide-black/10 overflow-hidden rounded-xl border border-black/15 bg-white">
          {page.items.map((a) => (
            <li key={a.seq} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-[12.5px]">
              <span className="w-14 shrink-0 font-mono text-neutral-500">#{a.seq}</span>
              <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{a.action}</span>
              <span className="text-neutral-600">{a.admin ?? 'system'}</span>
              <span className="ml-auto text-neutral-500">{when(a.createdAt)}</span>
              {(a.targetType || a.targetId) && (
                <span className="w-full pl-0 text-neutral-500 [overflow-wrap:anywhere] sm:pl-[68px]">
                  {a.targetType ?? ''} {a.targetId ?? ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {page.cursor && (
        <Button className="mt-3" busy={page.busy} onClick={page.more}>
          Load older
        </Button>
      )}
    </>
  )
}
