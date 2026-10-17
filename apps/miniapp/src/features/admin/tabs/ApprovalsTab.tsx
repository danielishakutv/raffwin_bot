import { useState } from 'react'
import type { AdminApproval } from '@raffwin/shared/admin-types'
import { adminCall } from '../adminSession'
import { useAction, useLoad, when } from '../hooks'
import { askText } from '../ask'
import { Badge, Button, Empty, Err, Loading, Segmented, TabHeading } from '../ui'

type Status = 'pending' | 'approved' | 'rejected' | 'failed'

export function ApprovalsTab({ can }: { can: string[] }) {
  const [status, setStatus] = useState<Status>('pending')
  const { data, error, reload } = useLoad<AdminApproval[]>(`/approvals?status=${status}`, 5_000)
  const action = useAction()
  const decide = async (id: string, verdict: 'approve' | 'reject') => {
    const note = await askText(verdict === 'approve' ? 'Approve this request? Add a note if you like.' : 'Why reject?', {
      confirm: verdict === 'approve' ? 'Approve' : 'Reject',
      danger: verdict === 'reject',
      optional: verdict === 'approve',
      placeholder: verdict === 'approve' ? 'Note (optional)' : undefined,
    })
    if (note === null) return
    void action.run(() => adminCall('POST', `/approvals/${id}/${verdict}`, { note })).then(reload)
  }
  return (
    <>
      <TabHeading
        title="Approvals"
        sub="A request can only be decided by a different admin from the one who asked."
        aside={
          <Segmented<Status>
            value={status}
            onChange={setStatus}
            options={(['pending', 'approved', 'rejected', 'failed'] as Status[]).map((s) => ({ value: s, label: s[0]?.toUpperCase() + s.slice(1) }))}
          />
        }
      />
      <Err message={error ?? action.error} />
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title={`No ${status} requests`} />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {data.map((a) => (
            <li key={a.id} className="admin-in rounded-xl border border-black/15 bg-white p-4">
              <div className="flex flex-wrap items-start gap-2">
                <p className="min-w-0 flex-1 break-words font-bold">{a.summary}</p>
                <Badge tone={a.status === 'pending' ? 'solid' : 'muted'}>{a.status}</Badge>
              </div>
              <p className="mt-1 break-words text-[12.5px] text-neutral-600">
                Asked by {a.requestedBy} on {when(a.createdAt)} · reason: {a.reason}
              </p>
              {a.decidedBy && (
                <p className="mt-1 text-[12.5px] text-neutral-600">
                  {a.status} by {a.decidedBy} on {when(a.decidedAt)}
                </p>
              )}
              {a.status === 'pending' && can.includes('approvals.decide') && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="solid" size="sm" disabled={action.busy} onClick={() => void decide(a.id, 'approve')}>
                    Approve
                  </Button>
                  <Button size="sm" disabled={action.busy} onClick={() => void decide(a.id, 'reject')}>
                    Reject
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
