/**
 * Finance report for super admins and finance: what each raffle raised, what
 * its prizes and referral payouts cost, linked and general expenses, real
 * money received (Telegram Stars), free Raffs handed out, and profit.
 *
 * Raffs are valued at one report rate: base Stars per Raff x Naira per Star
 * (both admin settings). Raffs prizes count at that rate; physical prizes at
 * the cost entered on the prize. Every figure is computed from the ledger,
 * entries and expenses on request, never stored, so it cannot drift.
 */
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { ExpenseBody } from '@raffwin/shared/admin-schemas'
import type { AdminExpense, AdminFinance, FinanceRaffle } from '@raffwin/shared/admin-types'
import type { AppContext } from '../context'
import { adminUsers, entries, financeExpenses, ledger, rafflePrizes, raffles, referralEarnings, users } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { getSettingsView } from './operations'
import { appendAudit } from './audit'

export interface Period {
  from: Date | null
  to: Date | null
}

const COUNTS_PRIZES: string[] = ['open', 'drawing', 'drawn']

function within(col: Parameters<typeof gte>[0], p: Period) {
  return and(p.from ? gte(col, p.from) : undefined, p.to ? lt(col, p.to) : undefined)
}

export async function report(ctx: AppContext, p: Period): Promise<AdminFinance> {
  const s = await getSettingsView(ctx)
  const npr = s.baseStarsPerRaff * s.nairaPerStar
  const naira = (raffs: number) => Math.round(raffs * npr)

  const raffleRows = await ctx.db.select().from(raffles).orderBy(desc(raffles.createdAt))
  const ids = raffleRows.map((r) => r.id)
  const prizes = ids.length ? await ctx.db.select().from(rafflePrizes).where(inArray(rafflePrizes.raffleId, ids)) : []

  const raised = await ctx.db
    .select({ raffleId: entries.raffleId, raffs: sql<number>`coalesce(sum(${entries.raffsSpent}), 0)::int`, sold: sql<number>`coalesce(sum(${entries.qty}), 0)::int` })
    .from(entries)
    .where(within(entries.createdAt, p))
    .groupBy(entries.raffleId)
  const refunds = await ctx.db
    .select({ raffleId: entries.raffleId, raffs: sql<number>`coalesce(sum(${ledger.raffs}), 0)::int` })
    .from(ledger)
    .innerJoin(entries, eq(entries.id, ledger.referenceId))
    .where(and(eq(ledger.type, 'refund'), within(ledger.createdAt, p)))
    .groupBy(entries.raffleId)
  const referrals = await ctx.db
    .select({ raffleId: entries.raffleId, raffs: sql<number>`coalesce(sum(${referralEarnings.raffs}), 0)::int` })
    .from(referralEarnings)
    .innerJoin(entries, eq(entries.id, referralEarnings.entryId))
    .where(and(isNull(referralEarnings.reversedAt), within(referralEarnings.createdAt, p)))
    .groupBy(entries.raffleId)
  const expenses = await ctx.db
    .select({ raffleId: financeExpenses.raffleId, naira: sql<number>`coalesce(sum(${financeExpenses.amountNaira}), 0)::int` })
    .from(financeExpenses)
    .where(and(isNull(financeExpenses.voidedAt), within(financeExpenses.spentOn, p)))
    .groupBy(financeExpenses.raffleId)

  const by = <T extends { raffleId: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.raffleId, r]))
  const raisedBy = by(raised)
  const refundBy = by(refunds)
  const referralBy = by(referrals)
  const expenseBy = by(expenses)

  const list: FinanceRaffle[] = raffleRows.map((r) => {
    const ps = prizes
      .filter((x) => x.raffleId === r.id)
      .sort((a, b) => a.position - b.position)
      .map((x) => ({
        position: x.position,
        prizeItem: x.prizeItem,
        prizeType: x.prizeType,
        raffsValue: x.raffsValue,
        costNaira: x.prizeType === 'raffs_credit' ? naira(x.raffsValue) : x.costNaira,
      }))
    const spent = raisedBy.get(r.id)?.raffs ?? 0
    const refunded = refundBy.get(r.id)?.raffs ?? 0
    const raisedRaffs = spent - refunded
    const prizeCostNaira = COUNTS_PRIZES.includes(r.status) ? ps.reduce((sum, x) => sum + x.costNaira, 0) : 0
    const referralRaffs = referralBy.get(r.id)?.raffs ?? 0
    const expensesNaira = expenseBy.get(r.id)?.naira ?? 0
    const raisedNaira = naira(raisedRaffs)
    return {
      id: r.id,
      prizeName: r.prizeName,
      status: r.status,
      deadline: r.deadline.toISOString(),
      entryPriceRaffs: r.entryPriceRaffs,
      entriesSold: r.entriesCount,
      entriesTarget: r.entriesTarget,
      raisedRaffs,
      raisedNaira,
      refundedRaffs: refunded,
      prizes: ps,
      prizeCostNaira,
      referralRaffs,
      referralNaira: naira(referralRaffs),
      expensesNaira,
      marginNaira: raisedNaira - prizeCostNaira - naira(referralRaffs) - expensesNaira,
    }
  })

  const general = expenseBy.get(null)?.naira ?? 0
  const sum = (f: (x: FinanceRaffle) => number) => list.reduce((acc, x) => acc + f(x), 0)

  const [cash] = await ctx.db
    .select({
      stars: sql<number>`coalesce(sum(${ledger.stars}) filter (where ${ledger.type} = 'purchase'), 0)::int`,
      raffsSold: sql<number>`coalesce(sum(${ledger.raffs}) filter (where ${ledger.type} = 'purchase'), 0)::int`,
      bonus: sql<number>`coalesce(sum(${ledger.raffs}) filter (where ${ledger.type} = 'bonus'), 0)::int`,
      adjustments: sql<number>`coalesce(sum(${ledger.raffs}) filter (where ${ledger.type} = 'adjustment' and ${ledger.raffs} > 0), 0)::int`,
      prizeRaffs: sql<number>`coalesce(sum(${ledger.raffs}) filter (where ${ledger.type} = 'prize'), 0)::int`,
      referralRaffs: sql<number>`coalesce(sum(${ledger.raffs}) filter (where ${ledger.type} = 'referral'), 0)::int`,
    })
    .from(ledger)
    .where(within(ledger.createdAt, p))
  const [owed] = await ctx.db.select({ n: sql<number>`coalesce(sum(${users.balanceCache}), 0)::int` }).from(users)

  return {
    period: { from: p.from?.toISOString() ?? null, to: p.to?.toISOString() ?? null },
    nairaPerRaff: npr,
    nairaPerStar: s.nairaPerStar,
    raffles: list,
    totals: {
      raisedRaffs: sum((x) => x.raisedRaffs),
      raisedNaira: sum((x) => x.raisedNaira),
      prizeCostNaira: sum((x) => x.prizeCostNaira),
      referralNaira: sum((x) => x.referralNaira),
      raffleExpensesNaira: sum((x) => x.expensesNaira),
      generalExpensesNaira: general,
      profitNaira: sum((x) => x.marginNaira) - general,
    },
    cash: { starsReceived: cash?.stars ?? 0, starsNaira: Math.round((cash?.stars ?? 0) * s.nairaPerStar), raffsSold: cash?.raffsSold ?? 0 },
    freeRaffs: {
      bonus: cash?.bonus ?? 0,
      adjustments: cash?.adjustments ?? 0,
      prizes: cash?.prizeRaffs ?? 0,
      referrals: cash?.referralRaffs ?? 0,
    },
    outstandingRaffs: owed?.n ?? 0,
  }
}

/* Expenses -------------------------------------------------------------------- */

export async function listExpenses(ctx: AppContext, p: Period): Promise<AdminExpense[]> {
  const rows = await ctx.db
    .select({ e: financeExpenses, raffleName: raffles.prizeName, by: adminUsers.name })
    .from(financeExpenses)
    .leftJoin(raffles, eq(raffles.id, financeExpenses.raffleId))
    .innerJoin(adminUsers, eq(adminUsers.id, financeExpenses.createdByAdminId))
    .where(within(financeExpenses.spentOn, p))
    .orderBy(desc(financeExpenses.spentOn))
    .limit(500)
  return rows.map(({ e, raffleName, by }) => ({
    id: e.id,
    raffleId: e.raffleId,
    raffleName,
    category: e.category,
    amountNaira: e.amountNaira,
    spentOn: e.spentOn.toISOString(),
    note: e.note,
    createdBy: by,
    voidedAt: e.voidedAt?.toISOString() ?? null,
    voidReason: e.voidReason,
  }))
}

export async function addExpense(ctx: AppContext, adminId: string, body: ExpenseBody): Promise<AdminExpense> {
  if (body.raffleId) {
    const [r] = await ctx.db.select({ id: raffles.id }).from(raffles).where(eq(raffles.id, body.raffleId))
    if (!r) throw new HttpError('INVALID_INPUT', 'No such raffle.', { raffleId: 'Not found' })
  }
  const id = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(financeExpenses)
      .values({ ...body, spentOn: new Date(body.spentOn), createdByAdminId: adminId })
      .returning({ id: financeExpenses.id })
    if (!row) throw new Error('expense insert returned no row')
    await appendAudit(tx, { adminId, action: 'finance.expense.add', targetType: 'expense', targetId: row.id, after: body })
    return row.id
  })
  return (await listExpenses(ctx, { from: null, to: null })).find((e) => e.id === id) as AdminExpense
}

/** Expenses are never deleted: a wrong one is voided with a reason and stops counting. */
export async function voidExpense(ctx: AppContext, adminId: string, id: string, reason: string): Promise<AdminExpense> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(financeExpenses).where(eq(financeExpenses.id, id)).for('update')
    if (!row) throw new HttpError('NOT_FOUND', 'No such expense.')
    if (row.voidedAt) throw new HttpError('INVALID_INPUT', 'This expense is already voided.')
    await tx
      .update(financeExpenses)
      .set({ voidedAt: sql`now()`, voidedByAdminId: adminId, voidReason: reason })
      .where(eq(financeExpenses.id, id))
    await appendAudit(tx, { adminId, action: 'finance.expense.void', targetType: 'expense', targetId: id, before: { amountNaira: row.amountNaira }, after: { reason } })
  })
  return (await listExpenses(ctx, { from: null, to: null })).find((e) => e.id === id) as AdminExpense
}
