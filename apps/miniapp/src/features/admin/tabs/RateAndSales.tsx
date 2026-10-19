/**
 * Settings > Rate and sales: the base naira price of a Raff and how far it
 * moves each hour, and what the sales site offers (packages, bonuses, the
 * smallest and largest purchase). Both change what players pay or get, so a
 * second admin approves them (a super admin's change applies at once).
 */
import { useEffect, useState } from 'react'
import type { AdminApproval, AdminSettings } from '@raffwin/shared/admin-types'
import { adminCall } from '../adminSession'
import { askText } from '../ask'
import { useAction } from '../hooks'
import { Button, Card, Err, Field, TextInput } from '../ui'

type Pack = { naira: string; bonus: string; label: string }

const digits = (v: string) => v.replace(/[^0-9]/g, '')
const naira = (n: number) => `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`

export function RateAndSales({ s, canChange, superAdmin, onDone }: { s: AdminSettings; canChange: boolean; superAdmin: boolean; onDone: (message: string) => void }) {
  const action = useAction()
  const [rate, setRate] = useState({ base: '', min: '', max: '' })
  const [packs, setPacks] = useState<Pack[]>([])
  const [limits, setLimits] = useState({ min: '', max: '' })

  useEffect(() => {
    setRate({ base: String(s.rate.nairaPerRaff), min: String(s.rate.moveMinPct), max: String(s.rate.moveMaxPct) })
    setPacks(s.sales.packages.map((p) => ({ naira: String(p.naira), bonus: String(p.bonusPercent), label: p.label ?? '' })))
    setLimits({ min: String(s.sales.minNaira), max: String(s.sales.maxNaira) })
  }, [s])

  const done = (a: AdminApproval | undefined, appliesFrom: string) =>
    a && onDone(a.status === 'approved' ? `Done: ${a.summary} (${appliesFrom})` : `Queued for approval: ${a.summary}`)

  const saveRate = async () => {
    const reason = await askText(superAdmin ? 'Why change the rate? It applies from the next hour.' : 'Why change the rate? A second admin approves it.')
    if (!reason) return
    const body = { nairaPerRaff: Number(rate.base), moveMinPct: Number(rate.min), moveMaxPct: Number(rate.max), reason }
    void action.run(() => adminCall<AdminApproval>('POST', '/settings/rate-base', body)).then((a) => done(a, 'from the next hour'))
  }
  const saveSales = async () => {
    const reason = await askText(superAdmin ? 'Why change what the sales site offers? It applies at once.' : 'Why change what the sales site offers? A second admin approves it.')
    if (!reason) return
    const body = {
      packages: packs.map((p) => ({ naira: Number(p.naira), bonusPercent: Number(p.bonus || 0), label: p.label.trim() || null })),
      minNaira: Number(limits.min),
      maxNaira: Number(limits.max),
      reason,
    }
    void action.run(() => adminCall<AdminApproval>('POST', '/settings/sales', body)).then((a) => done(a, 'now'))
  }

  const base = Number(rate.base)
  const lo = Number(rate.min)
  const hi = Number(rate.max)
  const rateOk = base > 0 && /^\d+(\.\d{1,2})?$/.test(rate.base) && lo <= hi && hi <= 30
  const rateChanged = base !== s.rate.nairaPerRaff || lo !== s.rate.moveMinPct || hi !== s.rate.moveMaxPct
  const range = hi === 0 ? `Fixed at ${naira(base || 0)}` : `Each hour between ${naira(((base || 0) * (100 - hi)) / 100)} and ${naira(((base || 0) * (100 + hi)) / 100)}`

  const minN = Number(limits.min)
  const maxN = Number(limits.max)
  const packsOk = packs.every((p) => Number(p.naira) >= minN && Number(p.naira) <= maxN && Number(p.bonus || 0) <= 15)
  const salesOk = minN >= 100 && maxN >= minN && packs.length <= 8 && packsOk

  return (
    <Card title="Rate and sales" subtitle="What one Raff costs on the sales site, and what it offers. A second admin approves changes.">
      <Err message={action.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Base price of 1 Raff (₦)" hint="Kobo allowed, e.g. 12.50">
          <TextInput inputMode="decimal" value={rate.base} disabled={!canChange} onChange={(e) => setRate({ ...rate, base: e.target.value.replace(/[^0-9.]/g, '') })} />
        </Field>
        <Field label="Smallest hourly move (%)">
          <TextInput inputMode="numeric" value={rate.min} disabled={!canChange} onChange={(e) => setRate({ ...rate, min: digits(e.target.value) })} />
        </Field>
        <Field label="Largest hourly move (%)" hint="0 and 0 = a fixed price" error={lo > hi ? 'Below the smallest' : hi > 30 ? 'At most 30' : null}>
          <TextInput inputMode="numeric" value={rate.max} disabled={!canChange} onChange={(e) => setRate({ ...rate, max: digits(e.target.value) })} />
        </Field>
      </div>
      <p className="mt-2 text-[12px] text-neutral-600">{rateOk ? `${range}, up or down at random, always from the base.` : 'Enter a price and a range.'}</p>
      {canChange && (
        <Button className="mt-3" disabled={!rateOk || !rateChanged || action.busy} onClick={() => void saveRate()}>
          {superAdmin ? 'Change the rate' : 'Ask to change the rate'}
        </Button>
      )}

      <h4 className="mt-6 text-[12px] font-bold uppercase tracking-[0.08em] text-neutral-600">Packages</h4>
      <div className="mt-2 grid gap-2">
        {packs.map((p, i) => (
          <div key={i} className="grid grid-cols-[1fr_5rem_1fr_auto] items-end gap-2">
            <Field label={i === 0 ? 'Pay (₦)' : ''}>
              <TextInput inputMode="numeric" value={p.naira} disabled={!canChange} onChange={(e) => setPacks(packs.map((x, j) => (j === i ? { ...x, naira: digits(e.target.value) } : x)))} />
            </Field>
            <Field label={i === 0 ? 'Bonus %' : ''} error={Number(p.bonus || 0) > 15 ? 'Max 15' : null}>
              <TextInput inputMode="numeric" value={p.bonus} disabled={!canChange} onChange={(e) => setPacks(packs.map((x, j) => (j === i ? { ...x, bonus: digits(e.target.value) } : x)))} />
            </Field>
            <Field label={i === 0 ? 'Tag (optional)' : ''}>
              <TextInput maxLength={24} value={p.label} placeholder="e.g. Popular" disabled={!canChange} onChange={(e) => setPacks(packs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            </Field>
            {canChange && (
              <Button size="sm" onClick={() => setPacks(packs.filter((_, j) => j !== i))}>
                Remove
              </Button>
            )}
          </div>
        ))}
        {packs.length === 0 && <p className="text-[12.5px] text-neutral-600">No packages: buyers type their own amount.</p>}
      </div>
      {canChange && packs.length < 8 && (
        <Button size="sm" className="mt-2" onClick={() => setPacks([...packs, { naira: '', bonus: '0', label: '' }])}>
          Add a package
        </Button>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Smallest purchase (₦)" hint="A typed amount gets no bonus">
          <TextInput inputMode="numeric" value={limits.min} disabled={!canChange} onChange={(e) => setLimits({ ...limits, min: digits(e.target.value) })} />
        </Field>
        <Field label="Largest purchase (₦)" error={maxN < minN ? 'Below the smallest' : null}>
          <TextInput inputMode="numeric" value={limits.max} disabled={!canChange} onChange={(e) => setLimits({ ...limits, max: digits(e.target.value) })} />
        </Field>
      </div>
      {!packsOk && <p className="mt-2 text-[12px] font-semibold">⚠ Every package must be between the smallest and largest purchase, with a bonus of at most 15%.</p>}
      {canChange ? (
        <Button className="mt-3" disabled={!salesOk || action.busy} onClick={() => void saveSales()}>
          {superAdmin ? 'Save sales options' : 'Ask to change sales options'}
        </Button>
      ) : (
        <p className="mt-3 text-[13px] text-neutral-600">Your role can see these but not change them.</p>
      )}
    </Card>
  )
}
