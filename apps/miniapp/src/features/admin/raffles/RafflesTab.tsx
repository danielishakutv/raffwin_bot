/**
 * Raffle management: a filterable list of every raffle, and the editor.
 * Drafts are invisible to players until published; publishing, unpublishing
 * and cancelling all happen from the list. "Run again" copies any raffle,
 * whatever its status, into a new draft and opens it in the editor; the
 * original is never changed. Delete takes a raffle off this list and the app
 * (refunding an open one first) and keeps everything behind it: it moves to
 * the Deleted filter, where it can be restored.
 */
import { useMemo, useState } from 'react'
import { ArchiveRestore, CalendarClock, Copy, Pencil, Plus, Repeat, Search, Send, Trash2, Undo2, XCircle } from 'lucide-react'
import type { AdminApproval, AdminRaffle } from '@raffwin/shared/admin-types'
import { prizeLabel } from '@raffwin/shared'
import { PrizeVisual } from '@/components/ui/PrizeVisual'
import { adminCall } from '../adminSession'
import { fmt, naira, relative, useAction, useLoad, when } from '../hooks'
import { askConfirm, askText } from '../ask'
import { Bar, Button, Empty, Err, Loading, Notice, Segmented, TextInput } from '../ui'
import type { PrizeKind } from './draft'
import { RaffleEditor } from './RaffleEditor'
import { StatusBadge } from './StatusBadge'

type Filter = 'all' | AdminRaffle['status'] | 'deleted'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'open', label: 'Live' },
  { value: 'drawing', label: 'Drawing' },
  { value: 'drawn', label: 'Drawn' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'deleted', label: 'Deleted' },
]

/** What deleting this raffle does, in the words of the confirmation */
function deleteQuestion(r: AdminRaffle, superAdmin: boolean): { label: string; confirm: string } {
  const n = r.entriesCount
  if (r.status === 'draft') return { label: `Delete the draft "${r.prizeName}"? Players never saw it. Why?`, confirm: 'Delete draft' }
  const after = superAdmin ? '' : ' A second admin has to approve it.'
  const confirm = superAdmin ? 'Delete' : 'Ask to delete'
  if (r.status === 'open' && n > 0) {
    return {
      label: `Delete "${r.prizeName}"? It is cancelled first: ${n === 1 ? 'the 1 entry is' : `all ${fmt(n)} entries are`} refunded in full and the bot tells every entrant. Their history keeps it.${after} Why?`,
      confirm: superAdmin ? 'Refund and delete' : 'Ask to refund and delete',
    }
  }
  if (r.status === 'open') return { label: `Delete "${r.prizeName}"? Nobody has entered; it leaves the app at once.${after} Why?`, confirm }
  if (r.status === 'drawn') {
    return { label: `Delete "${r.prizeName}"? It leaves this list and the app's raffles; the winners and everyone who entered keep it in their history.${after} Why?`, confirm }
  }
  return { label: `Delete "${r.prizeName}"? Its entries were already refunded; players keep the refund in their history.${after} Why?`, confirm }
}

/** Past its deadline an open raffle belongs to the draw; delete it once drawn or refunded */
function deletable(r: AdminRaffle): boolean {
  if (r.status === 'drawing') return false
  return r.status !== 'open' || Date.parse(r.deadline) > Date.now()
}

export function RafflesTab({ can, superAdmin, onScrollTop }: { can: string[]; superAdmin: boolean; onScrollTop: () => void }) {
  const { data, error, reload } = useLoad<AdminRaffle[]>('/raffles', 5_000)
  const deleted = useLoad<AdminRaffle[]>('/raffles?status=deleted')
  const [editing, setEditing] = useState<AdminRaffle | 'new' | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const action = useAction()
  const write = can.includes('raffles.write')

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.length ?? 0, deleted: deleted.data?.length ?? 0 }
    for (const r of data ?? []) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [data, deleted.data])
  const list = filter === 'deleted' ? deleted.data : data
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (list ?? []).filter(
      (r) =>
        (filter === 'all' || filter === 'deleted' || r.status === filter) &&
        (!needle || `${r.prizeName} ${r.model} ${r.category} ${r.prizes.map((p) => p.prizeItem).join(' ')}`.toLowerCase().includes(needle)),
    )
  }, [list, filter, q])
  const reloadBoth = () => {
    reload()
    deleted.reload()
  }

  const open = (r: AdminRaffle | 'new') => {
    setEditing(r)
    setMsg(null)
    onScrollTop()
  }

  if (editing !== null) {
    return (
      <RaffleEditor
        raffle={editing === 'new' ? null : editing}
        superAdmin={superAdmin}
        onClose={() => {
          setEditing(null)
          onScrollTop()
        }}
        onSaved={(r, wasNew) => {
          setEditing(null)
          setMsg(wasNew ? `Draft saved: ${r.prizeName}. Players cannot see it until you publish it.` : `Saved: ${r.prizeName}.`)
          if (wasNew) setFilter('all')
          reload()
          onScrollTop()
        }}
      />
    )
  }

  const publish = async (r: AdminRaffle) => {
    if (!(await askConfirm(`Publish "${r.prizeName}"? Players see it at once and can start entering.`, 'Publish'))) return
    const done = await action.run(() => adminCall<AdminRaffle>('POST', `/raffles/${r.id}/open`))
    if (done) setMsg(`Published: ${done.prizeName} is live.`)
    reload()
  }
  const unpublish = async (r: AdminRaffle) => {
    const reason = await askText('Why unpublish? It goes back to draft, hidden from players.', { confirm: 'Unpublish' })
    if (!reason) return
    const done = await action.run(() => adminCall<AdminRaffle>('POST', `/raffles/${r.id}/unpublish`, { reason }))
    if (done) setMsg(`Unpublished: ${done.prizeName} is a draft again.`)
    reload()
  }
  const runAgain = async (r: AdminRaffle) => {
    const ok = await askConfirm(
      `Run "${r.prizeName}" again? A new draft is made with the same prize, photo, prices, prizes and rules, and opened for you to edit. The original stays exactly as it is.`,
      'Make the new draft',
    )
    if (!ok) return
    const copy = await action.run(() => adminCall<AdminRaffle>('POST', `/raffles/${r.id}/copy`))
    if (!copy) return
    reload()
    // Straight into the editor: check the deadline and anything else, save, then publish from the list
    open(copy)
  }
  const cancel = async (r: AdminRaffle) => {
    const reason = await askText(
      superAdmin ? `Cancel "${r.prizeName}"? Every entry is refunded at once. Why?` : 'Why cancel? Every entry is refunded once a second admin approves.',
      { confirm: superAdmin ? 'Cancel and refund' : 'Ask to cancel', danger: true },
    )
    if (!reason) return
    const a = await action.run(() => adminCall<AdminApproval>('POST', `/raffles/${r.id}/cancel`, { reason }))
    if (a) setMsg(a.status === 'approved' ? `Cancelled and refunded: ${a.summary}` : `Queued for approval: ${a.summary}`)
    reload()
  }
  const remove = async (r: AdminRaffle) => {
    const { label, confirm } = deleteQuestion(r, superAdmin)
    const reason = await askText(label, { confirm, danger: true })
    if (!reason) return
    // A draft goes at once (the raffle comes back); anything else is an approval, done or queued
    const done = await action.run(() => adminCall<AdminRaffle | AdminApproval>('POST', `/raffles/${r.id}/delete`, { reason }))
    if (done) {
      if (!('summary' in done)) setMsg(`Deleted: ${done.prizeName}. It is under Deleted if you need it back.`)
      else setMsg(done.status === 'approved' ? `Done: ${done.summary}. It is under Deleted if you need it back.` : `Queued for approval: ${done.summary}`)
    }
    reloadBoth()
  }
  const restore = async (r: AdminRaffle) => {
    const effect = r.status === 'drawn' ? ', and its winners show in the app again' : r.status === 'cancelled' ? '; nobody is charged again' : ''
    const reason = await askText(`Restore "${r.prizeName}"? It comes back to the list as ${r.status}${effect}. Why?`, { confirm: 'Restore' })
    if (!reason) return
    const done = await action.run(() => adminCall<AdminRaffle>('POST', `/raffles/${r.id}/restore`, { reason }))
    if (done) setMsg(`Restored: ${done.prizeName}.`)
    reloadBoth()
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[20px] font-extrabold tracking-tight">Raffles</h2>
          <p className="text-[12.5px] text-neutral-600">Create drafts, preview them as players will, then publish.</p>
        </div>
        {write && (
          <Button variant="solid" icon={<Plus size={16} />} onClick={() => open('new')}>
            New raffle
          </Button>
        )}
      </div>

      {msg && (
        <Notice tone="success" onClose={() => setMsg(null)}>
          {msg}
        </Notice>
      )}
      <Err message={error ?? deleted.error ?? action.error} />

      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Filter>
          className="min-w-0 max-w-full"
          value={filter}
          onChange={setFilter}
          options={FILTERS.filter((f) => f.value === 'all' || counts[f.value]).map((f) => ({ ...f, count: counts[f.value] ?? 0 }))}
        />
        <label className="relative ml-auto w-full sm:w-64">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <TextInput className="pl-9" placeholder="Search raffles and prizes" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      {!list ? (
        <Loading rows={4} />
      ) : filter === 'deleted' && list.length === 0 ? (
        <Empty title="Nothing deleted">Deleted raffles land here, with everything behind them kept, and can be restored.</Empty>
      ) : list.length === 0 ? (
        <Empty title="No raffles yet">{write ? 'Start with New raffle. It stays a draft, hidden from players, until you publish it.' : 'Raffles appear here once someone creates one.'}</Empty>
      ) : shown.length === 0 ? (
        <Empty title="Nothing matches">Try another filter or search.</Empty>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {shown.map((r, i) => (
            <li key={r.id} className="admin-in min-w-0" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
              <RaffleItem
                r={r}
                canEdit={!r.deletedAt && write && (r.status === 'draft' || (r.status === 'open' && superAdmin))}
                canPublish={!r.deletedAt && write && r.status === 'draft'}
                canUnpublish={!r.deletedAt && write && r.status === 'open' && r.entriesCount === 0}
                canCancel={!r.deletedAt && (r.status === 'open' || r.status === 'draft') && can.includes('raffles.cancel.request')}
                canRunAgain={write}
                canDelete={!r.deletedAt && write && deletable(r) && (r.status === 'draft' || can.includes('raffles.cancel.request'))}
                canRestore={!!r.deletedAt && write}
                superAdmin={superAdmin}
                busy={action.busy}
                onEdit={() => open(r)}
                onRunAgain={() => void runAgain(r)}
                onPublish={() => void publish(r)}
                onUnpublish={() => void unpublish(r)}
                onCancel={() => void cancel(r)}
                onDelete={() => void remove(r)}
                onRestore={() => void restore(r)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RaffleItem({
  r,
  canEdit,
  canPublish,
  canUnpublish,
  canCancel,
  canRunAgain,
  canDelete,
  canRestore,
  superAdmin,
  busy,
  onEdit,
  onPublish,
  onUnpublish,
  onCancel,
  onRunAgain,
  onDelete,
  onRestore,
}: {
  r: AdminRaffle
  canEdit: boolean
  canPublish: boolean
  canUnpublish: boolean
  canCancel: boolean
  canRunAgain: boolean
  canDelete: boolean
  canRestore: boolean
  superAdmin: boolean
  busy: boolean
  onEdit: () => void
  onPublish: () => void
  onUnpublish: () => void
  onCancel: () => void
  onRunAgain: () => void
  onDelete: () => void
  onRestore: () => void
}) {
  const total = r.prizes.length
  const live = r.status === 'open' || r.status === 'draft'
  return (
    <article className="flex h-full flex-col rounded-xl border border-black/15 bg-white transition-shadow duration-200 hover:shadow-[0_6px_24px_-12px_rgba(0,0,0,0.35)]">
      <div className="flex gap-3 p-3.5">
        <div
          className="h-[72px] w-[72px] shrink-0 overflow-hidden rounded-lg"
          style={{ backgroundImage: `linear-gradient(150deg, hsl(${r.hue} 80% 48%) 0%, hsl(${(r.hue + 45) % 360} 85% 42%) 100%)` }}
        >
          <PrizeVisual kind={r.kind as PrizeKind} hue={r.hue} imageUrl={r.imageUrl} rounded="rounded-none" className="h-full w-full" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={r.status} />
            <span className="truncate text-[11.5px] text-neutral-500">{r.category}</span>
          </div>
          <h3 className="mt-1 break-words text-[15px] font-bold leading-snug">{r.prizeName}</h3>
          {r.model && <p className="truncate text-[12px] text-neutral-600">{r.model}</p>}
          {r.deletedAt && (
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11.5px] text-neutral-500">
              <Trash2 size={11} className="shrink-0" />{' '}
              <span className="truncate" title={when(r.deletedAt)}>
                Deleted {relative(r.deletedAt)} by {r.deletedBy}
              </span>
            </p>
          )}
          {r.copiedFrom && (
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11.5px] text-neutral-500">
              <Copy size={11} className="shrink-0" /> <span className="truncate">Run again from {r.copiedFrom.prizeName}</span>
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-2 px-3.5 pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[12px]">
          <span>
            <b>{fmt(r.entriesCount)}</b> / {fmt(r.entriesTarget)} entries
          </span>
          <span className="text-neutral-600">{fmt(r.raffsCollected)} Raffs in</span>
        </div>
        <Bar value={r.entriesTarget ? r.entriesCount / r.entriesTarget : 0} />
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-neutral-500">Entry</dt>
          <dd className="text-right font-semibold">{fmt(r.entryPriceRaffs)} Raffs</dd>
          <dt className="text-neutral-500">Market value</dt>
          <dd className="text-right font-semibold">{naira(r.marketPriceNaira)}</dd>
          <dt className="flex items-center gap-1 text-neutral-500">
            <CalendarClock size={12} /> Draw
          </dt>
          <dd className="text-right font-semibold" title={when(r.deadline)}>
            {live ? relative(r.deadline) : when(r.drawnAt ?? r.cancelledAt ?? r.deadline)}
          </dd>
        </dl>
        <div className="mt-1 rounded-lg bg-neutral-50 px-2.5 py-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-neutral-500">{total === 1 ? 'Prize' : `${total} prizes`}</p>
          <ul className="mt-1 grid gap-0.5 text-[12px]">
            {r.prizes.slice(0, 4).map((p) => (
              <li key={p.position} className="flex min-w-0 gap-2">
                {total > 1 && <span className="w-8 shrink-0 font-bold">{prizeLabel(p.position, total)}</span>}
                <span className="min-w-0 flex-1 truncate">{p.prizeItem}</span>
                {p.winnerUsername && <span className="shrink-0 font-semibold">@{p.winnerUsername}</span>}
              </li>
            ))}
            {total > 4 && <li className="text-neutral-500">and {total - 4} more</li>}
          </ul>
        </div>
      </div>

      {(canEdit || canPublish || canUnpublish || canCancel || canRunAgain || canDelete || canRestore) && (
        <div className="mt-auto flex flex-wrap gap-2 border-t border-black/10 p-3">
          {canPublish && (
            <Button size="sm" variant="solid" icon={<Send size={14} />} disabled={busy} onClick={onPublish}>
              Publish
            </Button>
          )}
          {canEdit && (
            <Button size="sm" icon={<Pencil size={14} />} onClick={onEdit}>
              Edit
            </Button>
          )}
          {canUnpublish && (
            <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} disabled={busy} onClick={onUnpublish}>
              Unpublish
            </Button>
          )}
          {canRunAgain && (
            <Button size="sm" variant="ghost" icon={<Repeat size={14} />} disabled={busy} onClick={onRunAgain}>
              Run again
            </Button>
          )}
          {canRestore && (
            <Button size="sm" icon={<ArchiveRestore size={14} />} disabled={busy} onClick={onRestore}>
              Restore
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="ghost" className="ml-auto" icon={<XCircle size={14} />} disabled={busy} onClick={onCancel}>
              {superAdmin ? 'Cancel and refund' : 'Ask to cancel'}
            </Button>
          )}
          {canDelete && (
            <Button size="sm" variant="ghost" className={canCancel ? undefined : 'ml-auto'} icon={<Trash2 size={14} />} disabled={busy} onClick={onDelete}>
              {r.status === 'draft' || superAdmin ? 'Delete' : 'Ask to delete'}
            </Button>
          )}
        </div>
      )}
    </article>
  )
}
