import { useEffect, useState } from 'react'
import type { AdminSettings } from '@raffwin/shared/admin-types'
import { adminCall } from '../adminSession'
import { useAction, useLoad } from '../hooks'
import { Button, Card, Err, Field, Loading, Notice, TabHeading, TextInput } from '../ui'
import { DataReset } from './DataReset'
import { RateAndSales } from './RateAndSales'
import { MyDevices, TeamRisk } from './TeamSecurity'

export function SettingsTab({ can, superAdmin }: { can: string[]; superAdmin: boolean }) {
  const { data: s, error, reload } = useLoad<AdminSettings>('/settings')
  const action = useAction()
  const [limits, setLimits] = useState<{ cap: string; daily: string } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    if (s) setLimits({ cap: s.maxEntriesPerUserPerRaffle?.toString() ?? '', daily: s.dailySpendRaffs?.toString() ?? '' })
  }, [s])

  const saveLimits = () =>
    limits &&
    void action
      .run(() =>
        adminCall('PUT', '/settings/limits', {
          maxEntriesPerUserPerRaffle: limits.cap ? Number(limits.cap) : null,
          dailySpendRaffs: limits.daily ? Number(limits.daily) : null,
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
              <RateAndSales
                s={s}
                canChange={can.includes('settings.rate.request')}
                superAdmin={superAdmin}
                onDone={(m) => {
                  setMsg(m)
                  reload()
                }}
              />
              <Card title="Limits">
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ['cap', 'Most entries per player per raffle', 'Empty = no cap'],
                      ['daily', 'Most Raffs per player per day on entries', 'Empty = no cap'],
                    ] as ['cap' | 'daily', string, string][]
                  ).map(([k, label, hint]) => (
                    <Field key={k} label={label} hint={hint}>
                      <TextInput
                        inputMode="numeric"
                        value={limits[k]}
                        disabled={!can.includes('settings.limits.write')}
                        onChange={(e) => setLimits({ ...limits, [k]: e.target.value.replace(/[^0-9]/g, '') })}
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
          {can.includes('system.reset') && <DataReset />}
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
