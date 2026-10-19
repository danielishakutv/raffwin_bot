/**
 * Vouchers sold offline. Ask for a batch (a second admin approves), then
 * issue its codes: they are generated and shown exactly once, to download or
 * copy for the vendor. The server keeps only hashes, so a lost list means
 * voiding the batch and asking for a new one. Look up any code to see who
 * used it, and void a single code or a whole batch.
 */
import { useState } from 'react'
import type { AdminApproval, AdminVoucherBatch, AdminVoucherLookup } from '@raffwin/shared/admin-types'
import { adminCall } from '../adminSession'
import { askText } from '../ask'
import { day, digits, fmt, useAction, useLoad, when } from '../hooks'
import { Badge, Button, Card, Empty, Err, Field, KeyValues, Loading, Notice, TabHeading, TextArea, TextInput } from '../ui'

type Issued = { batchId: string; vendor: string; valueRaffs: number; expiresAt: string | null; codes: string[] }

const STATUS: Record<AdminVoucherBatch['status'], string> = { ready: 'Approved: issue the codes', issued: 'Issued', expired: 'Expired', void: 'Void' }

function download(issued: Issued) {
  const rows = ['code,raffs,vendor,expires', ...issued.codes.map((c) => `${c},${issued.valueRaffs},"${issued.vendor.replace(/"/g, '""')}",${issued.expiresAt ?? ''}`)]
  const url = URL.createObjectURL(new Blob([`${rows.join('\n')}\n`], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `vouchers-${issued.vendor.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${issued.batchId.slice(0, 8)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function VouchersTab({ can, superAdmin }: { can: string[]; superAdmin: boolean }) {
  const write = can.includes('vouchers.write')
  const { data: batches, error, reload } = useLoad<AdminVoucherBatch[]>('/vouchers/batches', 15_000)
  const action = useAction()
  const [msg, setMsg] = useState<string | null>(null)
  const [issued, setIssued] = useState<Issued | null>(null)
  const blank = { vendor: '', note: '', value: '', count: '', expires: '' }
  const [form, setForm] = useState(blank)
  const [code, setCode] = useState('')
  const [found, setFound] = useState<AdminVoucherLookup | null>(null)

  const value = Number(form.value)
  const count = Number(form.count)
  const formOk = form.vendor.trim().length >= 2 && value >= 1 && value <= 100_000 && count >= 1 && count <= 5000

  const ask = async () => {
    const reason = await askText(superAdmin ? 'Why this batch? It is created at once.' : 'Why this batch? A second admin approves it.')
    if (!reason) return
    const body = {
      vendor: form.vendor.trim(),
      note: form.note.trim(),
      valueRaffs: value,
      count,
      expiresAt: form.expires ? new Date(`${form.expires}T23:59:59`).toISOString() : null,
      reason,
    }
    void action.run(() => adminCall<AdminApproval>('POST', '/vouchers/batches', body)).then((a) => {
      if (!a) return
      setForm(blank)
      setMsg(a.status === 'approved' ? `Created: ${a.summary}. Issue the codes below.` : `Queued for approval: ${a.summary}`)
      reload()
    })
  }

  const issue = (b: AdminVoucherBatch) =>
    void action
      .run(() => adminCall<Omit<Issued, 'batchId'> & { batch: Omit<Issued, 'batchId' | 'codes'> }>('POST', `/vouchers/batches/${b.id}/issue`))
      .then((r) => {
        if (!r) return
        setIssued({ batchId: b.id, codes: r.codes, ...r.batch })
        reload()
      })

  const voidBatch = async (b: AdminVoucherBatch) => {
    const reason = await askText(`Why void ${b.vendor}'s batch? Its ${fmt(b.count - b.redeemed - b.voided)} unused codes stop working; used ones keep their history.`, {
      confirm: 'Void batch',
      danger: true,
    })
    if (reason) void action.run(() => adminCall<{ codesVoided: number }>('POST', `/vouchers/batches/${b.id}/void`, { reason })).then((r) => r && (setMsg(`Voided ${fmt(r.codesVoided)} codes.`), reload()))
  }

  const lookup = () => void action.run(() => adminCall<AdminVoucherLookup>('POST', '/vouchers/lookup', { code })).then((r) => r && setFound(r))
  const voidCode = async () => {
    const ok = await askText('Why void this code? It stops working at once.', { confirm: 'Void code', danger: true })
    if (ok) void action.run(() => adminCall<{ tail: string }>('POST', '/vouchers/void-code', { code })).then((r) => r && (setMsg(`Code ...${r.tail} voided.`), lookup(), reload()))
  }

  return (
    <>
      <TabHeading title="Vouchers" sub="Codes sold offline by vendors. Players type them under Wallet > Redeem a code." />
      <Err message={error ?? action.error} />
      {msg && (
        <Notice tone="success" className="mb-4" onClose={() => setMsg(null)}>
          {msg}
        </Notice>
      )}

      {issued && (
        <Card title={`${fmt(issued.codes.length)} codes for ${issued.vendor}`} subtitle="Shown once. Download or copy them now: they cannot be shown again." className="mb-4">
          <TextArea readOnly rows={Math.min(10, issued.codes.length + 1)} value={issued.codes.join('\n')} className="font-mono text-[13px]" />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="solid" onClick={() => download(issued)}>
              Download CSV
            </Button>
            <Button onClick={() => void navigator.clipboard?.writeText(issued.codes.join('\n')).then(() => setMsg('Codes copied.'), () => setMsg('Copy failed: select the list and copy it by hand.'))}>
              Copy all
            </Button>
            <Button onClick={() => setIssued(null)}>I have saved them</Button>
          </div>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <div className="grid content-start gap-4">
          {!batches ? (
            <Loading rows={3} />
          ) : batches.length === 0 ? (
            <Empty title="No batches yet">Ask for one on the right.</Empty>
          ) : (
            batches.map((b) => (
              <Card key={b.id} title={b.vendor} subtitle={b.note || undefined} actions={<Badge tone={b.status === 'void' ? 'dashed' : b.status === 'ready' ? 'solid' : 'outline'}>{STATUS[b.status]}</Badge>}>
                <KeyValues
                  rows={[
                    ['Each code', `${fmt(b.valueRaffs)} Raffs`],
                    ['Codes', fmt(b.count)],
                    ['Used', `${fmt(b.redeemed)} (${fmt(b.redeemed * b.valueRaffs)} Raffs)`],
                    ...(b.voided ? ([['Voided', fmt(b.voided)]] as [string, string][]) : []),
                    ['Expires', b.expiresAt ? day(b.expiresAt) : 'Never'],
                    ['Created', when(b.createdAt)],
                    ...(b.voidReason ? ([['Void reason', b.voidReason]] as [string, string][]) : []),
                  ]}
                />
                {write && b.status !== 'void' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {b.status === 'ready' && (
                      <Button variant="solid" busy={action.busy} onClick={() => issue(b)}>
                        Issue the codes
                      </Button>
                    )}
                    <Button onClick={() => void voidBatch(b)}>Void batch</Button>
                  </div>
                )}
              </Card>
            ))
          )}
        </div>

        <div className="grid content-start gap-4">
          {write && (
            <Card title="New batch" subtitle="Approved by a second admin. Up to 5,000 codes.">
              <div className="grid gap-3">
                <Field label="Vendor">
                  <TextInput value={form.vendor} maxLength={80} placeholder="e.g. Jibowu Park, kiosk 4" onChange={(e) => setForm({ ...form, vendor: e.target.value })} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Raffs per code">
                    <TextInput inputMode="numeric" value={form.value} onChange={(e) => setForm({ ...form, value: digits(e.target.value) })} />
                  </Field>
                  <Field label="How many codes">
                    <TextInput inputMode="numeric" value={form.count} onChange={(e) => setForm({ ...form, count: digits(e.target.value) })} />
                  </Field>
                </div>
                <Field label="Expires (optional)" hint="Codes stop working at the end of this day">
                  <TextInput type="date" value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
                </Field>
                <Field label="Note (optional)">
                  <TextInput value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                </Field>
                {formOk && <p className="text-[12px] text-neutral-600">{`${fmt(count)} codes x ${fmt(value)} Raffs = ${fmt(count * value)} Raffs in all.`}</p>}
                <Button variant="solid" disabled={!formOk || action.busy} onClick={() => void ask()}>
                  {superAdmin ? 'Create batch' : 'Ask for this batch'}
                </Button>
              </div>
            </Card>
          )}

          <Card title="Look up a code" subtitle="Whether it was used, and by whom.">
            <div className="flex gap-2">
              <TextInput className="font-mono" value={code} maxLength={40} placeholder="XXXX-XXXX-XXXX-XXXX" onChange={(e) => (setCode(e.target.value), setFound(null))} />
              <Button disabled={code.replace(/[\s-]/g, '').length !== 16 || action.busy} onClick={lookup}>
                Look up
              </Button>
            </div>
            {found &&
              (found.found ? (
                <>
                  <KeyValues
                    className="mt-3"
                    rows={[
                      ['Status', found.status, 'strong'],
                      ['Vendor', found.vendor],
                      ['Value', `${fmt(found.valueRaffs)} Raffs`],
                      ['Used by', found.redeemedBy ? `@${found.redeemedBy.username ?? found.redeemedBy.telegramId ?? found.redeemedBy.userId}` : '-'],
                      ['Used', found.redeemedAt ? when(found.redeemedAt) : '-'],
                    ]}
                  />
                  {write && found.status === 'active' && (
                    <Button className="mt-3" onClick={() => void voidCode()}>
                      Void this code
                    </Button>
                  )}
                </>
              ) : (
                <p className="mt-3 text-[13px] font-semibold">No such code.</p>
              ))}
          </Card>
        </div>
      </div>
    </>
  )
}
