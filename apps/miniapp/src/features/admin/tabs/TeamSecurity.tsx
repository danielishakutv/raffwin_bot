/**
 * Settings cards for the 19 Oct security rules:
 *   MyDevices  the devices this admin trusts (one tap in Telegram, password only
 *              in a browser) and taking that trust back;
 *   TeamRisk   asking to mark another admin at risk, or to clear it. Nothing
 *              happens until a second admin (not the one concerned) agrees in Approvals.
 */
import type { AdminApproval, AdminDevice, AdminTeamMember } from '@raffwin/shared/admin-types'
import { Monitor, Smartphone } from 'lucide-react'
import { useState } from 'react'
import { adminCall } from '../adminSession'
import { askConfirm, askText } from '../ask'
import { relative, useAction, useLoad, when } from '../hooks'
import { Badge, Button, Card, Empty, Err, Loading, Notice } from '../ui'

const REVOKED: Record<string, string> = {
  removed_by_admin: 'removed by you',
  wrong_passwords: '5 wrong passwords',
  password_reset: 'password reset',
  marked_at_risk: 'account marked at risk',
}

export function MyDevices() {
  const { data, error, reload } = useLoad<AdminDevice[]>('/me/devices')
  const action = useAction()
  const revoke = async (d: AdminDevice) => {
    const ok = await askConfirm(
      d.current ? 'Stop trusting this device? You stay signed in now; the next sign-in takes the full checks.' : `Stop trusting ${d.label}? Its sessions end now.`,
      'Stop trusting',
      true,
    )
    if (ok) void action.run(() => adminCall('POST', `/me/devices/${d.id}/revoke`)).then(reload)
  }
  const active = data?.filter((d) => !d.revokedAt) ?? []
  const past = data?.filter((d) => d.revokedAt) ?? []
  return (
    <Card title="My trusted devices" subtitle="A trusted device skips the full checks: one tap in Telegram, your password alone in a browser. A full sign-in trusts the device it happens on.">
      <Err message={error ?? action.error} />
      {!data ? (
        <Loading rows={2} />
      ) : active.length === 0 ? (
        <Empty title="No trusted devices">Sign in with the full checks on a device to trust it.</Empty>
      ) : (
        <ul className="grid gap-2">
          {active.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-black/10 p-3">
              {d.channel === 'telegram' ? <Smartphone size={16} /> : <Monitor size={16} />}
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 font-semibold">
                  {d.label} {d.current && <Badge tone="solid">this device</Badge>}
                </p>
                <p className="text-[12px] text-neutral-500">
                  Trusted {when(d.createdAt)} · last used {d.lastUsedAt ? relative(d.lastUsedAt) : 'not yet'}
                </p>
              </div>
              <Button size="sm" disabled={action.busy} onClick={() => void revoke(d)}>
                Stop trusting
              </Button>
            </li>
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <details className="mt-3 text-[12.5px] text-neutral-600">
          <summary className="cursor-pointer font-semibold">No longer trusted ({past.length})</summary>
          <ul className="mt-2 grid gap-1">
            {past.map((d) => (
              <li key={d.id}>
                {d.label}: until {when(d.revokedAt)} ({REVOKED[d.revokedReason ?? ''] ?? d.revokedReason})
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  )
}

export function TeamRisk() {
  const { data, error, reload } = useLoad<AdminTeamMember[]>('/team', 10_000)
  const action = useAction()
  const [msg, setMsg] = useState<string | null>(null)
  const ask = async (m: AdminTeamMember, clear: boolean) => {
    const reason = await askText(
      clear
        ? `Why clear the at-risk mark on ${m.name}? A second admin has to agree.`
        : `Why mark ${m.name} at risk? When a second admin agrees, they are signed out everywhere, their trusted devices are removed, and every sign-in takes the full checks.`,
      { confirm: clear ? 'Ask to clear' : 'Ask to mark at risk', danger: !clear, placeholder: 'What you saw' },
    )
    if (!reason) return
    void action.run(() => adminCall<AdminApproval>('POST', `/team/${m.id}/${clear ? 'clear-risk' : 'risk'}`, { reason })).then((a) => {
      if (a) {
        setMsg(`Asked: ${a.summary}. Another admin (not ${m.name}) agrees in Approvals.`)
        reload()
      }
    })
  }
  return (
    <Card title="Admins at risk" subtitle="If an admin account may be compromised, any admin can ask to mark it at risk. It happens only when a second admin agrees, and never by the admin concerned.">
      <Err message={error ?? action.error} />
      {msg && (
        <Notice tone="success" className="mb-3" onClose={() => setMsg(null)}>
          {msg}
        </Notice>
      )}
      {!data ? (
        <Loading rows={2} />
      ) : (
        <ul className="grid gap-2">
          {data.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-black/10 p-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 font-semibold">
                  {m.name}
                  <span className="text-[12px] font-normal text-neutral-500">{m.role.replace('_', ' ')}</span>
                  {m.isMe && <Badge tone="muted">you</Badge>}
                  {m.status === 'disabled' && <Badge tone="dashed">disabled</Badge>}
                  {m.atRisk && <Badge tone="solid">at risk</Badge>}
                </p>
                {m.atRisk && (
                  <p className="text-[12px] text-neutral-600">
                    Since {when(m.riskFlaggedAt)}: {m.riskReason}
                  </p>
                )}
                {m.pending && (
                  <p className="text-[12px] text-neutral-600">
                    Waiting for a second admin: {m.pending.action === 'admin_risk_flag' ? 'mark at risk' : 'clear'}, asked by {m.pending.requestedByMe ? 'you' : m.pending.requestedBy} ({m.pending.reason})
                  </p>
                )}
              </div>
              {!m.isMe && !m.pending && (
                <Button size="sm" disabled={action.busy} onClick={() => void ask(m, m.atRisk)}>
                  {m.atRisk ? 'Ask to clear' : 'Mark at risk'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
