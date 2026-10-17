import { useState } from 'react'
import type { AdminExpense, AdminFinance, AdminRaffle } from '@raffwin/shared/admin-types'
import { prizeLabel } from '@raffwin/shared'
import { adminCall } from '../adminSession'
import { day, digits, fmt, naira, useAction, useLoad } from '../hooks'
import { askText } from '../ask'
import { Badge, Button, Card, Empty, Err, Field, KeyValues, Loading, Segmented, Select, Stat, TabHeading, TextInput } from '../ui'

type PeriodKey = 'all' | 'month' | '30d'

function periodQuery(p: PeriodKey): string {
  const now = new Date()
  if (p === 'month') return `?from=${new Date(now.getFullYear(), now.getMonth(), 1).toISOString()}`
  if (p === '30d') return `?from=${new Date(now.getTime() - 30 * 86_400_000).toISOString()}`
  return ''
}

const CATEGORIES = ['prize_purchase', 'delivery', 'marketing', 'fees', 'operations', 'other']

export function FinanceTab({ can }: { can: string[] }) {
  const [period, setPeriod] = useState<PeriodKey>('all')
  const q = periodQuery(period)
  const { data: f, error, reload } = useLoad<AdminFinance>(`/finance${q}`, 10_000)
  const { data: expenses, reload: reloadExpenses } = useLoad<AdminExpense[]>(`/finance/expenses${q}`, 15_000)
  const { data: raffleList } = useLoad<AdminRaffle[]>('/raffles')
  const action = useAction()
  const today = new Date().toISOString().slice(0, 10)
  const blank = { raffleId: '', category: 'delivery', amountNaira: '', spentOn: today, note: '' }
  const [exp, setExp] = useState(blank)

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
          setExp(blank)
          reload()
          reloadExpenses()
        }
      })
  const voidOne = async (id: string) => {
    const reason = await askText('Why void this expense? It stays on record but stops counting.', { confirm: 'Void', danger: true })
    if (reason) void action.run(() => adminCall('POST', `/finance/expenses/${id}/void`, { reason })).then(() => (reload(), reloadExpenses()))
  }

  return (
    <>
      <TabHeading
        title="Finance"
        sub="Raised, costs and profit, in Naira."
        aside={
          <Segmented<PeriodKey>
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'all', label: 'All time' },
              { value: 'month', label: 'This month' },
              { value: '30d', label: 'Last 30 days' },
            ]}
          />
        }
      />
      <Err message={error ?? action.error} />
      {!f ? (
        <Loading rows={4} />
      ) : (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Raised" value={naira(f.totals.raisedNaira)} sub={`${fmt(f.totals.raisedRaffs)} Raffs on entries`} />
            <Stat label="Profit" value={naira(f.totals.profitNaira)} sub="raised - prizes - referral pay - expenses" />
            <Stat label="Stars received" value={fmt(f.cash.starsReceived)} sub={`= ${naira(f.cash.starsNaira)}`} />
            <Stat label="Raffs players hold" value={fmt(f.outstandingRaffs)} sub="owed in entries" />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Summary">
              <KeyValues
                rows={[
                  ['Raised from entries', naira(f.totals.raisedNaira)],
                  ['Cost of prizes', `- ${naira(f.totals.prizeCostNaira)}`],
                  ['Referral payouts (10%)', `- ${naira(f.totals.referralNaira)}`],
                  ['Expenses linked to raffles', `- ${naira(f.totals.raffleExpensesNaira)}`],
                  ['General expenses', `- ${naira(f.totals.generalExpensesNaira)}`],
                  ['Profit', naira(f.totals.profitNaira), 'total'],
                ]}
              />
              <p className="mt-3 text-[11.5px] leading-snug text-neutral-500">
                Raffs are valued at {naira(f.nairaPerRaff)} each (base Stars per Raff x {naira(f.nairaPerStar)} per Star, from Settings). Raffs prizes count at that value; physical prizes at
                the cost entered on the raffle; prize costs count once a raffle is published. Stars purchases are not switched on yet, so money received is 0 until they are.
              </p>
            </Card>
            <Card title="Raffs in and out">
              <KeyValues
                rows={[
                  ['Raffs sold for Stars', fmt(f.cash.raffsSold)],
                  ['Free: bonuses', fmt(f.freeRaffs.bonus)],
                  ['Free: admin credits', fmt(f.freeRaffs.adjustments)],
                  ['Free: Raffs prizes', fmt(f.freeRaffs.prizes)],
                  ['Free: referral pay', fmt(f.freeRaffs.referrals)],
                ]}
              />
            </Card>
          </div>

          <h3 className="mt-2 text-[12px] font-bold uppercase tracking-[0.08em] text-neutral-600">Per raffle</h3>
          {f.raffles.length === 0 ? (
            <Empty title="No raffles in this period" />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {f.raffles.map((r) => (
                <Card
                  key={r.id}
                  title={r.prizeName}
                  subtitle={`${fmt(r.entriesSold)}/${fmt(r.entriesTarget)} entries at ${fmt(r.entryPriceRaffs)} Raffs`}
                  actions={<Badge tone="muted">{r.status}</Badge>}
                >
                  <KeyValues
                    rows={[
                      ['Raised', `${naira(r.raisedNaira)}${r.refundedRaffs ? ` (after ${fmt(r.refundedRaffs)} Raffs refunded)` : ''}`],
                      ...r.prizes.map(
                        (p) =>
                          [`${prizeLabel(p.position, r.prizes.length)}: ${p.prizeItem}`, `${p.prizeType === 'raffs_credit' ? `${fmt(p.raffsValue)} Raffs = ` : ''}${naira(p.costNaira)}`] as [string, string],
                      ),
                      ['Referral pay', `${naira(r.referralNaira)} (${fmt(r.referralRaffs)} Raffs)`],
                      ['Expenses', naira(r.expensesNaira)],
                      ['Margin', naira(r.marginNaira), 'total'],
                    ]}
                  />
                </Card>
              ))}
            </div>
          )}

          <h3 className="mt-2 text-[12px] font-bold uppercase tracking-[0.08em] text-neutral-600">Expenses</h3>
          <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
            {can.includes('finance.write') && (
              <Card title="Record an expense" className="h-max">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  <Field label="For" className="sm:col-span-2 xl:col-span-1">
                    <Select value={exp.raffleId} onChange={(e) => setExp({ ...exp, raffleId: e.target.value })}>
                      <option value="">General (not one raffle)</option>
                      {(raffleList ?? []).map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.prizeName} [{r.status}]
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Category">
                    <Select value={exp.category} onChange={(e) => setExp({ ...exp, category: e.target.value })}>
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c.replace('_', ' ')}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Amount (₦)">
                    <TextInput inputMode="numeric" value={exp.amountNaira} onChange={(e) => setExp({ ...exp, amountNaira: digits(e.target.value) })} />
                  </Field>
                  <Field label="Date">
                    <TextInput type="date" value={exp.spentOn} onChange={(e) => setExp({ ...exp, spentOn: e.target.value })} />
                  </Field>
                  <Field label="What it was for">
                    <TextInput value={exp.note} onChange={(e) => setExp({ ...exp, note: e.target.value })} />
                  </Field>
                </div>
                <Button variant="solid" className="mt-4 w-full sm:w-auto xl:w-full" busy={action.busy} disabled={!exp.amountNaira || exp.note.trim().length < 3} onClick={addExpense}>
                  Add expense
                </Button>
              </Card>
            )}
            <Card title="Recorded" bodyClassName="p-0">
              {(expenses ?? []).length === 0 ? (
                <p className="p-4 text-[13px] text-neutral-600">No expenses recorded in this period.</p>
              ) : (
                <ul className="divide-y divide-black/10">
                  {(expenses ?? []).map((e) => (
                    <li key={e.id} className={`flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-[12.5px] ${e.voidedAt ? 'opacity-50' : ''}`}>
                      <div className="min-w-0 flex-1">
                        <p className={`font-bold ${e.voidedAt ? 'line-through' : ''}`}>
                          {naira(e.amountNaira)} · {e.category.replace('_', ' ')}
                        </p>
                        <p className="break-words text-neutral-600">
                          {e.note} · {e.raffleName ?? 'general'} · {day(e.spentOn)} · by {e.createdBy}
                        </p>
                        {e.voidedAt && <p className="font-semibold">Voided: {e.voidReason}</p>}
                      </div>
                      {!e.voidedAt && can.includes('finance.write') && (
                        <Button size="sm" variant="ghost" onClick={() => void voidOne(e.id)}>
                          Void
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  )
}
