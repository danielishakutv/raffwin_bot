import { useState } from 'react'
import { adminCall } from '../adminSession'
import { useAction, useLoad, when } from '../hooks'
import { askConfirm } from '../ask'
import { Badge, Button, Card, Err, Field, Loading, Select, TabHeading, TextInput } from '../ui'

interface AdminAccount {
  id: string
  name: string
  username: string | null
  telegramUsername: string | null
  telegramBound: boolean
  role: string
  status: string
  lastLoginAt: string | null
}

const ROLES = ['viewer', 'support', 'raffle_manager', 'finance', 'super_admin']

export function AdminsTab() {
  const { data, error, reload } = useLoad<AdminAccount[]>('/admins')
  const action = useAction()
  const blank = { name: '', username: '', telegramUsername: '', role: 'viewer' }
  const [form, setForm] = useState(blank)
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null)

  return (
    <>
      <TabHeading title="Admins" sub="Who can open this screen, and what they can do." />
      <Err message={error ?? action.error} />
      {secret && (
        <div className="admin-in mb-4 rounded-xl border-2 border-black bg-white p-4">
          <p className="text-[13px] font-bold">Password for {secret.who}</p>
          <p className="mt-2 select-all break-all rounded-lg bg-neutral-100 px-3 py-2 font-mono text-[15px] font-bold">{secret.password}</p>
          <p className="mt-2 text-[12px] text-neutral-600">Shown once. Give it to them in person or a trusted channel; it cannot be shown again.</p>
          <Button size="sm" className="mt-3" onClick={() => setSecret(null)}>
            I have passed it on
          </Button>
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card title="Add an admin" className="h-max">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            {(
              [
                ['name', 'Full name', undefined],
                ['username', 'Admin username', undefined],
                ['telegramUsername', 'Their Telegram username', 'Bound to their account on first sign-in.'],
              ] as [keyof typeof form, string, string | undefined][]
            ).map(([k, label, hint]) => (
              <Field key={k} label={label} hint={hint}>
                <TextInput autoCapitalize={k === 'name' ? 'words' : 'off'} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              </Field>
            ))}
            <Field label="Role">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r.replace('_', ' ')}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button
            variant="solid"
            className="mt-4 w-full"
            busy={action.busy}
            disabled={!form.name.trim() || !form.username.trim()}
            onClick={() =>
              void action.run(() => adminCall<{ admin: AdminAccount; password: string }>('POST', '/admins', form)).then((r) => {
                if (r) {
                  setSecret({ who: r.admin.name, password: r.password })
                  setForm(blank)
                  reload()
                }
              })
            }
          >
            Add admin
          </Button>
        </Card>

        <div className="grid content-start gap-3 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          {!data ? (
            <Loading />
          ) : (
            data.map((a) => (
              <Card
                key={a.id}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {a.name} <Badge tone={a.status === 'active' ? 'outline' : 'solid'}>{a.status}</Badge>
                  </span>
                }
                subtitle={a.role.replace('_', ' ')}
              >
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
                  <dt className="text-neutral-500">Username</dt>
                  <dd className="truncate font-semibold">{a.username ?? '-'}</dd>
                  <dt className="text-neutral-500">Telegram</dt>
                  <dd className="truncate font-semibold">
                    @{a.telegramUsername ?? '-'} {a.telegramBound ? '(bound)' : '(not signed in yet)'}
                  </dd>
                  <dt className="text-neutral-500">Last sign-in</dt>
                  <dd className="font-semibold">{when(a.lastLoginAt)}</dd>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={action.busy}
                    onClick={async () => {
                      if (!(await askConfirm(`Reset the password for ${a.name}? Their current one stops working.`, 'Reset', true))) return
                      void action.run(() => adminCall<{ password: string }>('POST', `/admins/${a.id}/reset-password`)).then((r) => r && setSecret({ who: a.name, password: r.password }))
                    }}
                  >
                    Reset password
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy}
                    onClick={async () => {
                      if (a.status === 'active' && !(await askConfirm(`Disable ${a.name}? They are signed out and cannot sign in.`, 'Disable', true))) return
                      void action.run(() => adminCall('POST', `/admins/${a.id}/${a.status === 'active' ? 'disable' : 'enable'}`)).then(reload)
                    }}
                  >
                    {a.status === 'active' ? 'Disable' : 'Enable'}
                  </Button>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </>
  )
}
