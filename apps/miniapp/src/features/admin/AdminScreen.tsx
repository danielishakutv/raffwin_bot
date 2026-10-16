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
  AdminExpense,
  AdminFinance,
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

type Tab = 'overview' | 'raffles' | 'finance' | 'approvals' | 'players' | 'settings' | 'security' | 'audit' | 'admins'
const TABS: { id: Tab; label: string; perm?: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'raffles', label: 'Raffles' },
  { id: 'finance', label: 'Finance', perm: 'finance.read' },
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
        {tab === 'raffles' && <RafflesTab can={me.permissions} superAdmin={me.role === 'super_admin'} />}
        {tab === 'finance' && <FinanceTab can={me.permissions} />}
        {tab === 'approvals' && <ApprovalsTab can={me.permissions} />}
        {tab === 'players' && <PlayersTab can={me.permissions} superAdmin={me.role === 'super_admin'} />}
        {tab === 'settings' && <SettingsTab can={me.permissions} superAdmin={me.role === 'super_admin'} />}
        {tab === 'security' && <SecurityTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'admins' && <AdminsTab />}
      </main>
    </div>
  )
}

/* Overview ------------------------------------------------------------------- */

const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`

function Big({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-2 border-black p-3">
      <p className="text-[12px] font-semibold uppercase tracking-wide">{label}</p>
      <p className="mt-1 text-[32px] font-extrabold leading-none">{value}</p>
      {sub && <p className="mt-1 text-[12px]">{sub}</p>}
    </div>
  )
}

function OverviewTab() {
  const { data: o, error, reload } = useLoad<AdminOverview>('/overview', 10_000)
  if (error) return <Err message={error} />
  if (!o) return <p>Loading...</p>
  const rows: [string, string][] = [
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
      <div className="grid grid-cols-2 gap-2">
        <Big label="Players" value={fmt(o.users.total)} sub={`${fmt(o.users.signedUpToday)} new today · ${fmt(o.users.activeLast7Days)} active in 7 days`} />
        <Big label="Raised (all time)" value={naira(o.raised.naira)} sub={`${fmt(o.raised.raffs)} Raffs at ${naira(o.raised.nairaPerRaff)} per Raff`} />
      </div>
      <table className="mt-3 w-full border-collapse">
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
  p1cost: '',
  p2: '',
  p2raffs: '',
  p2cost: '',
  p3: '',
  p3raffs: '',
  p3cost: '',
}
type RaffleForm = typeof emptyRaffle

/** datetime-local wants "YYYY-MM-DDTHH:mm" in local time */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formFromRaffle(r: AdminRaffle): RaffleForm {
  const p = (pos: number) => r.prizes.find((x) => x.position === pos)
  return {
    prizeName: r.prizeName,
    model: r.model,
    category: r.category,
    kind: r.kind,
    marketPriceNaira: String(r.marketPriceNaira),
    entryPriceRaffs: String(r.entryPriceRaffs),
    entriesTarget: String(r.entriesTarget),
    deadline: toLocalInput(r.deadline),
    description: r.description,
    p1: p(1)?.prizeItem ?? '',
    p1cost: String(p(1)?.costNaira ?? ''),
    p2: p(2)?.prizeItem ?? '',
    p2raffs: p(2)?.prizeType === 'raffs_credit' ? String(p(2)?.raffsValue ?? '') : '',
    p2cost: p(2)?.prizeType === 'physical' ? String(p(2)?.costNaira ?? '') : '',
    p3: p(3)?.prizeItem ?? '',
    p3raffs: p(3)?.prizeType === 'raffs_credit' ? String(p(3)?.raffsValue ?? '') : '',
    p3cost: p(3)?.prizeType === 'physical' ? String(p(3)?.costNaira ?? '') : '',
  }
}

function bodyFromForm(f: RaffleForm, rules: string[]) {
  const prize = (position: 1 | 2 | 3, item: string, raffs: string, cost: string) =>
    raffs
      ? { position, prizeItem: item, prizeType: 'raffs_credit', raffsValue: Number(raffs), costNaira: 0 }
      : { position, prizeItem: item, prizeType: 'physical', raffsValue: 0, costNaira: Number(cost || 0) }
  return {
    prizeName: f.prizeName,
    model: f.model,
    category: f.category,
    kind: f.kind,
    marketPriceNaira: Number(f.marketPriceNaira),
    entryPriceRaffs: Number(f.entryPriceRaffs),
    entriesTarget: Number(f.entriesTarget),
    deadline: new Date(f.deadline).toISOString(),
    description: f.description,
    rules,
    prizes: [prize(1, f.p1, '', f.p1cost), prize(2, f.p2, f.p2raffs, f.p2cost), prize(3, f.p3, f.p3raffs, f.p3cost)],
  }
}

function RafflesTab({ can, superAdmin }: { can: string[]; superAdmin: boolean }) {
  const { data, error, reload } = useLoad<AdminRaffle[]>('/raffles', 15_000)
  const [form, setForm] = useState(emptyRaffle)
  const [editing, setEditing] = useState<AdminRaffle | 'new' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const action = useAction()
  const set = (k: keyof RaffleForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const startNew = () => {
    setForm(emptyRaffle)
    setEditing('new')
    setMsg(null)
  }
  const startEdit = (r: AdminRaffle) => {
    setForm(formFromRaffle(r))
    setEditing(r)
    setMsg(null)
    window.scrollTo({ top: 0 })
  }
  const save = () => {
    const isNew = editing === 'new'
    const rules = isNew ? [] : (editing as AdminRaffle).rules
    const body = bodyFromForm(form, rules)
    void action
      .run(() => (isNew ? adminCall<AdminRaffle>('POST', '/raffles', body) : adminCall<AdminRaffle>('PUT', `/raffles/${(editing as AdminRaffle).id}`, body)))
      .then((r) => {
        if (r) {
          setMsg(isNew ? `Draft saved: ${r.prizeName}. Publish it when ready.` : `Saved: ${r.prizeName}.`)
          setEditing(null)
          setForm(emptyRaffle)
          reload()
        }
      })
  }
  const publish = (id: string) => action.run(() => adminCall('POST', `/raffles/${id}/open`)).then(reload)
  const unpublish = async (id: string) => {
    const reason = await askText('Why unpublish? It goes back to draft, hidden from players.')
    if (reason) void action.run(() => adminCall('POST', `/raffles/${id}/unpublish`, { reason })).then(reload)
  }
  const cancel = async (r: AdminRaffle) => {
    const reason = await askText(
      superAdmin
        ? `Cancel "${r.prizeName}"? Every entry is refunded at once. Why?`
        : 'Why cancel? Every entry is refunded once a second admin approves.',
    )
    if (!reason) return
    const a = await action.run(() => adminCall<AdminApproval>('POST', `/raffles/${r.id}/cancel`, { reason }))
    if (a) setMsg(a.status === 'approved' ? `Cancelled and refunded: ${a.summary}` : `Queued for approval: ${a.summary}`)
    reload()
  }

  const fields: [keyof RaffleForm, string][] = [
    ['prizeName', 'Prize name (the raffle title)'],
    ['model', 'Model'],
    ['category', 'Category'],
    ['marketPriceNaira', 'Market price (Naira, shown to players)'],
    ['entryPriceRaffs', 'Entry price (Raffs)'],
    ['entriesTarget', 'Entries on sale'],
    ['description', 'Description'],
    ['p1', '1st prize'],
    ['p1cost', '1st prize: what it costs you (Naira)'],
    ['p2', '2nd prize'],
    ['p2raffs', '2nd prize Raffs value (fill this for a Raffs prize)'],
    ['p2cost', '2nd prize: cost in Naira (physical prize)'],
    ['p3', '3rd prize'],
    ['p3raffs', '3rd prize Raffs value (fill this for a Raffs prize)'],
    ['p3cost', '3rd prize: cost in Naira (physical prize)'],
  ]
  const canEdit = (r: AdminRaffle) => can.includes('raffles.write') && (r.status === 'draft' || (r.status === 'open' && superAdmin))

  return (
    <>
      <Err message={error ?? action.error} />
      {msg && <p className="my-2 border border-black p-2">{msg}</p>}
      {can.includes('raffles.write') && editing === null && (
        <button type="button" className={btn} onClick={startNew}>
          New raffle (draft)
        </button>
      )}
      {editing !== null && (
        <div className="my-3 grid gap-2 border-2 border-black p-3">
          <p className="font-bold">{editing === 'new' ? 'New raffle' : `Edit: ${editing.prizeName} [${editing.status}]`}</p>
          {editing !== 'new' && editing.status === 'open' && (
            <p className="text-[12px]">
              Open raffle: {editing.entriesCount} entries already sold, so entries on sale cannot go below that. Changing the entry price affects new entries only.
            </p>
          )}
          {fields.map(([k, label]) => (
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
          <div className="flex gap-2">
            <button type="button" className={btnSolid} disabled={action.busy} onClick={save}>
              {editing === 'new' ? 'Save draft' : 'Save changes'}
            </button>
            <button type="button" className={btn} onClick={() => setEditing(null)}>
              Close
            </button>
          </div>
        </div>
      )}
      <H>All raffles</H>
      {!data ? (
        <p>Loading...</p>
      ) : (
        data.map((r) => (
          <div key={r.id} className="mb-2 border border-black/30 p-2">
            <p className="font-bold">
              {r.prizeName} <span className="font-normal">[{r.status === 'draft' ? 'draft (not published)' : r.status}]</span>
            </p>
            <p className="text-[12px]">
              {fmt(r.entryPriceRaffs)} Raffs/entry · {fmt(r.entriesCount)}/{fmt(r.entriesTarget)} sold · {fmt(r.raffsCollected)} Raffs in · draw {when(r.deadline)}
            </p>
            <p className="text-[12px]">
              Prizes:{' '}
              {r.prizes
                .map((p) => `${p.position}. ${p.prizeItem}${p.prizeType === 'physical' && p.costNaira ? ` (cost ${naira(p.costNaira)})` : ''}${p.winnerUsername ? ` @${p.winnerUsername}` : ''}`)
                .join('  ')}
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              {canEdit(r) && (
                <button type="button" className={btn} onClick={() => startEdit(r)}>
                  Edit
                </button>
              )}
              {r.status === 'draft' && can.includes('raffles.write') && (
                <button type="button" className={btnSolid} onClick={() => void publish(r.id)}>
                  Publish
                </button>
              )}
              {r.status === 'open' && r.entriesCount === 0 && can.includes('raffles.write') && (
                <button type="button" className={btn} onClick={() => void unpublish(r.id)}>
                  Unpublish
                </button>
              )}
              {(r.status === 'open' || r.status === 'draft') && can.includes('raffles.cancel.request') && (
                <button type="button" className={btn} onClick={() => void cancel(r)}>
                  {superAdmin ? 'Cancel and refund' : 'Ask to cancel'}
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </>
  )
}

/* Finance (super admin and finance) ------------------------------------------ */

type PeriodKey = 'all' | 'month' | '30d'

function periodQuery(p: PeriodKey): string {
  const now = new Date()
  if (p === 'month') return `?from=${new Date(now.getFullYear(), now.getMonth(), 1).toISOString()}`
  if (p === '30d') return `?from=${new Date(now.getTime() - 30 * 86_400_000).toISOString()}`
  return ''
}

function FinanceTab({ can }: { can: string[] }) {
  const [period, setPeriod] = useState<PeriodKey>('all')
  const q = periodQuery(period)
  const { data: f, error, reload } = useLoad<AdminFinance>(`/finance${q}`, 30_000)
  const { data: expenses, reload: reloadExpenses } = useLoad<AdminExpense[]>(`/finance/expenses${q}`)
  const { data: raffleList } = useLoad<AdminRaffle[]>('/raffles')
  const action = useAction()
  const today = new Date().toISOString().slice(0, 10)
  const [exp, setExp] = useState({ raffleId: '', category: 'delivery', amountNaira: '', spentOn: today, note: '' })

  const addExpense = () =>
    void action
      .run(() =>
        adminCall<AdminExpense>('POST', '/finance/expenses', {
          raffleId: exp.raffleId || null,
          category: exp.category,
          amountNaira: Number(exp.amountNaira),
          spentOn: new Date(`${exp.spentOn}T12:00:00`).toISOString(),
          note: exp.note,
        }),
      )
      .then((r) => {
        if (r) {
          setExp({ raffleId: '', category: 'delivery', amountNaira: '', spentOn: today, note: '' })
          reload()
          reloadExpenses()
        }
      })
  const voidOne = async (id: string) => {
    const reason = await askText('Why void this expense? It stays on record but stops counting.')
    if (reason) void action.run(() => adminCall('POST', `/finance/expenses/${id}/void`, { reason })).then(() => (reload(), reloadExpenses()))
  }

  if (error) return <Err message={error} />
  if (!f) return <p>Loading...</p>
  const t = f.totals
  return (
    <>
      <div className="flex gap-1">
        {(
          [
            ['all', 'All time'],
            ['month', 'This month'],
            ['30d', 'Last 30 days'],
          ] as [PeriodKey, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" className={period === k ? btnSolid : btn} onClick={() => setPeriod(k)}>
            {label}
          </button>
        ))}
      </div>
      <Err message={action.error} />

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Big label="Raised" value={naira(t.raisedNaira)} sub={`${fmt(t.raisedRaffs)} Raffs spent on entries`} />
        <Big label="Profit" value={naira(t.profitNaira)} sub="raised - prizes - referral pay - expenses" />
      </div>

      <H>Summary</H>
      <table className="w-full border-collapse text-[13px]">
        <tbody>
          {(
            [
              ['Raised from entries', naira(t.raisedNaira)],
              ['Cost of prizes (1st, 2nd, 3rd)', `- ${naira(t.prizeCostNaira)}`],
              ['Referral payouts (10%)', `- ${naira(t.referralNaira)}`],
              ['Expenses linked to raffles', `- ${naira(t.raffleExpensesNaira)}`],
              ['General expenses', `- ${naira(t.generalExpensesNaira)}`],
              ['Profit', naira(t.profitNaira)],
              ['', ''],
              ['Money received (Telegram Stars)', `${fmt(f.cash.starsReceived)} Stars = ${naira(f.cash.starsNaira)}`],
              ['Raffs sold for Stars', fmt(f.cash.raffsSold)],
              ['Free Raffs given: bonuses / admin credits', `${fmt(f.freeRaffs.bonus)} / ${fmt(f.freeRaffs.adjustments)}`],
              ['Free Raffs given: Raffs prizes / referral pay', `${fmt(f.freeRaffs.prizes)} / ${fmt(f.freeRaffs.referrals)}`],
              ['Raffs players hold now (owed in entries)', fmt(f.outstandingRaffs)],
            ] as [string, string][]
          ).map(([k, v], i) => (
            <tr key={i} className={k === 'Profit' ? 'border-y-2 border-black font-bold' : 'border-b border-black/10'}>
              <td className="py-1 pr-2">{k}</td>
              <td className="py-1 text-right">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px]">
        Raffs are valued at {naira(f.nairaPerRaff)} each (base Stars per Raff x {naira(f.nairaPerStar)} per Star, from Settings). Raffs prizes count at
        that value; physical prizes at the cost entered on the raffle; prize costs count once a raffle is published. Stars purchases are not
        switched on yet, so money received is 0 until they are.
      </p>

      <H>Per raffle</H>
      {f.raffles.map((r) => (
        <div key={r.id} className="mb-2 border border-black/30 p-2 text-[12px]">
          <p className="text-[13px] font-bold">
            {r.prizeName} [{r.status}] · margin {naira(r.marginNaira)}
          </p>
          <p>
            {fmt(r.entriesSold)}/{fmt(r.entriesTarget)} entries at {fmt(r.entryPriceRaffs)} Raffs · raised {fmt(r.raisedRaffs)} Raffs = {naira(r.raisedNaira)}
            {r.refundedRaffs ? ` (after ${fmt(r.refundedRaffs)} refunded)` : ''}
          </p>
          {r.prizes.map((p) => (
            <p key={p.position}>
              {['1st', '2nd', '3rd'][p.position - 1]}: {p.prizeItem} · {p.prizeType === 'raffs_credit' ? `${fmt(p.raffsValue)} Raffs = ` : 'cost '}
              {naira(p.costNaira)}
            </p>
          ))}
          <p>
            Prizes {naira(r.prizeCostNaira)} · referral pay {naira(r.referralNaira)} ({fmt(r.referralRaffs)} Raffs) · expenses {naira(r.expensesNaira)}
          </p>
        </div>
      ))}

      <H>Expenses</H>
      {can.includes('finance.write') && (
        <div className="mb-3 grid gap-2 border border-black p-3">
          <p className="font-bold">Record an expense</p>
          <label className="grid gap-0.5 text-[12px]">
            For
            <select className={input} value={exp.raffleId} onChange={(e) => setExp({ ...exp, raffleId: e.target.value })}>
              <option value="">General (not one raffle)</option>
              {(raffleList ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.prizeName} [{r.status}]
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-0.5 text-[12px]">
            Category
            <select className={input} value={exp.category} onChange={(e) => setExp({ ...exp, category: e.target.value })}>
              {['prize_purchase', 'delivery', 'marketing', 'fees', 'operations', 'other'].map((c) => (
                <option key={c} value={c}>
                  {c.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-0.5 text-[12px]">
            Amount (Naira)
            <input className={input} inputMode="numeric" value={exp.amountNaira} onChange={(e) => setExp({ ...exp, amountNaira: e.target.value.replace(/[^0-9]/g, '') })} />
          </label>
          <label className="grid gap-0.5 text-[12px]">
            Date
            <input className={input} type="date" value={exp.spentOn} onChange={(e) => setExp({ ...exp, spentOn: e.target.value })} />
          </label>
          <label className="grid gap-0.5 text-[12px]">
            What it was for
            <input className={input} value={exp.note} onChange={(e) => setExp({ ...exp, note: e.target.value })} />
          </label>
          <button type="button" className={btnSolid} disabled={action.busy || !exp.amountNaira || exp.note.trim().length < 3} onClick={addExpense}>
            Add expense
          </button>
        </div>
      )}
      {(expenses ?? []).length === 0 ? (
        <p>No expenses recorded in this period.</p>
      ) : (
        (expenses ?? []).map((e) => (
          <div key={e.id} className={`border-b border-black/10 py-1 text-[12px] ${e.voidedAt ? 'line-through opacity-60' : ''}`}>
            {new Date(e.spentOn).toLocaleDateString('en-NG')} · {naira(e.amountNaira)} · {e.category.replace('_', ' ')} · {e.raffleName ?? 'general'} · {e.note} · by {e.createdBy}
            {e.voidedAt ? ` · voided: ${e.voidReason}` : ''}
            {!e.voidedAt && can.includes('finance.write') && (
              <button type="button" className={`${btn} ml-2 py-0.5`} onClick={() => void voidOne(e.id)}>
                Void
              </button>
            )}
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

function PlayersTab({ can, superAdmin }: { can: string[]; superAdmin: boolean }) {
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
        <PlayerDetail id={selected} can={can} superAdmin={superAdmin} onBack={() => setSelected(null)} />
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

function PlayerDetail({ id, can, superAdmin, onBack }: { id: string; can: string[]; superAdmin: boolean; onBack: () => void }) {
  const { data: d, error, reload } = useLoad<AdminUserDetail>(`/users/${id}`)
  const action = useAction()
  const [done, setDone] = useState<string | null>(null)
  const status = async (to: 'suspend' | 'reinstate') => {
    const reason = await askText(`Why ${to}?`)
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
    const raffs = Number(await askText('Raffs to credit (negative to debit)') ?? '')
    if (!Number.isInteger(raffs) || raffs === 0) return
    const reason = await askText(superAdmin ? 'Why? It happens at once and is recorded.' : 'Why? A second admin approves before it happens.')
    if (reason)
      void action.run(() => adminCall<AdminApproval>('POST', `/users/${id}/adjust`, { raffs, reason })).then((a) => {
        if (!a) return
        setDone(a.status === 'approved' ? `Done: ${a.summary}` : `Queued for approval: ${a.summary}`)
        reload()
      })
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
            {can.includes('users.referrer.assign') && !d.user.referredByUsername && (
              <button type="button" className={btn} onClick={() => void assignReferrer()}>
                Set referred by
              </button>
            )}
            {can.includes('users.adjust.request') && (
              <button type="button" className={btn} onClick={() => void adjust()}>
                {superAdmin ? 'Adjust balance' : 'Ask to adjust balance'}
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

function SettingsTab({ can, superAdmin }: { can: string[]; superAdmin: boolean }) {
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
      <MyPassword />
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
              const reason = await askText(superAdmin ? 'Why change the base? It applies from the next hour.' : 'Why change the base? A second admin approves it.')
              if (reason)
                void action
                  .run(() => adminCall<AdminApproval>('POST', '/settings/rate-base', { starsPerRaff: Number(base), reason }))
                  .then((a) => a && setMsg(a.status === 'approved' ? `Done: ${a.summary} (from the next hour)` : `Queued for approval: ${a.summary}`))
            }}
          >
            {superAdmin ? 'Change base' : 'Ask to change'}
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

function MyPassword() {
  const action = useAction()
  const [form, setForm] = useState({ current: '', next: '', again: '' })
  const [done, setDone] = useState(false)
  const mismatch = form.again !== '' && form.next !== form.again
  return (
    <div className="mb-4 border border-black p-3">
      <p className="font-bold">My password</p>
      <p className="text-[12px]">At least 12 characters. Your other admin sessions end when you change it.</p>
      <Err message={action.error} />
      {done && <p className="my-2 border border-black p-2">Password changed.</p>}
      {(
        [
          ['current', 'Current password'],
          ['next', 'New password'],
          ['again', 'New password again'],
        ] as ['current' | 'next' | 'again', string][]
      ).map(([k, label]) => (
        <label key={k} className="mt-2 grid gap-0.5 text-[12px]">
          {label}
          <input className={input} type="password" autoComplete={k === 'current' ? 'current-password' : 'new-password'} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
        </label>
      ))}
      {mismatch && <p className="mt-1 text-[12px]">The two new passwords differ.</p>}
      <button
        type="button"
        className={`${btnSolid} mt-3`}
        disabled={action.busy || !form.current || form.next.length < 12 || mismatch || form.next !== form.again}
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
      </button>
    </div>
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
