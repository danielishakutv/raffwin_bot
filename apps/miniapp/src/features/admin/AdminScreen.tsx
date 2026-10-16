/**
 * The admin screen, inside the Mini App. Plain black and white on purpose.
 * Reached only through the bot's admin sign-in (adminSession.ts); every
 * request it makes is written to the audit log by the API.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  AdminApproval,
  AdminAuditRow,
  AdminOverview,
  AdminRaffle,
  AdminSecurityEvent,
  AdminSettings,
  AdminUserDetail,
  AdminUserSummary,
} from '@raffwin/shared/admin-types'
import type { Page } from '@raffwin/shared'
import { errorMessage } from '@/api/errors'
import { create } from 'zustand'
import { adminCall, useAdminSession } from './adminSession'

/** An inline text prompt (window.prompt is unreliable inside Telegram's webview). */
const useAsk = create<{ label: string | null; resolve: ((v: string | null) => void) | null }>(() => ({ label: null, resolve: null }))
function askText(label: string): Promise<string | null> {
  return new Promise((resolve) => useAsk.setState({ label, resolve }))
}
function AskPanel() {
  const { label, resolve } = useAsk()
  const [value, setValue] = useState('')
  if (!label || !resolve) return null
  const done = (v: string | null) => {
    useAsk.setState({ label: null, resolve: null })
    setValue('')
    resolve(v && v.trim() ? v.trim() : null)
  }
  return (
    <div className="sticky top-0 z-20 border-b-2 border-black bg-white p-3">
      <p className="text-[13px] font-semibold">{label}</p>
      <input autoFocus className="mt-1 w-full rounded border border-black/40 px-2 py-1.5 text-[14px]" value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="mt-2 flex gap-2">
        <button type="button" className="rounded bg-black px-3 py-1.5 text-[13px] font-semibold text-white" onClick={() => done(value)}>OK</button>
        <button type="button" className="rounded border border-black px-3 py-1.5 text-[13px] font-semibold" onClick={() => done(null)}>Cancel</button>
      </div>
    </div>
  )
}

type Tab = 'overview' | 'raffles' | 'approvals' | 'players' | 'settings' | 'security' | 'audit' | 'admins'
const TABS: { id: Tab; label: string; perm?: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'raffles', label: 'Raffles' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'players', label: 'Players' },
  { id: 'settings', label: 'Settings' },
  { id: 'security', label: 'Security' },
  { id: 'audit', label: 'Audit' },
  { id: 'admins', label: 'Admins', perm: 'admins.manage' },
]

/* Small plain building blocks ------------------------------------------------ */

const btn = 'rounded border border-black px-3 py-1.5 text-[13px] font-semibold active:bg-black active:text-white disabled:opacity-40'
const btnSolid = 'rounded bg-black px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40'
const input = 'w-full rounded border border-black/40 px-2 py-1.5 text-[14px]'

function H({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 mt-4 text-[15px] font-bold">{children}</h2>
}

function Err({ message }: { message: string | null }) {
  return message ? <p className="my-2 border border-black p-2 text-[13px]">Error: {message}</p> : null
}

/** Runs an admin call, keeping loading and error state; errors are shown, never swallowed. */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError(errorMessage(e))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, run }
}

/** Loads a path; with everyMs it also reloads on a timer while the screen is visible, so figures stay live. */
function useLoad<T>(path: string | null, everyMs?: number) {
  const [data, setData] = useState<T | null>(null)
  const { busy, error, run } = useAction()
  const reload = useCallback(() => {
    if (path) void run(() => adminCall<T>('GET', path)).then((d) => d !== undefined && setData(d))
  }, [path, run])
  useEffect(reload, [reload])
  useEffect(() => {
    if (!everyMs) return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload()
    }, everyMs)
    return () => window.clearInterval(id)
  }, [everyMs, reload])
  return { data, busy, error, reload }
}

const fmt = (n: number) => n.toLocaleString('en-NG')
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-NG') : '-')

/* The screen ----------------------------------------------------------------- */

export function AdminScreen() {
  const navigate = useNavigate()
  const { token, me, error } = useAdminSession()
  const [tab, setTab] = useState<Tab>('overview')

  if (!token || !me) {
    return (
      <div className="fixed inset-0 overflow-auto bg-white p-4 font-sans text-black">
        <h1 className="text-[18px] font-bold">Raffle Win admin</h1>
        <p className="mt-2 text-[14px]">Locked. In the bot chat, send the admin command, then the master password, your username and your password. Use the Open admin button the bot sends back.</p>
        <Err message={error} />
        <button type="button" className={`${btn} mt-4`} onClick={() => navigate('/profile')}>
          Back to the app
        </button>
      </div>
    )
  }

  const tabs = TABS.filter((t) => !t.perm || me.permissions.includes(t.perm))
  return (
    <div className="fixed inset-0 overflow-auto bg-white font-sans text-black">
      <AskPanel />
      <header className="sticky top-0 z-10 border-b border-black bg-white p-3">
        <div className="flex items-center justify-between">
          <p className="text-[15px] font-bold">Admin: {me.name} ({me.role})</p>
          <button
            type="button"
            className={btn}
            onClick={() => {
              void adminCall('POST', '/auth/logout').finally(() => {
                useAdminSession.getState().clear()
                navigate('/profile')
              })
            }}
          >
            Lock
          </button>
        </div>
        <nav className="mt-2 flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} className={tab === t.id ? btnSolid : btn}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="p-3 pb-16 text-[14px]">
        {tab === 'overview' && <OverviewTab />}
        {tab === 'raffles' && <RafflesTab can={me.permissions} />}
        {tab === 'approvals' && <ApprovalsTab can={me.permissions} />}
        {tab === 'players' && <PlayersTab can={me.permissions} />}
        {tab === 'settings' && <SettingsTab can={me.permissions} />}
        {tab === 'security' && <SecurityTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'admins' && <AdminsTab />}
      </main>
    </div>
  )
}

/* Overview ------------------------------------------------------------------- */

function OverviewTab() {
  const { data: o, error, reload } = useLoad<AdminOverview>('/overview', 10_000)
  if (error) return <Err message={error} />
  if (!o) return <p>Loading...</p>
  const rows: [string, string][] = [
    ['Players (signed up / total)', `${fmt(o.users.signedUp)} / ${fmt(o.users.total)}`],
    ['New today', fmt(o.users.signedUpToday)],
    ['Entries today', `${fmt(o.entries.today)} (${fmt(o.entries.raffsToday)} Raffs)`],
    ['Open raffles / drafts', `${o.raffles.open} / ${o.raffles.drafts}`],
    ['Raffs owed to players', fmt(o.raffsOutstanding)],
    ['Ledger consistent', o.ledgerConsistent ? 'yes' : 'NO - investigate now'],
    ['Pending approvals', String(o.pendingApprovals)],
    ['Security (24 h) low/med/high/critical', `${o.securityLast24h.low}/${o.securityLast24h.medium}/${o.securityLast24h.high}/${o.securityLast24h.critical}`],
    ['Rate now (Stars per Raff)', `${o.rate.starsPerRaff} (base ${o.rate.baseStarsPerRaff}, ${o.rate.movePct > 0 ? '+' : ''}${o.rate.movePct}%) until ${when(o.rate.expiresAt)}`],
  ]
  return (
    <>
      <table className="w-full border-collapse">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b border-black/20">
              <td className="py-1.5 pr-2">{k}</td>
              <td className="py-1.5 text-right font-semibold">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className={`${btn} mt-3`} onClick={reload}>
        Refresh
      </button>
    </>
  )
}

/* Raffles -------------------------------------------------------------------- */

const emptyRaffle = {
  prizeName: '',
  model: '',
  category: 'Phones',
  kind: 'phone',
  marketPriceNaira: '',
  entryPriceRaffs: '',
  entriesTarget: '',
  deadline: '',
  description: '',
  p1: '',
  p2: '',
  p2raffs: '',
  p3: '',
  p3raffs: '',
}

function RafflesTab({ can }: { can: string[] }) {
  const { data, error, reload } = useLoad<AdminRaffle[]>('/raffles', 15_000)
  const [form, setForm] = useState(emptyRaffle)
  const [creating, setCreating] = useState(false)
  const action = useAction()
  const set = (k: keyof typeof emptyRaffle) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const create = () =>
    action
      .run(() =>
        adminCall<AdminRaffle>('POST', '/raffles', {
          prizeName: form.prizeName,
          model: form.model,
          category: form.category,
          kind: form.kind,
          marketPriceNaira: Number(form.marketPriceNaira),
          entryPriceRaffs: Number(form.entryPriceRaffs),
          entriesTarget: Number(form.entriesTarget),
          deadline: new Date(form.deadline).toISOString(),
          description: form.description,
          rules: [],
          prizes: [
            { position: 1, prizeItem: form.p1, prizeType: 'physical' },
            { position: 2, prizeItem: form.p2, prizeType: form.p2raffs ? 'raffs_credit' : 'physical', raffsValue: Number(form.p2raffs || 0) },
            { position: 3, prizeItem: form.p3, prizeType: form.p3raffs ? 'raffs_credit' : 'physical', raffsValue: Number(form.p3raffs || 0) },
          ],
        }),
      )
      .then((r) => {
        if (r) {
          setForm(emptyRaffle)
          setCreating(false)
          reload()
        }
      })

  const open = (id: string) => action.run(() => adminCall('POST', `/raffles/${id}/open`)).then(reload)
  const cancel = async (id: string) => {
    const reason = await askText('Why cancel? Every entry is refunded once a second admin approves.')
    if (reason) void action.run(() => adminCall('POST', `/raffles/${id}/cancel`, { reason })).then(reload)
  }

  return (
    <>
      <Err message={error ?? action.error} />
      {can.includes('raffles.write') && (
        <button type="button" className={btn} onClick={() => setCreating((c) => !c)}>
          {creating ? 'Close the form' : 'New raffle (draft)'}
        </button>
      )}
      {creating && (
        <div className="my-3 grid gap-2 border border-black p-3">
          {(
            [
              ['prizeName', 'Prize name'],
              ['model', 'Model'],
              ['category', 'Category'],
              ['marketPriceNaira', 'Market price (Naira)'],
              ['entryPriceRaffs', 'Entry price (Raffs, fixed)'],
              ['entriesTarget', 'Entries on sale'],
              ['description', 'Description'],
              ['p1', '1st prize'],
              ['p2', '2nd prize'],
              ['p2raffs', '2nd prize Raffs value (empty = physical)'],
              ['p3', '3rd prize'],
              ['p3raffs', '3rd prize Raffs value (empty = physical)'],
            ] as [keyof typeof emptyRaffle, string][]
          ).map(([k, label]) => (
            <label key={k} className="grid gap-0.5 text-[12px]">
              {label}
              <input className={input} value={form[k]} onChange={set(k)} />
            </label>
          ))}
          <label className="grid gap-0.5 text-[12px]">
            Kind
            <select className={input} value={form.kind} onChange={set('kind')}>
              {['phone', 'laptop', 'tv', 'earbuds', 'powerbank', 'voucher', 'console'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-0.5 text-[12px]">
            Deadline (draw time)
            <input className={input} type="datetime-local" value={form.deadline} onChange={set('deadline')} />
          </label>
          <button type="button" className={btnSolid} disabled={action.busy} onClick={() => void create()}>
            Save draft
          </button>
        </div>
      )}
      <H>All raffles</H>
      {!data ? (
        <p>Loading...</p>
      ) : (
        data.map((r) => (
          <div key={r.id} className="mb-2 border border-black/30 p-2">
            <p className="font-bold">
              {r.prizeName} <span className="font-normal">[{r.status}]</span>
            </p>
            <p className="text-[12px]">
              {fmt(r.entryPriceRaffs)} Raffs/entry · {fmt(r.entriesCount)}/{fmt(r.entriesTarget)} sold · {fmt(r.raffsCollected)} Raffs in · draw {when(r.deadline)}
            </p>
            <p className="text-[12px]">Prizes: {r.prizes.map((p) => `${p.position}. ${p.prizeItem}${p.winnerUsername ? ` (@${p.winnerUsername})` : ''}`).join('  ')}</p>
            <div className="mt-1 flex gap-2">
              {r.status === 'draft' && can.includes('raffles.write') && (
                <button type="button" className={btn} onClick={() => void open(r.id)}>
                  Open for entries
                </button>
              )}
              {(r.status === 'open' || r.status === 'draft') && can.includes('raffles.cancel.request') && (
                <button type="button" className={btn} onClick={() => void cancel(r.id)}>
                  Ask to cancel
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </>
  )
}

/* Approvals ------------------------------------------------------------------ */

function ApprovalsTab({ can }: { can: string[] }) {
  const [status, setStatus] = useState('pending')
  const { data, error, reload } = useLoad<AdminApproval[]>(`/approvals?status=${status}`, 10_000)
  const action = useAction()
  const decide = async (id: string, verdict: 'approve' | 'reject') => {
    const note = await askText(verdict === 'approve' ? 'Note (optional)' : 'Why reject?') ?? ''
    void action.run(() => adminCall('POST', `/approvals/${id}/${verdict}`, { note })).then(reload)
  }
  return (
    <>
      <div className="flex gap-1">
        {['pending', 'approved', 'rejected', 'failed'].map((s) => (
          <button key={s} type="button" className={status === s ? btnSolid : btn} onClick={() => setStatus(s)}>
            {s}
          </button>
        ))}
      </div>
      <Err message={error ?? action.error} />
      <p className="mt-2 text-[12px]">A request can only be decided by a different admin from the one who asked.</p>
      {!data ? (
        <p>Loading...</p>
      ) : data.length === 0 ? (
        <p className="mt-3">Nothing here.</p>
      ) : (
        data.map((a) => (
          <div key={a.id} className="mt-2 border border-black/30 p-2">
            <p className="font-bold">{a.summary}</p>
            <p className="text-[12px]">
              Asked by {a.requestedBy} on {when(a.createdAt)} · reason: {a.reason}
            </p>
            {a.decidedBy && (
              <p className="text-[12px]">
                {a.status} by {a.decidedBy} on {when(a.decidedAt)}
              </p>
            )}
            {a.status === 'pending' && can.includes('approvals.decide') && (
              <div className="mt-1 flex gap-2">
                <button type="button" className={btnSolid} onClick={() => void decide(a.id, 'approve')}>
                  Approve
                </button>
                <button type="button" className={btn} onClick={() => void decide(a.id, 'reject')}>
                  Reject
                </button>
              </div>
            )}
          </div>
        ))
      )}
    </>
  )
}

/* Players -------------------------------------------------------------------- */

function PlayersTab({ can }: { can: string[] }) {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const { data, error } = useLoad<AdminUserSummary[]>(`/users?q=${encodeURIComponent(query)}`)
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <>
      <div className="flex gap-2">
        <input className={input} placeholder="Username, name, phone or Telegram id" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className={btnSolid} onClick={() => setQuery(q)}>
          Search
        </button>
      </div>
      <Err message={error} />
      {selected ? (
        <PlayerDetail id={selected} can={can} onBack={() => setSelected(null)} />
      ) : (
        (data ?? []).map((u) => (
          <button key={u.id} type="button" onClick={() => setSelected(u.id)} className="mt-2 block w-full border border-black/30 p-2 text-left">
            <span className="font-bold">@{u.username ?? '-'}</span> {u.fullName} · {u.status} · {fmt(u.balance)} Raffs
            <span className="block text-[12px]">Telegram {u.telegramId} · {u.phone ?? 'no phone'} · last seen {when(u.lastSeenAt)}</span>
          </button>
        ))
      )}
    </>
  )
}

function PlayerDetail({ id, can, onBack }: { id: string; can: string[]; onBack: () => void }) {
  const { data: d, error, reload } = useLoad<AdminUserDetail>(`/users/${id}`)
  const action = useAction()
  const [done, setDone] = useState<string | null>(null)
  const status = async (to: 'suspend' | 'reinstate') => {
    const reason = await askText(`Why ${to}?`)
    if (reason) void action.run(() => adminCall('POST', `/users/${id}/${to}`, { reason })).then(reload)
  }
  const adjust = async () => {
    const raffs = Number(await askText('Raffs to credit (negative to debit)') ?? '')
    if (!Number.isInteger(raffs) || raffs === 0) return
    const reason = await askText('Why? A second admin approves before it happens.')
    if (reason)
      void action.run(() => adminCall<AdminApproval>('POST', `/users/${id}/adjust`, { raffs, reason })).then((a) => a && setDone(`Queued for approval: ${a.summary}`))
  }
  return (
    <div className="mt-3">
      <button type="button" className={btn} onClick={onBack}>
        Back to results
      </button>
      <Err message={error ?? action.error} />
      {done && <p className="my-2 border border-black p-2">{done}</p>}
      {!d ? (
        <p>Loading...</p>
      ) : (
        <>
          <H>
            @{d.user.username} ({d.user.status})
          </H>
          <p>
            {d.user.fullName} · Telegram {d.user.telegramId} · {d.user.phone ?? 'no phone'} · referred by {d.user.referredByUsername ?? 'nobody'}
          </p>
          <p>
            Balance {fmt(d.user.balance)} Raffs (ledger says {fmt(d.ledgerBalance)}
            {d.ledgerBalance !== d.user.balance ? ' - MISMATCH' : ''}) · referred {d.referrals.people}, earned {fmt(d.referrals.raffsEarned)}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {can.includes('users.suspend') &&
              (d.user.status === 'active' ? (
                <button type="button" className={btn} onClick={() => void status('suspend')}>
                  Suspend
                </button>
              ) : (
                <button type="button" className={btn} onClick={() => void status('reinstate')}>
                  Reinstate
                </button>
              ))}
            {can.includes('users.adjust.request') && (
              <button type="button" className={btn} onClick={() => void adjust()}>
                Ask to adjust balance
              </button>
            )}
          </div>
          <H>Ledger (latest 100)</H>
          {d.ledger.map((l) => (
            <p key={l.id} className="border-b border-black/10 py-1 text-[12px]">
              {when(l.createdAt)} · {l.type} · {l.raffs > 0 ? '+' : ''}
              {fmt(l.raffs)} → {fmt(l.balanceAfter)} · {l.note}
            </p>
          ))}
          <H>Entries</H>
          {d.entries.map((e) => (
            <p key={e.id} className="border-b border-black/10 py-1 text-[12px]">
              {when(e.createdAt)} · {e.raffleName} · x{e.qty} · tickets {e.ticketFrom}-{e.ticketTo} · {fmt(e.raffsSpent)} Raffs
            </p>
          ))}
        </>
      )}
    </div>
  )
}

/* Settings ------------------------------------------------------------------- */

function SettingsTab({ can }: { can: string[] }) {
  const { data: s, error, reload } = useLoad<AdminSettings>('/settings')
  const action = useAction()
  const [base, setBase] = useState('')
  const [limits, setLimits] = useState<{ cap: string; daily: string; nps: string } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    if (s) setLimits({ cap: s.maxEntriesPerUserPerRaffle?.toString() ?? '', daily: s.dailySpendRaffs?.toString() ?? '', nps: String(s.nairaPerStar) })
  }, [s])
  if (error) return <Err message={error} />
  if (!s || !limits) return <p>Loading...</p>
  return (
    <>
      <Err message={action.error} />
      {msg && <p className="my-2 border border-black p-2">{msg}</p>}
      <H>Rate</H>
      <p>Base: {s.baseStarsPerRaff} Stars per Raff. Each hour moves 3% to 15% up or down from the base.</p>
      {can.includes('settings.rate.request') && (
        <div className="mt-2 flex gap-2">
          <input className={input} placeholder="New base, e.g. 0.5" value={base} onChange={(e) => setBase(e.target.value)} />
          <button
            type="button"
            className={btn}
            onClick={async () => {
              const reason = await askText('Why change the base? A second admin approves it.')
              if (reason)
                void action
                  .run(() => adminCall<AdminApproval>('POST', '/settings/rate-base', { starsPerRaff: Number(base), reason }))
                  .then((a) => a && setMsg(`Queued for approval: ${a.summary}`))
            }}
          >
            Ask to change
          </button>
        </div>
      )}
      <H>Limits and display</H>
      {(
        [
          ['cap', 'Most entries per player per raffle (empty = no cap)'],
          ['daily', 'Most Raffs per player per day on entries (empty = no cap)'],
          ['nps', 'Naira shown per Star (display only)'],
        ] as ['cap' | 'daily' | 'nps', string][]
      ).map(([k, label]) => (
        <label key={k} className="mt-2 grid gap-0.5 text-[12px]">
          {label}
          <input className={input} value={limits[k]} disabled={!can.includes('settings.limits.write')} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
        </label>
      ))}
      {can.includes('settings.limits.write') && (
        <button
          type="button"
          className={`${btnSolid} mt-3`}
          onClick={() =>
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
                  setMsg('Saved')
                  reload()
                }
              })
          }
        >
          Save limits
        </button>
      )}
    </>
  )
}

/* Security and audit --------------------------------------------------------- */

function usePaged<T>(path: string) {
  const [items, setItems] = useState<T[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const action = useAction()
  const load = useCallback(
    (after?: string) =>
      void action
        .run(() => adminCall<Page<T>>('GET', `${path}${path.includes('?') ? '&' : '?'}limit=50${after ? `&cursor=${encodeURIComponent(after)}` : ''}`))
        .then((p) => {
          if (!p) return
          setItems((cur) => (after ? [...cur, ...p.items] : p.items))
          setCursor(p.nextCursor)
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- action.run is stable
    [path],
  )
  useEffect(() => load(), [load])
  return { items, cursor, more: () => cursor && load(cursor), error: action.error, busy: action.busy }
}

function SecurityTab() {
  const [severity, setSeverity] = useState('')
  const page = usePaged<AdminSecurityEvent>(`/security-events${severity ? `?severity=${severity}` : ''}`)
  return (
    <>
      <div className="flex flex-wrap gap-1">
        {['', 'critical', 'high', 'medium', 'low'].map((s) => (
          <button key={s || 'all'} type="button" className={severity === s ? btnSolid : btn} onClick={() => setSeverity(s)}>
            {s || 'all'}
          </button>
        ))}
      </div>
      <Err message={page.error} />
      {page.items.map((e) => (
        <p key={e.id} className="border-b border-black/10 py-1 text-[12px]">
          <b>{e.severity}</b> {when(e.occurredAt)} · {e.kind} · {e.route ?? ''} · {e.actionTaken}
          {e.details && Object.keys(e.details as object).length ? ` · ${JSON.stringify(e.details)}` : ''}
        </p>
      ))}
      {page.cursor && (
        <button type="button" className={`${btn} mt-2`} disabled={page.busy} onClick={page.more}>
          Older
        </button>
      )}
    </>
  )
}

function AuditTab() {
  const page = usePaged<AdminAuditRow>('/audit-log')
  const action = useAction()
  const [check, setCheck] = useState<string | null>(null)
  return (
    <>
      <button
        type="button"
        className={btn}
        onClick={() =>
          void action
            .run(() => adminCall<{ ok: boolean; rows: number; brokenAt: number | null }>('GET', '/audit-log/verify'))
            .then((r) => r && setCheck(r.ok ? `Chain intact: ${fmt(r.rows)} entries.` : `CHAIN BROKEN at entry ${r.brokenAt}. Escalate now.`))
        }
      >
        Verify the hash chain
      </button>
      {check && <p className="my-2 border border-black p-2 font-semibold">{check}</p>}
      <Err message={page.error ?? action.error} />
      {page.items.map((a) => (
        <p key={a.seq} className="border-b border-black/10 py-1 text-[12px]">
          #{a.seq} {when(a.createdAt)} · {a.admin ?? 'system'} · {a.action} · {a.targetType ?? ''} {a.targetId ?? ''}
        </p>
      ))}
      {page.cursor && (
        <button type="button" className={`${btn} mt-2`} disabled={page.busy} onClick={page.more}>
          Older
        </button>
      )}
    </>
  )
}

/* Admins (super admin) ------------------------------------------------------- */

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

function AdminsTab() {
  const { data, error, reload } = useLoad<AdminAccount[]>('/admins')
  const action = useAction()
  const [form, setForm] = useState({ name: '', username: '', telegramUsername: '', role: 'viewer' })
  const [secret, setSecret] = useState<string | null>(null)
  const show = (who: string, password: string) =>
    setSecret(`Password for ${who}: ${password}\nShown once. Give it to them in person or a trusted channel; it cannot be shown again.`)
  return (
    <>
      <Err message={error ?? action.error} />
      {secret && <pre className="my-2 whitespace-pre-wrap border-2 border-black p-2 font-mono text-[13px]">{secret}</pre>}
      <H>Add an admin</H>
      <div className="grid gap-2">
        {(
          [
            ['name', 'Full name'],
            ['username', 'Admin username'],
            ['telegramUsername', 'Their Telegram username (bound on first sign-in)'],
          ] as [keyof typeof form, string][]
        ).map(([k, label]) => (
          <label key={k} className="grid gap-0.5 text-[12px]">
            {label}
            <input className={input} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </label>
        ))}
        <label className="grid gap-0.5 text-[12px]">
          Role
          <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {['viewer', 'support', 'raffle_manager', 'finance', 'super_admin'].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={btnSolid}
          disabled={action.busy}
          onClick={() =>
            void action.run(() => adminCall<{ admin: AdminAccount; password: string }>('POST', '/admins', form)).then((r) => {
              if (r) {
                show(r.admin.name, r.password)
                setForm({ name: '', username: '', telegramUsername: '', role: 'viewer' })
                reload()
              }
            })
          }
        >
          Add admin
        </button>
      </div>
      <H>Admins</H>
      {(data ?? []).map((a) => (
        <div key={a.id} className="mb-2 border border-black/30 p-2">
          <p className="font-bold">
            {a.name} · {a.role} · {a.status}
          </p>
          <p className="text-[12px]">
            username {a.username ?? '-'} · Telegram @{a.telegramUsername ?? '-'} {a.telegramBound ? '(bound)' : '(not signed in yet)'} · last sign-in {when(a.lastLoginAt)}
          </p>
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              className={btn}
              onClick={() => void action.run(() => adminCall<{ password: string }>('POST', `/admins/${a.id}/reset-password`)).then((r) => r && show(a.name, r.password))}
            >
              Reset password
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => void action.run(() => adminCall('POST', `/admins/${a.id}/${a.status === 'active' ? 'disable' : 'enable'}`)).then(reload)}
            >
              {a.status === 'active' ? 'Disable' : 'Enable'}
            </button>
          </div>
        </div>
      ))}
    </>
  )
}
