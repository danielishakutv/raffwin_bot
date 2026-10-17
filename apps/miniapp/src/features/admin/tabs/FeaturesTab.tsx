/**
 * Feature switches: each registered feature on or off for everyone, plus
 * per-player overrides. The list comes from the API (the shared FEATURES
 * registry), so a new feature appears here without changing this screen.
 */
import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { AdminFeature, AdminFeatureOverride } from '@raffwin/shared/admin-types'
import { featureOverrideBody, featureToggleBody, reasonBody } from '@raffwin/shared/admin-schemas'
import { adminCall } from '../adminSession'
import { askText } from '../ask'
import { problemsOf, useAction, useLoad, when } from '../hooks'
import { Badge, Button, Card, Check, Empty, Err, Field, Loading, Notice, Segmented, Switch, TabHeading, TextArea, TextInput } from '../ui'

export function FeaturesTab({ can }: { can: string[] }) {
  const { data, error, reload } = useLoad<AdminFeature[]>('/features', 15_000)
  const canManage = can.includes('features.manage')
  const [msg, setMsg] = useState<string | null>(null)
  const groups: { audience: AdminFeature['audience']; title: string; sub: string }[] = [
    { audience: 'player', title: 'Player features', sub: 'Things players see and use in the app.' },
    { audience: 'automation', title: 'Automations', sub: 'Things the bot and the server do on their own.' },
  ]
  return (
    <>
      <TabHeading
        title="Features"
        sub={
          canManage
            ? 'Turn features on or off for everyone, or for single players. Players see the change within seconds.'
            : 'Which features are on. Only a super admin can change them.'
        }
      />
      <Err message={error} />
      {msg && (
        <Notice tone="success" className="mb-4" onClose={() => setMsg(null)}>
          {msg}
        </Notice>
      )}
      {!data ? (
        <Loading rows={4} />
      ) : data.length === 0 ? (
        <Empty title="No features registered" />
      ) : (
        <div className="grid gap-6">
          {groups.map((g) => {
            const list = data.filter((f) => f.audience === g.audience)
            if (list.length === 0) return null
            return (
              <section key={g.audience}>
                <h3 className="text-[12px] font-bold uppercase tracking-[0.08em] text-neutral-600">{g.title}</h3>
                <p className="mb-2 text-[12px] text-neutral-500">{g.sub}</p>
                <div className="grid gap-3 xl:grid-cols-2">
                  {list.map((f) => (
                    <FeatureCard key={f.key} f={f} canManage={canManage} onChanged={reload} onDone={setMsg} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </>
  )
}

function FeatureCard({ f, canManage, onChanged, onDone }: { f: AdminFeature; canManage: boolean; onChanged: () => void; onDone: (m: string) => void }) {
  const action = useAction()
  const [turningOn, setTurningOn] = useState<{ tell: boolean; message: string; reason: string } | null>(null)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [overridesOpen, setOverridesOpen] = useState(false)
  const overrideCount = f.overrides.on + f.overrides.off

  const put = async (body: unknown, done: string) => {
    const r = await action.run(() => adminCall<AdminFeature>('PUT', `/features/${f.key}`, body))
    if (r) {
      setTurningOn(null)
      onDone(done)
      onChanged()
    }
  }

  const toggle = async (next: boolean) => {
    if (next) {
      setProblems({})
      setTurningOn({ tell: f.announce !== null, message: f.announce ?? '', reason: '' })
      return
    }
    const reason = await askText(`Turn off "${f.name}" for everyone? Players lose it within seconds (players with their own "on" override keep it). Why? (optional)`, {
      confirm: 'Turn off for everyone',
      danger: true,
      optional: true,
    })
    if (reason === null) return
    void put({ enabled: false, announce: false, reason }, `"${f.name}" is off for everyone.`)
  }

  const confirmOn = () => {
    if (!turningOn) return
    const body = {
      enabled: true,
      announce: turningOn.tell,
      ...(turningOn.tell ? { message: turningOn.message } : {}),
      reason: turningOn.reason,
    }
    if (turningOn.tell && !turningOn.message.trim()) {
      setProblems({ message: 'Write the message players will get, or untick "Tell players".' })
      return
    }
    const parsed = featureToggleBody.safeParse(body)
    if (!parsed.success) {
      setProblems(problemsOf(parsed.error.issues))
      return
    }
    setProblems({})
    void put(parsed.data, turningOn.tell ? `"${f.name}" is on for everyone. The bot is messaging every player now (see Messages).` : `"${f.name}" is on for everyone.`)
  }

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {f.name}
          <Badge tone={f.enabled ? 'solid' : 'muted'}>{f.enabled ? 'on' : 'off'}</Badge>
          {f.enabled !== f.defaultEnabled && <Badge tone="dashed">changed from default</Badge>}
        </span>
      }
      subtitle={f.description}
      actions={<Switch checked={turningOn ? true : f.enabled} label={`${f.name} for everyone`} disabled={!canManage || !!turningOn} busy={action.busy} onChange={(v) => void toggle(v)} />}
    >
      <Err message={action.error} />
      {turningOn && (
        <div className="admin-in mb-3 grid gap-3 rounded-lg border-2 border-black p-3">
          <p className="text-[13.5px] font-bold">Turn on "{f.name}" for everyone</p>
          <Check checked={turningOn.tell} onChange={(tell) => setTurningOn({ ...turningOn, tell })}>
            Tell players through the bot (one message to every player who can receive it)
          </Check>
          {turningOn.tell && (
            <Field label="Message" aside={`${turningOn.message.length}/3000`} error={problems.message} hint={f.announce ? 'The suggested text; edit it if you like.' : undefined}>
              <TextArea value={turningOn.message} maxLength={3000} onChange={(e) => setTurningOn({ ...turningOn, message: e.target.value })} />
            </Field>
          )}
          <Field label="Why? (optional, recorded)" error={problems.reason}>
            <TextInput value={turningOn.reason} maxLength={500} onChange={(e) => setTurningOn({ ...turningOn, reason: e.target.value })} />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setTurningOn(null)}>
              Cancel
            </Button>
            <Button variant="solid" busy={action.busy} onClick={confirmOn}>
              {turningOn.tell ? 'Turn on and tell players' : 'Turn on for everyone'}
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-neutral-600">
        <span>Default: {f.defaultEnabled ? 'on' : 'off'}</span>
        <span>
          Single players: {f.overrides.on} on · {f.overrides.off} off
        </span>
        {f.updatedAt && (
          <span>
            Changed {when(f.updatedAt)}
            {f.updatedBy ? ` by ${f.updatedBy}` : ''}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          icon={overridesOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          onClick={() => setOverridesOpen((o) => !o)}
          aria-expanded={overridesOpen}
        >
          {overridesOpen ? 'Hide single players' : `Single players${overrideCount ? ` (${overrideCount})` : ''}`}
        </Button>
      </div>
      {overridesOpen && <Overrides f={f} canManage={canManage} onChanged={onChanged} />}
    </Card>
  )
}

const blankOverride = { user: '', enabled: 'on' as 'on' | 'off', note: '', notify: false, message: '' }

function Overrides({ f, canManage, onChanged }: { f: AdminFeature; canManage: boolean; onChanged: () => void }) {
  const { data, error, reload } = useLoad<AdminFeatureOverride[]>(`/features/${f.key}/overrides`)
  const action = useAction()
  const [form, setForm] = useState(blankOverride)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string | null>(null)

  const add = async () => {
    const enabled = form.enabled === 'on'
    const notify = enabled && form.notify
    const parsed = featureOverrideBody.safeParse({
      user: form.user,
      enabled,
      note: form.note,
      notify,
      ...(notify && form.message.trim() ? { message: form.message } : {}),
    })
    if (!parsed.success) {
      setProblems(problemsOf(parsed.error.issues))
      return
    }
    setProblems({})
    const r = await action.run(() => adminCall<AdminFeatureOverride>('POST', `/features/${f.key}/overrides`, parsed.data))
    if (r) {
      const who = r.username ? `@${r.username}` : `Telegram ${r.telegramId}`
      setDone(`"${f.name}" is ${r.enabled ? 'on' : 'off'} for ${who}${notify ? '; the bot is telling them' : ''}.`)
      setForm(blankOverride)
      reload()
      onChanged()
    }
  }

  const clear = async (o: AdminFeatureOverride) => {
    const who = o.username ? `@${o.username}` : `Telegram ${o.telegramId}`
    const reason = await askText(`Remove ${who}'s override? They follow the switch for everyone (${f.enabled ? 'on' : 'off'}) again. Why?`, { confirm: 'Remove' })
    if (reason === null) return
    const parsed = reasonBody.safeParse({ reason })
    if (!parsed.success) {
      action.clearError()
      setDone(null)
      setProblems({ clear: parsed.error.issues[0]?.message ?? 'Say why, in a few words' })
      return
    }
    setProblems({})
    const r = await action.run(() => adminCall('POST', `/features/overrides/${o.id}/clear`, parsed.data).then(() => true))
    if (r) {
      setDone(`${who} follows the switch for everyone again.`)
      reload()
      onChanged()
    }
  }

  return (
    <div className="admin-in mt-3 grid gap-3 border-t border-black/10 pt-3">
      <Err message={error ?? action.error ?? problems.clear} />
      {done && (
        <Notice tone="success" onClose={() => setDone(null)}>
          {done}
        </Notice>
      )}
      {canManage && (
        <div className="grid gap-3 rounded-lg bg-neutral-50 p-3 sm:grid-cols-2">
          <Field label="Player" hint="Username (with or without @) or Telegram id" error={problems.user}>
            <TextInput autoCapitalize="off" spellCheck={false} placeholder="@ada_obi" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
          </Field>
          <Field group label="For this player">
            <Segmented<'on' | 'off'>
              value={form.enabled}
              onChange={(enabled) => setForm({ ...form, enabled })}
              options={[
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]}
            />
          </Field>
          <Field label="Why? (recorded)" error={problems.note} className="sm:col-span-2">
            <TextInput value={form.note} maxLength={300} placeholder="e.g. beta tester" onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          {form.enabled === 'on' && (
            <div className="grid gap-2 sm:col-span-2">
              <Check checked={form.notify} onChange={(notify) => setForm({ ...form, notify, message: notify && !form.message ? (f.announce ?? '') : form.message })}>
                Tell this player through the bot
              </Check>
              {form.notify && (
                <Field label="Message" error={problems.message} hint={`Empty sends: ${f.announce ?? `"${f.name}" is now on for you.`}`}>
                  <TextArea value={form.message} maxLength={3000} onChange={(e) => setForm({ ...form, message: e.target.value })} />
                </Field>
              )}
            </div>
          )}
          <div className="sm:col-span-2">
            <Button variant="solid" busy={action.busy} onClick={() => void add()}>
              Add override
            </Button>
          </div>
        </div>
      )}
      {!data ? (
        <Loading rows={1} />
      ) : data.length === 0 ? (
        <p className="text-[13px] text-neutral-600">No single-player overrides: everyone follows the switch above.</p>
      ) : (
        <ul className="divide-y divide-black/10 rounded-lg border border-black/10">
          {data.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12.5px]">
              <Badge tone={o.enabled ? 'solid' : 'outline'}>{o.enabled ? 'on' : 'off'}</Badge>
              <span className="font-semibold">{o.username ? `@${o.username}` : `Telegram ${o.telegramId}`}</span>
              <span className="min-w-0 flex-1 text-neutral-600 [overflow-wrap:anywhere]">{o.note}</span>
              <span className="text-neutral-500">
                {when(o.createdAt)}
                {o.createdBy ? ` · ${o.createdBy}` : ''}
              </span>
              {canManage && (
                <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void clear(o)}>
                  Clear
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
