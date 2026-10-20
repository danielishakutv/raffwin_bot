/**
 * Settings > Reset data (super admin). Takes chosen parts of the platform back
 * to zero, for clearing test data before launch. The server saves a full
 * backup first and refuses to wipe anything without one.
 */
import { useState } from 'react'
import type { ResetPart } from '@raffwin/shared/admin-schemas'
import type { AdminResetPreview, AdminResetResult } from '@raffwin/shared/admin-types'
import { adminCall } from '../adminSession'
import { fmt, useAction, useLoad } from '../hooks'
import { Button, Card, Check, Err, Field, Loading, Notice, TextInput } from '../ui'

type Counts = AdminResetPreview['counts']

const PARTS: { part: ResetPart; title: string; clears: (c: Counts) => string; detail: string }[] = [
  {
    part: 'players',
    title: 'Players',
    clears: (c) => `${fmt(c.players)} players`,
    detail:
      'Every player account and everything that is theirs: KYC, tickets, Raffs and their history, purchases, transfers, streaks, referrals and their bot messages. Raffles stay: drawn ones keep their winning tickets with no winner named, the rest start again from ticket 1.',
  },
  {
    part: 'raffles',
    title: 'Raffles',
    clears: (c) => `${fmt(c.raffles)} raffles, ${fmt(c.entries)} entries`,
    detail: 'Every raffle with its prizes, tickets, reminders and photos. Players stay, and their balances become what they would be had these raffles never run.',
  },
  {
    part: 'finance',
    title: 'Finance',
    clears: (c) => `${fmt(c.ledgerLines)} Raffs records, ${fmt(c.raffsInBalances)} Raffs in balances`,
    detail:
      'Every Raffs record: purchases, vouchers and their batches, expenses, referral earnings, transfers, streak rewards and come-back offers. Every balance becomes 0. Players and their tickets stay. The sales site keeps its own payment records.',
  },
  {
    part: 'messages',
    title: 'Messages',
    clears: (c) => `${fmt(c.broadcasts)} broadcasts, ${fmt(c.notifications)} bot messages`,
    detail: 'The history of broadcasts and messages the bot sent or still has to send.',
  },
]

export function DataReset() {
  const { data: p, error, reload } = useLoad<AdminResetPreview>('/system/reset')
  const action = useAction()
  const [parts, setParts] = useState<Set<ResetPart>>(new Set())
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState('')
  const [result, setResult] = useState<AdminResetResult | null>(null)

  const all = parts.size === PARTS.length
  const toggle = (part: ResetPart, on: boolean) =>
    setParts((s) => {
      const next = new Set(s)
      if (on) next.add(part)
      else next.delete(part)
      return next
    })
  const ready = !!p?.available && parts.size > 0 && reason.trim().length >= 5 && confirm.trim() === p.phrase

  const run = () =>
    void action.run(() => adminCall<AdminResetResult>('POST', '/system/reset', { parts: [...parts], reason: reason.trim(), confirm: confirm.trim() })).then((r) => {
      if (!r) return
      setResult(r)
      setParts(new Set())
      setReason('')
      setConfirm('')
      reload()
    })

  return (
    <Card title="Reset data" subtitle="Before launch: take chosen parts of the platform back to zero. A full backup is saved on the server first." className="h-max">
      <Err message={error ?? action.error} />
      {result && (
        <Notice tone="success" className="mb-3" onClose={() => setResult(null)}>
          Reset done. Removed {fmt(Object.values(result.deleted).reduce((a, b) => a + b, 0))} records. Backup saved as {result.backupFile.split('/').pop()}.
        </Notice>
      )}
      {!p ? (
        <Loading rows={3} />
      ) : !p.available ? (
        <Notice tone="error">Switched off on this server: no backup folder is set up, and nothing is wiped without a backup.</Notice>
      ) : (
        <div className="grid gap-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[12.5px] font-semibold">What to reset</p>
            <Button size="sm" variant="ghost" onClick={() => setParts(all ? new Set() : new Set(PARTS.map((x) => x.part)))}>
              {all ? 'Clear' : 'Everything'}
            </Button>
          </div>
          <div className="grid gap-3">
            {PARTS.map(({ part, title, clears, detail }) => (
              <Check key={part} checked={parts.has(part)} onChange={(on) => toggle(part, on)}>
                <span className="font-bold">{title}</span> <span className="text-neutral-600">· {clears(p.counts)}</span>
                <span className="mt-0.5 block text-[12px] text-neutral-600">{detail}</span>
              </Check>
            ))}
          </div>
          <p className="rounded-lg bg-neutral-100 px-3 py-2 text-[12px] leading-snug text-neutral-700">
            Always kept: admins and their sign-ins, settings, feature switches, rate history, the audit log and security events. Every reset is recorded in the audit log.
          </p>
          <Field label="Why?" hint="Recorded in the audit log">
            <TextInput value={reason} placeholder="e.g. Clearing test data before launch" onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label={`Type ${p.phrase} to confirm`} hint={p.env === 'production' ? 'This is the LIVE platform.' : undefined}>
            <TextInput value={confirm} autoComplete="off" spellCheck={false} placeholder={p.phrase} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Button variant="danger" busy={action.busy} disabled={!ready} onClick={run}>
            {all ? 'Reset everything' : parts.size ? `Reset ${PARTS.filter((x) => parts.has(x.part)).map((x) => x.title.toLowerCase()).join(', ')}` : 'Reset'}
          </Button>
        </div>
      )}
    </Card>
  )
}
