import { useEffect, useState } from 'react'
import type { AdminApproval, AdminSettings } from '@raffwin/shared/admin-types'
import { adminCall } from '../adminSession'
import { useAction, useLoad } from '../hooks'
import { askText } from '../ask'
import { Button, Card, Err, Field, Loading, Notice, TabHeading, TextInput } from '../ui'
import { MyDevices, TeamRisk } from './TeamSecurity'

export function SettingsTab({ can, superAdmin }: { can: string[]; superAdmin: boolean }) {
  const { data: s, error, reload } = useLoad<AdminSettings>('/settings')
  const action = useAction()
  const [base, setBase] = useState('')
  const [limits, setLimits] = useState<{ cap: string; daily: string; nps: string } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    if (s) setLimits({ cap: s.maxEntriesPerUserPerRaffle?.toString() ?? '', daily: s.dailySpendRaffs?.toString() ?? '', nps: String(s.nairaPerStar) })
  }, [s])

  const changeBase = async () => {
    const reason = await askText(superAdmin ? 'Why change the base? It applies from the next hour.' : 'Why change the base? A second admin approves it.')
    if (reason)
      void action
        .run(() => adminCall<AdminApproval>('POST', '/settings/rate-base', { starsPerRaff: Number(base), reason }))
        .then((a) => a && (setMsg(a.status === 'approved' ? `Done: ${a.summary} (from the next hour)` : `Queued for approval: ${a.summary}`), setBase('')))
  }
  const saveLimits = () =>
    limits &&
    void action
      .run(() =>
        adminCall('PUT', '/settings/limits', {
          maxEntriesPerUserPerRaffle: limits.cap ? Number(limits.cap) : null,
          dailySpendRaffs: limits.daily ? Number(limits.daily) : null,
          nairaPerStar: Number(limits.nps),
        }),
      )
      .then((r) => {
        if (r) {
          setMsg('Limits saved.')
          reload()
        }
      })

  return (
    <>
      <TabHeading title="Settings" />
      <Err message={error ?? action.error} />
      {msg && (
        <Notice tone="success" className="mb-4" onClose={() => setMsg(null)}>
          {msg}
        </Notice>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="grid content-start gap-4">
          {!s || !limits ? (
            <Loading rows={2} />
          ) : (
            <>
              <Card title="Rate" subtitle={`Base: ${s.baseStarsPerRaff} Stars per Raff. Each hour moves 3% to 15% up or down from the base.`}>
                {can.includes('settings.rate.request') ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="New base (Stars per Raff)" className="min-w-0 flex-1">
                      <TextInput inputMode="decimal" placeholder="e.g. 0.5" value={base} onChange={(e) => setBase(e.target.value.replace(/[^0-9.]/g, ''))} />
                    </Field>
                    <Button disabled={!base || action.busy} onClick={() => void changeBase()}>
                      {superAdmin ? 'Change base' : 'Ask to change'}
                    </Button>
                  </div>
                ) : (
                  <p className="text-[13px] text-neutral-600">Your role can see the rate but not change it.</p>
                )}
              </Card>
              <Card title="Limits and display">
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ['cap', 'Most entries per player per raffle', 'Empty = no cap'],
                      ['daily', 'Most Raffs per player per day on entries', 'Empty = no cap'],
                      ['nps', 'Naira shown per Star', 'Display only; also values Raffs in Finance'],
                    ] as ['cap' | 'daily' | 'nps', string, string][]
                  ).map(([k, label, hint]) => (
                    <Field key={k} label={label} hint={hint} className={k === 'nps' ? 'sm:col-span-2' : undefined}>
                      <TextInput
                        inputMode={k === 'nps' ? 'decimal' : 'numeric'}
                        value={limits[k]}
                        disabled={!can.includes('settings.limits.write')}
                        onChange={(e) => setLimits({ ...limits, [k]: e.target.value.replace(k === 'nps' ? /[^0-9.]/g : /[^0-9]/g, '') })}
                      />
                    </Field>
                  ))}
                </div>
                {can.includes('settings.limits.write') && (
                  <Button variant="solid" className="mt-4" busy={action.busy} onClick={saveLimits}>
                    Save limits
                  </Button>
                )}
              </Card>
            </>
          )}
        </div>
        <div className="grid content-start gap-4">
          <MyPassword />
          <MyDevices />
          <TeamRisk />
        </div>
      </div>
    </>
  )
}

function MyPassword() {
  const action = useAction()
  const [form, setForm] = useState({ current: '', next: '', again: '' })
  const [done, setDone] = useState(false)
  const mismatch = form.again !== '' && form.next !== form.again
  return (
    <Card title="My password" subtitle="At least 12 characters. Your other admin sessions end when you change it." className="h-max">
      <Err message={action.error} />
      {done && (
        <Notice tone="success" className="mb-3" onClose={() => setDone(false)}>
          Password changed.
        </Notice>
      )}
      <div className="grid gap-3">
        {(
          [
            ['current', 'Current password'],
            ['next', 'New password'],
            ['again', 'New password again'],
          ] as ['current' | 'next' | 'again', string][]
        ).map(([k, label]) => (
          <Field
            key={k}
            label={label}
            error={k === 'again' && mismatch ? 'The two new passwords differ.' : null}
            aside={k === 'next' && form.next ? `${form.next.length}/12+` : undefined}
          >
            <TextInput type="password" autoComplete={k === 'current' ? 'current-password' : 'new-password'} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <Button
        variant="solid"
        className="mt-4"
        busy={action.busy}
        disabled={!form.current || form.next.length < 12 || mismatch || form.next !== form.again}
        onClick={() =>
          void action.run(() => adminCall('POST', '/me/password', { current: form.current, next: form.next })).then((r) => {
            if (r) {
              setDone(true)
              setForm({ current: '', next: '', again: '' })
            }
          })
        }
      >
        Change my password
      </Button>
    </Card>
  )
}
