/**
 * Bot messages: announcements to players (composer + history with live
 * progress), the outbox of every message the bot sends, and the settings for
 * reminders, come-back offers, streak rewards and transfer caps.
 */
import { useState } from 'react'
import { RefreshCw, Send, X } from 'lucide-react'
import type { AdminBroadcast, AdminNotification, NotificationKind } from '@raffwin/shared/admin-types'
import { broadcastBody, type BroadcastBody } from '@raffwin/shared/admin-schemas'
import { adminCall } from '../adminSession'
import { askConfirm } from '../ask'
import { digits, fmt, problemsOf, useAction, useLoad, usePaged, when } from '../hooks'
import { Badge, Bar, Button, Card, Check, Empty, Err, Field, Loading, Notice, Segmented, Select, TabHeading, TextArea, TextInput } from '../ui'
import { EngagementSettings } from './EngagementSettings'
import { NotificationRow } from './PlayerCards'

type Section = 'broadcasts' | 'outbox' | 'engagement'
const SECTION_KEY = 'raffwin_admin_messages_section'

function rememberedSection(): Section {
  try {
    const s = sessionStorage.getItem(SECTION_KEY)
    return s === 'outbox' || s === 'engagement' ? s : 'broadcasts'
  } catch {
    // Storage blocked: start on the composer
    return 'broadcasts'
  }
}

export function MessagesTab({ can }: { can: string[] }) {
  const [section, setSectionState] = useState<Section>(rememberedSection)
  const setSection = (s: Section) => {
    setSectionState(s)
    try {
      sessionStorage.setItem(SECTION_KEY, s)
    } catch (e) {
      console.warn('[admin] could not remember the messages section', e)
    }
  }
  return (
    <>
      <TabHeading title="Messages" sub="What the bot sends to players' Telegram chats." />
      <Segmented<Section>
        className="mb-4"
        value={section}
        onChange={setSection}
        options={[
          { value: 'broadcasts', label: 'Announcements' },
          { value: 'outbox', label: 'Outbox' },
          { value: 'engagement', label: 'Reminders and offers' },
        ]}
      />
      {section === 'broadcasts' && <Broadcasts canSend={can.includes('messages.send')} />}
      {section === 'outbox' && <Outbox />}
      {section === 'engagement' && <EngagementSettings canWrite={can.includes('engagement.write')} />}
    </>
  )
}

/* Announcements ---------------------------------------------------------------- */

type AudienceType = BroadcastBody['audience']['type']

interface Draft {
  title: string
  text: string
  openButton: boolean
  audience: AudienceType
  days: string
  users: string
}
const blank: Draft = { title: '', text: '', openButton: true, audience: 'all', days: '3', users: '' }

const splitUsers = (raw: string) =>
  raw
    .split(/[\s,;]+/)
    .map((u) => u.trim())
    .filter(Boolean)

function audienceOf(d: Draft): unknown {
  if (d.audience === 'inactive') return { type: 'inactive', days: d.days ? Number(d.days) : NaN }
  if (d.audience === 'users') return { type: 'users', users: splitUsers(d.users) }
  return { type: d.audience }
}

function audienceLabel(d: Draft): string {
  if (d.audience === 'no_phone') return 'every player who has not shared a phone number yet'
  if (d.audience === 'inactive') return `every player who has not opened the app for ${d.days || '?'}+ days`
  if (d.audience === 'users') {
    const n = splitUsers(d.users).length
    return `${n} named player${n === 1 ? '' : 's'}`
  }
  return 'every player'
}

const FRIENDLY: Record<string, string> = {
  'audience.days': 'Enter a number of days, 1 to 365',
  'audience.users': 'List at least one player (usernames or Telegram ids)',
}

function Broadcasts({ canSend }: { canSend: boolean }) {
  const history = useLoad<AdminBroadcast[]>('/broadcasts', 5_000)
  const action = useAction()
  const [d, setD] = useState<Draft>(blank)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string | null>(null)

  const parse = (test: boolean) => {
    const parsed = broadcastBody.safeParse({ title: d.title, text: d.text, openButton: d.openButton, audience: audienceOf(d), test })
    if (!parsed.success) {
      const p = problemsOf(parsed.error.issues)
      for (const k of Object.keys(p)) {
        const friendly = FRIENDLY[k]
        if (friendly) p[k] = friendly
        // One bad entry in the list: name it
        const item = /^audience\.users\.(\d+)$/.exec(k)
        if (item) p['audience.users'] ??= `"${splitUsers(d.users)[Number(item[1])] ?? ''}" is not a username or Telegram id`
      }
      setProblems(p)
      return null
    }
    setProblems({})
    return parsed.data
  }

  const send = async (test: boolean) => {
    setDone(null)
    const body = parse(test)
    if (!body) return
    if (!test && !(await askConfirm(`Send this message to ${audienceLabel(d)}? You can cancel what has not been sent yet, but delivered messages stay delivered.`, 'Send now'))) return
    const b = await action.run(() => adminCall<AdminBroadcast>('POST', '/broadcasts', body))
    if (!b) return
    if (test) {
      setDone('Test queued for your own Telegram chat. It arrives within a few seconds.')
    } else {
      setDone(`Sending to ${b.audienceLabel}. Progress shows below.`)
      setD(blank)
    }
    history.reload()
  }

  const cancel = async (b: AdminBroadcast) => {
    if (!(await askConfirm(`Stop "${b.title || b.text.slice(0, 40)}"? Messages not yet sent are dropped; ${fmt(b.sent)} already delivered stay delivered.`, 'Stop sending', true))) return
    const r = await action.run(() => adminCall('POST', `/broadcasts/${b.id}/cancel`).then(() => true))
    if (r) {
      setDone('Stopped. Nothing more goes out for that announcement.')
      history.reload()
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="grid content-start gap-4">
        <Card title="New announcement" subtitle="Sent by the bot to each player's private chat. Plain text; line breaks are kept.">
          {!canSend && <Notice className="mb-3">Your role can read messages but not send them.</Notice>}
          <Err message={action.error} />
          {done && (
            <Notice tone="success" className="mb-3" onClose={() => setDone(null)}>
              {done}
            </Notice>
          )}
          <div className="grid gap-3">
            <Field label="Title (optional, shown in bold)" aside={`${d.title.length}/120`} error={problems.title}>
              <TextInput value={d.title} maxLength={120} disabled={!canSend} onChange={(e) => setD({ ...d, title: e.target.value })} />
            </Field>
            <Field label="Message" aside={`${d.text.length}/3500`} error={problems.text}>
              <TextArea className="min-h-32" value={d.text} maxLength={3500} disabled={!canSend} onChange={(e) => setD({ ...d, text: e.target.value })} />
            </Field>
            <Check checked={d.openButton} disabled={!canSend} onChange={(openButton) => setD({ ...d, openButton })}>
              Add an "Open Raffle Win" button under the message
            </Check>
            <Field group label="Who gets it">
              <Segmented<AudienceType>
                size="sm"
                value={d.audience}
                onChange={(audience) => setD({ ...d, audience })}
                options={[
                  { value: 'all', label: 'Everyone' },
                  { value: 'no_phone', label: 'No phone yet' },
                  { value: 'inactive', label: 'Inactive' },
                  { value: 'users', label: 'Specific players' },
                ]}
              />
            </Field>
            {d.audience === 'inactive' && (
              <Field label="Not opened the app for at least (days)" error={problems['audience.days']}>
                <TextInput inputMode="numeric" className="max-w-32" value={d.days} disabled={!canSend} onChange={(e) => setD({ ...d, days: digits(e.target.value).slice(0, 3) })} />
              </Field>
            )}
            {d.audience === 'users' && (
              <Field
                label="Players"
                hint="Usernames (with or without @) or Telegram ids, separated by commas, spaces or new lines. Up to 500."
                error={problems['audience.users'] ?? problems.audience}
              >
                <TextArea value={d.users} disabled={!canSend} placeholder="@ada_obi, @tunde, 123456789" onChange={(e) => setD({ ...d, users: e.target.value })} />
              </Field>
            )}
            <p className="text-[12px] text-neutral-500">Players who blocked the bot or are suspended are left out. Reminder opt-outs do not apply to announcements.</p>
            {canSend && (
              <div className="flex flex-wrap gap-2">
                <Button busy={action.busy} onClick={() => void send(true)}>
                  Send test to me
                </Button>
                <Button variant="solid" icon={<Send size={14} />} busy={action.busy} onClick={() => void send(false)}>
                  Send
                </Button>
              </div>
            )}
          </div>
        </Card>
        <Preview d={d} />
      </div>
      <Card
        title="Sent announcements"
        subtitle="Latest 50, live every 5 seconds."
        className="h-max"
        bodyClassName="p-0"
        actions={
          <Button size="sm" icon={<RefreshCw size={14} className={history.busy ? 'animate-spin' : undefined} />} onClick={history.reload}>
            Refresh
          </Button>
        }
      >
        <Err message={history.error} className="mx-4" />
        {!history.data ? (
          <div className="p-4">
            <Loading rows={2} />
          </div>
        ) : history.data.length === 0 ? (
          <p className="p-4 text-[13px] text-neutral-600">Nothing sent yet.</p>
        ) : (
          <ul className="divide-y divide-black/10">
            {history.data.map((b) => (
              <BroadcastRow key={b.id} b={b} canCancel={canSend} busy={action.busy} onCancel={() => void cancel(b)} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

const KIND_LABEL: Record<AdminBroadcast['kind'], string> = {
  announcement: 'Announcement',
  feature: 'Feature on',
  raffle_new: 'New raffle',
  raffle_cancelled: 'Raffle cancelled',
  raffle_drawn: 'Winners announced',
  raffle_soon: 'Last chance before a draw',
}

const STATUS_LABEL: Record<AdminBroadcast['status'], string> = {
  fanning_out: 'queueing',
  sending: 'sending',
  done: 'done',
  cancelled: 'stopped',
}

function BroadcastRow({ b, canCancel, busy, onCancel }: { b: AdminBroadcast; canCancel: boolean; busy: boolean; onCancel: () => void }) {
  const finished = b.sent + b.failed + b.skipped
  const stopped = b.status === 'cancelled'
  const live = b.status === 'fanning_out' || b.status === 'sending'
  return (
    <li className="admin-in px-4 py-3 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={live ? 'solid' : b.status === 'cancelled' ? 'muted' : 'outline'}>{STATUS_LABEL[b.status]}</Badge>
        <span className="font-semibold">{KIND_LABEL[b.kind]}</span>
        <span className="text-neutral-600">to {b.audienceLabel}</span>
        <span className="ml-auto text-neutral-500">{when(b.createdAt)}</span>
      </div>
      {b.title && <p className="mt-1.5 font-bold [overflow-wrap:anywhere]">{b.title}</p>}
      <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-neutral-700 [overflow-wrap:anywhere]">{b.text}</p>
      <Bar className="mt-2" value={b.total ? finished / b.total : b.status === 'done' ? 1 : 0} />
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-neutral-600">
        <span>
          <b className="text-black">{fmt(b.sent)}</b> sent
        </span>
        {b.failed > 0 && (
          <span>
            <b className="text-black">{fmt(b.failed)}</b> failed
          </span>
        )}
        {b.pending > 0 && <span>{fmt(b.pending)} waiting</span>}
        {b.skipped > 0 && (
          // Never attempted, so not a failure: the broadcast was stopped, or the player blocked the bot or is suspended
          <span title={stopped ? 'Not sent: the broadcast was stopped, or the player blocked the bot or is suspended' : 'Not sent: the player blocked the bot or is suspended'}>
            {fmt(b.skipped)} {stopped ? 'not sent (stopped)' : 'skipped (unreachable)'}
          </span>
        )}
        <span>
          of {fmt(b.total)}
          {b.status === 'fanning_out' ? ' so far' : ''}
        </span>
        {b.createdBy && <span>· {b.createdBy}</span>}
        {b.finishedAt && <span>· finished {when(b.finishedAt)}</span>}
        {live && canCancel && (
          <Button size="sm" variant="danger" className="ml-auto" icon={<X size={13} />} disabled={busy} onClick={onCancel}>
            Stop
          </Button>
        )}
      </div>
    </li>
  )
}

/** Roughly how the message looks in Telegram. */
function Preview({ d }: { d: Draft }) {
  const empty = !d.title.trim() && !d.text.trim()
  return (
    <Card title="Preview" subtitle="Roughly how it looks in the player's chat.">
      <div className="rounded-xl bg-neutral-100 p-3">
        <div className="max-w-[420px] rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 text-[14px] leading-snug shadow-[0_1px_1px_rgba(0,0,0,0.12)]">
          {empty ? (
            <p className="text-neutral-400">Your message appears here.</p>
          ) : (
            <>
              {d.title.trim() && <p className="font-bold [overflow-wrap:anywhere]">{d.title.trim()}</p>}
              {d.title.trim() && d.text.trim() && <p className="h-3" aria-hidden />}
              <p className="whitespace-pre-line [overflow-wrap:anywhere]">{d.text.trim()}</p>
            </>
          )}
        </div>
        {d.openButton && (
          <div className="mt-1 max-w-[420px] rounded-xl bg-white/80 py-2 text-center text-[13.5px] font-semibold shadow-[0_1px_1px_rgba(0,0,0,0.12)]">Open Raffle Win</div>
        )}
      </div>
    </Card>
  )
}

/* Outbox ------------------------------------------------------------------------ */

const KINDS: { value: '' | NotificationKind; label: string }[] = [
  { value: '', label: 'Every kind' },
  { value: 'reminder', label: 'Reminders' },
  { value: 'comeback', label: 'Come-back offers' },
  { value: 'announcement', label: 'Announcements' },
  { value: 'feature', label: 'Feature news' },
  { value: 'raffle_new', label: 'New raffles' },
  { value: 'raffle_cancelled', label: 'Cancelled raffles' },
  { value: 'raffle_drawn', label: 'Winners announced' },
  { value: 'raffle_won', label: 'Winner messages' },
  { value: 'raffle_soon', label: 'Draw reminders' },
  { value: 'transfer', label: 'Raffs received' },
  { value: 'credit', label: 'Admin credits' },
  { value: 'purchase', label: 'Purchases' },
  { value: 'system', label: 'System' },
]
type Status = '' | AdminNotification['status']

function Outbox() {
  const [kind, setKind] = useState<'' | NotificationKind>('')
  const [status, setStatus] = useState<Status>('')
  const [round, setRound] = useState(0)
  const query = new URLSearchParams({ ...(kind ? { kind } : {}), ...(status ? { status } : {}) }).toString()
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-auto min-w-44" value={kind} onChange={(e) => setKind(e.target.value as '' | NotificationKind)} aria-label="Kind">
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
        <Segmented<Status>
          size="sm"
          value={status}
          onChange={setStatus}
          options={(['', 'pending', 'sent', 'failed', 'skipped'] as Status[]).map((s) => ({ value: s, label: s ? s[0]?.toUpperCase() + s.slice(1) : 'All' }))}
        />
        <Button size="sm" className="ml-auto" icon={<RefreshCw size={14} />} onClick={() => setRound((r) => r + 1)}>
          Refresh
        </Button>
      </div>
      {/* A new key reloads the list from the top */}
      <OutboxList key={`${query}:${round}`} path={`/notifications${query ? `?${query}` : ''}`} />
    </>
  )
}

function OutboxList({ path }: { path: string }) {
  const page = usePaged<AdminNotification>(path)
  return (
    <>
      <Err message={page.error} />
      {!page.loaded ? (
        <Loading />
      ) : page.items.length === 0 ? (
        <Empty title="No messages match">The bot has nothing in its outbox with these filters.</Empty>
      ) : (
        <ul className="divide-y divide-black/10 overflow-hidden rounded-xl border border-black/15 bg-white">
          {page.items.map((n) => (
            <NotificationRow key={n.id} n={n} showUser />
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
