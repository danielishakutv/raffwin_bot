/**
 * One balance adjustment for every player picked in the Players list. The
 * server applies it to all of them or none; a debit that would take anyone
 * below zero is refused, so players short of the amount are flagged here first.
 */
import { useState } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { BULK_ADJUST_MAX_PLAYERS, BULK_ADJUST_MAX_TOTAL } from '@raffwin/shared/admin-schemas'
import type { AdminApproval, AdminUserSummary } from '@raffwin/shared/admin-types'
import { adminCall } from '../adminSession'
import { askConfirm } from '../ask'
import { digits, fmt, useAction } from '../hooks'
import { Badge, Button, Card, Err, Field, Segmented, TextArea, TextInput } from '../ui'

type Direction = 'credit' | 'debit'

export function BulkAdjust({
  picked,
  superAdmin,
  onRemove,
  onBack,
  onDone,
}: {
  picked: AdminUserSummary[]
  superAdmin: boolean
  onRemove: (ids: string[]) => void
  onBack: () => void
  onDone: (message: string) => void
}) {
  const action = useAction()
  const [direction, setDirection] = useState<Direction>('credit')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const each = Number(amount || 0)
  const total = each * picked.length
  // Balances as of the last list load; the server checks again when it runs
  const short = direction === 'debit' && each > 0 ? picked.filter((u) => u.balance < each) : []
  const problem =
    picked.length === 0
      ? 'Pick at least one player.'
      : picked.length > BULK_ADJUST_MAX_PLAYERS
        ? `At most ${BULK_ADJUST_MAX_PLAYERS} players at a time; remove ${picked.length - BULK_ADJUST_MAX_PLAYERS}.`
        : each > 1_000_000
          ? 'At most 1,000,000 Raffs each.'
          : total > BULK_ADJUST_MAX_TOTAL
            ? `At most ${fmt(BULK_ADJUST_MAX_TOTAL)} Raffs in all; this is ${fmt(total)}.`
            : short.length
              ? `${short.length} player${short.length === 1 ? ' has' : 's have'} less than ${fmt(each)} Raffs. A debit never goes below zero: remove them first.`
              : null

  const submit = async () => {
    const verb = direction === 'credit' ? 'Credit' : 'Debit'
    const how = superAdmin ? 'It happens at once for all of them.' : 'A second admin approves it before anything changes.'
    const told = direction === 'credit' ? ' Each player gets a bot message when the Raffs land.' : ''
    const ok = await askConfirm(`${verb} ${fmt(each)} Raffs each ${direction === 'credit' ? 'to' : 'from'} ${fmt(picked.length)} players (${fmt(total)} Raffs in all)? ${how}${told}`, verb, direction === 'debit')
    if (!ok) return
    const raffs = direction === 'credit' ? each : -each
    const a = await action.run(() => adminCall<AdminApproval>('POST', '/users/bulk-adjust', { userIds: picked.map((u) => u.id), raffs, reason: reason.trim() }))
    if (a) onDone(a.status === 'approved' ? `Done: ${a.summary}` : `Queued for approval: ${a.summary}`)
  }

  return (
    <div className="admin-in grid gap-4">
      <div>
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={15} />} onClick={onBack}>
          Back to players
        </Button>
      </div>
      <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Card title="Adjust balances" subtitle="The same amount for every selected player. All of them or none." className="h-max">
          <div className="grid gap-3">
            <Segmented<Direction>
              value={direction}
              onChange={setDirection}
              options={[
                { value: 'credit', label: 'Credit (add)' },
                { value: 'debit', label: 'Debit (take away)' },
              ]}
            />
            <Field label="Raffs for each player" aside={each > 0 ? `${fmt(total)} Raffs in all` : undefined}>
              <TextInput inputMode="numeric" placeholder="e.g. 100" value={amount} onChange={(e) => setAmount(digits(e.target.value).slice(0, 7))} />
            </Field>
            <Field label="Why?" hint="Recorded in the audit log and shown to the approver. Players never see it.">
              <TextArea rows={3} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Err message={problem && each > 0 ? problem : null} />
            <Err message={action.error} />
            <Button
              variant="solid"
              className="w-full"
              busy={action.busy}
              disabled={!!problem || each <= 0 || reason.trim().length < 3}
              onClick={() => void submit()}
            >
              {superAdmin ? `${direction === 'credit' ? 'Credit' : 'Debit'} ${fmt(picked.length)} players` : `Ask to adjust ${fmt(picked.length)} players`}
            </Button>
          </div>
        </Card>

        <Card
          title={`Selected players (${fmt(picked.length)})`}
          subtitle={short.length ? 'Marked: less than the amount to debit.' : 'Balances as of the last search.'}
          actions={
            short.length ? (
              <Button size="sm" onClick={() => onRemove(short.map((u) => u.id))}>
                Remove the {short.length} short
              </Button>
            ) : undefined
          }
          bodyClassName="p-0"
        >
          <ul className="max-h-[520px] divide-y divide-black/10 overflow-y-auto">
            {picked.map((u) => {
              const isShort = short.includes(u)
              return (
                <li key={u.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">@{u.username ?? '-'}</span>
                    <span className="block truncate text-[11.5px] text-neutral-500">{u.fullName ?? `Telegram ${u.telegramId}`}</span>
                  </span>
                  {isShort && <Badge tone="solid">short</Badge>}
                  <span className="tabular-nums font-semibold">{fmt(u.balance)}</span>
                  <button
                    type="button"
                    aria-label={`Remove @${u.username ?? u.telegramId}`}
                    onClick={() => onRemove([u.id])}
                    className="rounded-lg p-1.5 text-neutral-500 hover:bg-black/5 hover:text-black"
                  >
                    <X size={15} />
                  </button>
                </li>
              )
            })}
          </ul>
        </Card>
      </div>
    </div>
  )
}
