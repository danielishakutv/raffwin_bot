import { useState } from 'react'
import { ArrowLeft, Check as CheckIcon, ChevronRight, Search } from 'lucide-react'
import type { AdminApproval, AdminUserDetail, AdminUserSummary } from '@raffwin/shared/admin-types'
import { adminCall } from '../adminSession'
import { fmt, useAction, useLoad, when } from '../hooks'
import { askText } from '../ask'
import { PhoneLink } from '../PhoneLink'
import { Badge, Button, Card, Empty, Err, KeyValues, Loading, Notice, Segmented, TabHeading, TextInput } from '../ui'
import { BulkAdjust } from './BulkAdjust'
import { MakeAdmin, PlayerBotMessages, PlayerDelivery, PlayerEngagement, PlayerFeatures } from './PlayerCards'

type Filter = '' | 'no_phone' | 'blocked' | 'inactive'
const FILTERS: { value: Filter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'no_phone', label: 'No phone' },
  { value: 'blocked', label: 'Blocked bot' },
  { value: 'inactive', label: 'Inactive 2d+' },
]

export function PlayersTab({ can, superAdmin }: { can: string[]; superAdmin: boolean }) {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('')
  const { data, error, busy } = useLoad<AdminUserSummary[]>(`/users?q=${encodeURIComponent(query)}${filter ? `&filter=${filter}` : ''}`, 15_000)
  const [selected, setSelected] = useState<string | null>(null)
  const canBulk = can.includes('users.adjust.request')
  // Picking players for a bulk adjustment: the picks survive new searches and filters
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Map<string, AdminUserSummary>>(new Map())
  const [reviewing, setReviewing] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const toggle = (u: AdminUserSummary) =>
    setPicked((m) => {
      const next = new Map(m)
      if (next.has(u.id)) next.delete(u.id)
      else next.set(u.id, u)
      return next
    })
  const remove = (ids: string[]) =>
    setPicked((m) => {
      const next = new Map(m)
      for (const id of ids) next.delete(id)
      return next
    })
  const allShownPicked = !!data?.length && data.every((u) => picked.has(u.id))

  if (selected) return <PlayerDetail id={selected} can={can} superAdmin={superAdmin} onBack={() => setSelected(null)} />
  if (reviewing)
    return (
      <BulkAdjust
        picked={[...picked.values()]}
        superAdmin={superAdmin}
        onRemove={remove}
        onBack={() => setReviewing(false)}
        onDone={(message) => {
          setDone(message)
          setPicked(new Map())
          setPicking(false)
          setReviewing(false)
        }}
      />
    )

  return (
    <>
      <TabHeading
        title="Players"
        sub="Search by username, name, phone or Telegram id."
        aside={
          canBulk && (
            <Button
              size="sm"
              variant={picking ? 'solid' : 'outline'}
              onClick={() => {
                if (picking) setPicked(new Map())
                setPicking(!picking)
              }}
            >
              {picking ? 'Stop selecting' : 'Select for bulk adjust'}
            </Button>
          )
        }
      />
      {done && (
        <Notice tone="success" className="mb-3" onClose={() => setDone(null)}>
          {done}
        </Notice>
      )}
      <Segmented<Filter> className="mb-3" size="sm" value={filter} onChange={setFilter} options={FILTERS} />
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setQuery(q.trim())
        }}
      >
        <label className="relative min-w-0 flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <TextInput className="pl-9" placeholder="e.g. ada_obi or 0803..." value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <Button type="submit" variant="solid" busy={busy}>
          Search
        </Button>
      </form>
      <Err message={error} />
      {picking && data && data.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-neutral-600">
          <span>Tap players to select them. Search again to add more; your picks stay.</span>
          <Button
            size="sm"
            className="ml-auto"
            onClick={() =>
              setPicked((m) => {
                const next = new Map(m)
                for (const u of data) {
                  if (allShownPicked) next.delete(u.id)
                  else next.set(u.id, u)
                }
                return next
              })
            }
          >
            {allShownPicked ? `Unselect these ${data.length}` : `Select all ${data.length} shown`}
          </Button>
        </div>
      )}
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title="No players found">{filter ? 'Nobody matches this filter and search.' : undefined}</Empty>
      ) : (
        <ul className="grid gap-2 lg:grid-cols-2">
          {data.map((u) => {
            const on = picked.has(u.id)
            return (
              <li
                key={u.id}
                className={`admin-in min-w-0 rounded-xl border bg-white transition-[box-shadow,border-color] duration-200 hover:border-black/40 hover:shadow-[0_6px_20px_-12px_rgba(0,0,0,0.35)] ${on ? 'border-black ring-1 ring-black' : 'border-black/15'}`}
              >
                <button
                  type="button"
                  aria-pressed={picking ? on : undefined}
                  onClick={() => (picking ? toggle(u) : setSelected(u.id))}
                  className="flex w-full min-w-0 items-center gap-3 p-3.5 pb-2 text-left"
                >
                  {picking ? (
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 ${on ? 'border-black bg-black text-white' : 'border-black/25 bg-white'}`}>
                      {on && <CheckIcon size={18} strokeWidth={3} />}
                    </span>
                  ) : (
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[14px] font-bold uppercase">
                      {(u.username ?? u.fullName ?? '?').slice(0, 1)}
                    </span>
                  )}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-bold">@{u.username ?? '-'}</span>
                    {u.status !== 'active' && <Badge tone="solid">{u.status}</Badge>}
                    {u.botBlocked && <Badge tone="dashed">blocked bot</Badge>}
                    <span className="ml-auto text-[12.5px] font-semibold">{fmt(u.balance)} Raffs</span>
                  </span>
                  <span className="block truncate text-[12.5px] text-neutral-600">{u.fullName ?? 'No name yet'}</span>
                  <span className="block truncate text-[11.5px] text-neutral-500">
                    Telegram {u.telegramId} · seen {when(u.lastSeenAt)}
                  </span>
                </span>
                  {!picking && <ChevronRight size={16} className="shrink-0 text-neutral-400" />}
                </button>
                {/* Outside the button: the number is a call link with its own copy button */}
                <div className="px-3.5 pb-3 pl-[66px]">
                  <PhoneLink phone={u.phone} verified={u.phoneVerified} size="sm" />
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {picking && picked.size > 0 && (
        <div className="admin-in sticky bottom-3 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-xl border-2 border-black bg-white p-3 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.45)]">
          <span className="text-[13px] font-bold">{fmt(picked.size)} selected</span>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Map())}>
            Clear
          </Button>
          <Button size="sm" variant="solid" className="ml-auto" onClick={() => setReviewing(true)}>
            Adjust balances
          </Button>
        </div>
      )}
    </>
  )
}

function PlayerDetail({ id, can, superAdmin, onBack }: { id: string; can: string[]; superAdmin: boolean; onBack: () => void }) {
  const { data: d, error, reload } = useLoad<AdminUserDetail>(`/users/${id}`, 10_000)
  const action = useAction()
  const [done, setDone] = useState<string | null>(null)
  const status = async (to: 'suspend' | 'reinstate') => {
    const reason = await askText(`Why ${to}?`, { confirm: to === 'suspend' ? 'Suspend' : 'Reinstate', danger: to === 'suspend' })
    if (reason) void action.run(() => adminCall('POST', `/users/${id}/${to}`, { reason })).then(reload)
  }
  const assignReferrer = async () => {
    const referrer = await askText('Referred by which player? Their username (e.g. @ada_obi) or Telegram id.')
    if (!referrer) return
    const reason = await askText('Why? (recorded in the audit log)')
    if (!reason) return
    const updated = await action.run(() => adminCall<AdminUserDetail>('POST', `/users/${id}/referrer`, { referrer, reason }))
    if (updated) {
      setDone(`Now referred by @${updated.user.referredByUsername}. They earn 10% on this player's entries from now on.`)
      reload()
    }
  }
  const adjust = async () => {
    const raffs = Number((await askText('Raffs to credit (negative to debit)', { placeholder: 'e.g. 500 or -200' })) ?? '')
    if (!Number.isInteger(raffs) || raffs === 0) return
    const told = raffs > 0 ? ' The player gets a bot message when the Raffs land.' : ''
    const reason = await askText(superAdmin ? `Why? It happens at once and is recorded.${told}` : `Why? A second admin approves before it happens.${told}`)
    if (reason)
      void action.run(() => adminCall<AdminApproval>('POST', `/users/${id}/adjust`, { raffs, reason })).then((a) => {
        if (!a) return
        setDone(a.status === 'approved' ? `Done: ${a.summary}` : `Queued for approval: ${a.summary}`)
        reload()
      })
  }
  return (
    <div className="admin-in grid gap-4">
      <div>
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={15} />} onClick={onBack}>
          Players
        </Button>
      </div>
      <Err message={error ?? action.error} />
      {done && (
        <Notice tone="success" onClose={() => setDone(null)}>
          {done}
        </Notice>
      )}
      {!d ? (
        <Loading />
      ) : (
        <>
          <Card
            title={
              <span className="flex flex-wrap items-center gap-2">
                @{d.user.username ?? '-'} <Badge tone={d.user.status === 'active' ? 'outline' : 'solid'}>{d.user.status}</Badge>
              </span>
            }
            subtitle={d.user.fullName ?? 'No name yet'}
            actions={
              <>
                {can.includes('users.suspend') &&
                  (d.user.status === 'active' ? (
                    <Button size="sm" onClick={() => void status('suspend')}>
                      Suspend
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => void status('reinstate')}>
                      Reinstate
                    </Button>
                  ))}
                {can.includes('users.referrer.assign') && !d.user.referredByUsername && (
                  <Button size="sm" onClick={() => void assignReferrer()}>
                    Set referred by
                  </Button>
                )}
                {can.includes('users.adjust.request') && (
                  <Button size="sm" variant="solid" onClick={() => void adjust()}>
                    {superAdmin ? 'Adjust balance' : 'Ask to adjust'}
                  </Button>
                )}
              </>
            }
          >
            <KeyValues
              rows={[
                ['Balance', `${fmt(d.user.balance)} Raffs`, 'strong'],
                ['Ledger says', d.ledgerBalance !== d.user.balance ? <Badge tone="solid">{fmt(d.ledgerBalance)} · MISMATCH</Badge> : fmt(d.ledgerBalance)],
                ['Phone', <PhoneLink key="phone" phone={d.user.phone} verified={d.user.phoneVerified} size="lg" className="justify-end" />, 'strong'],
                ['Telegram id', String(d.user.telegramId)],
                ['Bot can message', d.user.botBlocked ? <Badge tone="solid">no · blocked the bot</Badge> : 'yes'],
                ['Referred by', d.user.referredByUsername ? `@${d.user.referredByUsername}` : 'nobody'],
                ['Referred', `${d.referrals.people} people, earned ${fmt(d.referrals.raffsEarned)} Raffs`],
                ['Admin', d.admin ? `${d.admin.name} · ${d.admin.role.replace('_', ' ')}${d.admin.status === 'disabled' ? ' (disabled)' : ''}` : 'no'],
              ]}
            />
          </Card>

          {can.includes('admins.manage') && !d.admin && <MakeAdmin d={d} onMade={reload} />}

          <div className="grid gap-4 xl:grid-cols-2">
            <PlayerEngagement d={d} />
            <PlayerDelivery d={d} />
            <PlayerFeatures d={d} canManage={can.includes('features.manage')} onChanged={reload} />
            <PlayerBotMessages d={d} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Ledger" subtitle="Latest 100" bodyClassName="p-0">
              {d.ledger.length === 0 ? (
                <p className="p-4 text-[13px] text-neutral-600">Nothing yet.</p>
              ) : (
                <ul className="divide-y divide-black/10">
                  {d.ledger.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-[12.5px]">
                      <span className="font-semibold">{l.type}</span>
                      <span className="ml-auto font-bold tabular-nums">
                        {l.raffs > 0 ? '+' : ''}
                        {fmt(l.raffs)} → {fmt(l.balanceAfter)}
                      </span>
                      <span className="w-full break-words text-neutral-500">
                        {when(l.createdAt)}
                        {l.note ? ` · ${l.note}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Entries" bodyClassName="p-0">
              {d.entries.length === 0 ? (
                <p className="p-4 text-[13px] text-neutral-600">No entries yet.</p>
              ) : (
                <ul className="divide-y divide-black/10">
                  {d.entries.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-[12.5px]">
                      <span className="min-w-0 font-semibold">{e.raffleName}</span>
                      <span className="ml-auto font-bold">x{e.qty}</span>
                      <span className="w-full text-neutral-500">
                        {when(e.createdAt)} · tickets {e.ticketFrom}-{e.ticketTo} · {fmt(e.raffsSpent)} Raffs
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
