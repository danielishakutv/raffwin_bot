/**
 * Player detail cards for engagement, delivery, feature switches and bot
 * messages (PlayersTab). Each card reads straight from AdminUserDetail.
 */
import { useState } from 'react'
import type { AdminFeatureOverride, AdminNotification, AdminRole, AdminUserDetail, AdminUserFeature } from '@raffwin/shared/admin-types'
import { ApiError } from '@/api/errors'
import { adminCall } from '../adminSession'
import { askConfirm, askText } from '../ask'
import { plainText, relative, useAction, when } from '../hooks'
import { Badge, Button, Card, Err, Field, KeyValues, Notice, Select, TextInput } from '../ui'

export function PlayerEngagement({ d }: { d: AdminUserDetail }) {
  const e = d.engagement
  return (
    <Card title="Engagement" subtitle="Bot reminders, come-back offers and the daily streak.">
      <KeyValues
        rows={[
          ['Last opened the app', d.user.lastSeenAt ? `${when(d.user.lastSeenAt)} (${relative(d.user.lastSeenAt)})` : 'never'],
          ['Reminders', e.remindersOn ? 'on' : <Badge tone="outline">turned off by the player</Badge>],
          ['Next reminder', e.nextReminderAt ? `${when(e.nextReminderAt)} (${relative(e.nextReminderAt)})` : e.remindersOn ? 'none planned until they open the app' : '-'],
          ['Reminders since last open', String(e.remindersSinceLastOpen)],
          ['Last reminder', when(e.lastReminderAt)],
          ['Bot blocked', e.botBlockedAt ? <Badge tone="solid">since {when(e.botBlockedAt)}</Badge> : 'no'],
          ['Streak', `${e.streak.current} now · best ${e.streak.best}${e.streak.lastClaimedDay ? ` · last claimed ${e.streak.lastClaimedDay}` : ''}`],
        ]}
      />
      <p className="mt-4 text-[12px] font-bold uppercase tracking-[0.08em] text-neutral-600">Come-back offers</p>
      {e.comebackOffers.length === 0 ? (
        <p className="mt-1 text-[13px] text-neutral-600">None offered yet.</p>
      ) : (
        <ul className="mt-1 divide-y divide-black/10 text-[12.5px]">
          {e.comebackOffers.map((o) => (
            <li key={o.offeredAt} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
              <span className="font-semibold">
                {o.raffs} Raff{o.raffs === 1 ? '' : 's'} offered {when(o.offeredAt)}
              </span>
              <span className="ml-auto">
                {o.claimedAt ? (
                  <Badge tone="solid">claimed {when(o.claimedAt)}</Badge>
                ) : new Date(o.expiresAt).getTime() < Date.now() ? (
                  <Badge tone="muted">expired</Badge>
                ) : (
                  <Badge tone="outline">open until {when(o.expiresAt)}</Badge>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function PlayerDelivery({ d }: { d: AdminUserDetail }) {
  return (
    <Card title="Delivery" subtitle="Where a physical prize goes: the courier calls the phone above.">
      {d.delivery ? (
        <KeyValues
          rows={[
            ['State', d.delivery.state],
            ['City', d.delivery.city],
            ['Motor park', d.delivery.motorPark, 'strong'],
          ]}
        />
      ) : (
        <p className="text-[13px] text-neutral-600">No delivery details yet: the player has not completed verification (KYC).</p>
      )}
    </Card>
  )
}

const GONE = 'That override is already gone. The list has been refreshed.'

export function PlayerFeatures({ d, canManage, onChanged }: { d: AdminUserDetail; canManage: boolean; onChanged: () => void }) {
  const action = useAction()
  const [done, setDone] = useState<string | null>(null)
  const who = d.user.username ? `@${d.user.username}` : `Telegram ${d.user.telegramId}`

  const force = async (f: AdminUserFeature, enabled: boolean) => {
    const note = await askText(`${enabled ? 'Turn on' : 'Turn off'} "${f.name}" for ${who} only. Why? (recorded)`, { confirm: enabled ? 'Turn on for them' : 'Turn off for them' })
    if (!note) return
    const r = await action.run(() =>
      adminCall<AdminFeatureOverride>('POST', `/features/${f.key}/overrides`, { user: String(d.user.telegramId), enabled, note, notify: false }),
    )
    if (r) {
      setDone(`"${f.name}" is now ${enabled ? 'on' : 'off'} for ${who}, whatever the switch for everyone says.`)
      onChanged()
    }
  }

  const clear = async (f: AdminUserFeature) => {
    const reason = await askText(`Remove ${who}'s own setting for "${f.name}"? They follow the switch for everyone (${f.global ? 'on' : 'off'}) again. Why?`, {
      confirm: 'Remove override',
    })
    if (!reason) return
    const r = await action.run(async () => {
      if (!f.overrideId) throw new Error(GONE)
      try {
        await adminCall('POST', `/features/overrides/${f.overrideId}/clear`, { reason })
      } catch (error) {
        // Another admin cleared it first: say so, and the refresh below shows the current state
        if (error instanceof ApiError && error.code === 'NOT_FOUND') throw new Error(GONE)
        throw error
      }
      return true
    })
    if (r) setDone(`${who} follows the switch for everyone for "${f.name}" again.`)
    onChanged()
  }

  return (
    <Card title="Features" subtitle="The switch for everyone, this player's own override, and what applies.">
      <Err message={action.error} />
      {done && (
        <Notice tone="success" className="mb-2" onClose={() => setDone(null)}>
          {done}
        </Notice>
      )}
      <ul className="divide-y divide-black/10">
        {d.features.map((f) => (
          <li key={f.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 text-[13px]">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{f.name}</span>
              <span className="block text-[11.5px] text-neutral-500">
                Everyone: {f.global ? 'on' : 'off'} · Override: {f.override === null ? 'none' : f.override ? 'on' : 'off'}
              </span>
            </span>
            <Badge tone={f.effective ? 'solid' : 'muted'}>{f.effective ? 'on' : 'off'}</Badge>
            {canManage && (
              <span className="flex flex-wrap gap-1">
                {f.override !== true && (
                  <Button size="sm" disabled={action.busy} onClick={() => void force(f, true)}>
                    Turn on
                  </Button>
                )}
                {f.override !== false && (
                  <Button size="sm" disabled={action.busy} onClick={() => void force(f, false)}>
                    Turn off
                  </Button>
                )}
                {f.override !== null && (
                  <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void clear(f)}>
                    Clear
                  </Button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

const ADMIN_ROLES: AdminRole[] = ['viewer', 'support', 'raffle_manager', 'finance', 'super_admin']

/**
 * Make this player an admin (super admin). The account is bound to their
 * Telegram at once; the generated password is shown here once, to pass on in person.
 */
export function MakeAdmin({ d, onMade }: { d: AdminUserDetail; onMade: () => void }) {
  const action = useAction()
  const [open, setOpen] = useState(false)
  const suggested = (d.user.username ?? d.user.tgUsername ?? '').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 32)
  const [form, setForm] = useState({ name: d.user.fullName ?? '', username: suggested, role: 'viewer' as AdminRole })
  const [secret, setSecret] = useState<string | null>(null)

  if (secret)
    return (
      <div className="admin-in rounded-xl border-2 border-black bg-white p-4">
        <p className="text-[13px] font-bold">
          {form.name} is now an admin. Their sign-in: username <span className="font-mono">{form.username}</span> and this password
        </p>
        <p className="mt-2 select-all break-all rounded-lg bg-neutral-100 px-3 py-2 font-mono text-[15px] font-bold">{secret}</p>
        <p className="mt-2 text-[12px] text-neutral-600">
          Shown once. Give it to them in person or a trusted channel, with the master password. Their Telegram account is already bound: they sign in from the bot.
        </p>
        <Button size="sm" className="mt-3" onClick={() => setSecret(null)}>
          I have passed it on
        </Button>
      </div>
    )

  return (
    <Card
      title="Make admin"
      subtitle="Gives this player's Telegram account access to the admin screen."
      actions={
        !open && (
          <Button size="sm" onClick={() => setOpen(true)}>
            Make admin
          </Button>
        )
      }
    >
      {open ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Full name">
            <TextInput autoCapitalize="words" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Admin username" hint="3-32 of a-z 0-9 _ .">
            <TextInput autoCapitalize="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </Field>
          <Field label="Role">
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AdminRole })}>
              {ADMIN_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Err message={action.error} className="sm:col-span-3" />
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            <Button
              variant="solid"
              busy={action.busy}
              disabled={form.name.trim().length < 2 || form.username.trim().length < 3}
              onClick={async () => {
                const role = form.role.replace('_', ' ')
                if (!(await askConfirm(`Make @${d.user.username ?? d.user.telegramId} an admin with the role ${role}?`, 'Make admin', form.role === 'super_admin'))) return
                const r = await action.run(() => adminCall<{ password: string }>('POST', `/users/${d.user.id}/make-admin`, form))
                if (r) {
                  setSecret(r.password)
                  onMade()
                }
              }}
            >
              Make admin
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-neutral-600">Not an admin. Bound by their Telegram id, so a username change cannot move the access to someone else.</p>
      )}
    </Card>
  )
}

const STATUS_TONE: Record<AdminNotification['status'], 'solid' | 'outline' | 'muted' | 'dashed'> = {
  sent: 'outline',
  pending: 'dashed',
  sending: 'dashed',
  failed: 'solid',
  skipped: 'muted',
}

/** One bot message: kind, status, its plain text and why it failed, if it did. */
export function NotificationRow({ n, showUser }: { n: AdminNotification; showUser?: boolean }) {
  return (
    <li className="admin-in px-4 py-2.5 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={STATUS_TONE[n.status]}>{n.status}</Badge>
        <span className="font-semibold">
          {n.kind.replace('_', ' ')}
          {n.templateKey ? ` · ${n.templateKey}` : ''}
        </span>
        {showUser && <span className="text-neutral-600">{n.username ? `@${n.username}` : 'no username'}</span>}
        <span className="ml-auto text-neutral-500">{n.sentAt ? `sent ${when(n.sentAt)}` : n.status === 'pending' ? `due ${when(n.notBefore)}` : when(n.createdAt)}</span>
      </div>
      <p className="mt-1 line-clamp-3 whitespace-pre-line text-neutral-700 [overflow-wrap:anywhere]">{plainText(n.text)}</p>
      {n.error && (
        <p className="mt-1 font-semibold [overflow-wrap:anywhere]">
          {n.status === 'failed' ? 'Failed' : 'Last error'}: {n.error}
          {n.attempts > 1 ? ` (${n.attempts} tries)` : ''}
        </p>
      )}
    </li>
  )
}

export function PlayerBotMessages({ d }: { d: AdminUserDetail }) {
  return (
    <Card title="Bot messages" subtitle="Latest 30 sent (or waiting) to this player." bodyClassName="p-0">
      {d.notifications.length === 0 ? (
        <p className="p-4 text-[13px] text-neutral-600">The bot has not messaged this player yet.</p>
      ) : (
        <ul className="max-h-[420px] divide-y divide-black/10 overflow-y-auto">
          {d.notifications.map((n) => (
            <NotificationRow key={n.id} n={n} />
          ))}
        </ul>
      )}
    </Card>
  )
}
