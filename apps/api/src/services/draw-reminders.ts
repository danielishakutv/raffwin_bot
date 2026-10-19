/**
 * Draw reminders (decision of 19 Oct): 1 hour, 30 minutes and 5 minutes before
 * a raffle's deadline. Runs on the draws loop (every 5 s, services/worker.ts).
 *
 *   entrants   a message of their own, with how many tickets they hold, and a
 *              warning when the raffle is still short of the entries it needs
 *              to be drawn; sent at any hour (it is about their own Raffs)
 *   everyone   with new raffle alerts on and reminders not switched off: one
 *   else       "last chance" broadcast, never in quiet hours, and not once the
 *              raffle is sold out
 *
 * The draw_reminders feature switch turns both off, for everyone or one player.
 * Each stage goes out once per raffle and deadline (raffle_reminders); a stage
 * reached late (a deadline moved closer, a server restart) is passed over in
 * favour of the closest one, so nobody gets "1 hour" and "30 minutes" at once.
 * A raffle that is drawn, cancelled or unpublished stops its reminders still
 * waiting in the outbox (stopDrawReminders).
 */
import { and, eq, gt, inArray, like, lte, sql } from 'drizzle-orm'
import { minEntriesToDraw } from '@raffwin/shared'
import type { AppContext } from '../context'
import { entries, notifications, rafflePrizes, raffleReminders, raffles, users } from '../db/schema'
import { cancelBroadcastsFor } from '../admin/messages'
import { escapeHtml } from '../lib/html'
import { engagementSettings, inQuietHours } from './engagement'
import { featureSql } from './features'
import type { Tx } from './ledger'
import { createBroadcast, openAppButton } from './notify'

/** Minutes before the deadline, furthest first */
export const REMINDER_STAGES = [60, 30, 5] as const
/** Closer than this to the deadline, a reminder would arrive after entries close */
const TOO_LATE_MS = 60_000

const LAGOS_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: 'numeric', minute: '2-digit', hour12: true })

function inMinutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m === 60 ? '1 hour' : `${m} minute${m === 1 ? '' : 's'}`
}

const dedupePrefix = (raffleId: string) => `soon:${raffleId}:`

export interface ReminderPass {
  raffles: number
  entrants: number
  broadcasts: number
}

/** One pass: every open raffle within an hour of its deadline gets the reminder now due, if any. */
export async function runDrawRemindersOnce(ctx: AppContext): Promise<ReminderPass> {
  const now = ctx.now()
  const near = await ctx.db
    .select({ id: raffles.id })
    .from(raffles)
    .where(and(eq(raffles.status, 'open'), gt(raffles.deadline, new Date(now + TOO_LATE_MS)), lte(raffles.deadline, new Date(now + REMINDER_STAGES[0] * 60_000))))
  const pass: ReminderPass = { raffles: 0, entrants: 0, broadcasts: 0 }
  for (const { id } of near) {
    try {
      const sent = await remindOne(ctx, id)
      if (!sent) continue
      pass.raffles += 1
      pass.entrants += sent.entrants
      if (sent.broadcast) pass.broadcasts += 1
    } catch (error) {
      ctx.log.error({ err: error, raffleId: id }, 'draw reminder failed; tried again on the next pass')
    }
  }
  return pass
}

/** Sends the reminder due for one raffle, once. Null when none is due or it already went. */
export async function remindOne(ctx: AppContext, raffleId: string): Promise<{ stage: number; entrants: number; broadcast: boolean } | null> {
  const now = ctx.now()
  const quiet = await engagementSettings(ctx.db)
  return ctx.db.transaction(async (tx) => {
    const [raffle] = await tx.select().from(raffles).where(eq(raffles.id, raffleId))
    if (!raffle || raffle.status !== 'open') return null
    const left = raffle.deadline.getTime() - now
    if (left <= TOO_LATE_MS) return null
    const due = REMINDER_STAGES.filter((s) => left <= s * 60_000)
    if (due.length === 0) return null
    const stage = Math.min(...due)
    // Every stage reached is recorded; only the closest one is sent
    const claimed = await tx
      .insert(raffleReminders)
      .values(due.map((s) => ({ raffleId, stage: s, deadline: raffle.deadline })))
      .onConflictDoNothing()
      .returning({ stage: raffleReminders.stage })
    if (!claimed.some((c) => c.stage === stage)) return null

    const at = LAGOS_CLOCK.format(raffle.deadline)
    const when = inMinutes(left)
    const [prizes] = await tx.select({ n: sql<number>`count(*)::int` }).from(rafflePrizes).where(eq(rafflePrizes.raffleId, raffleId))
    const need = minEntriesToDraw(prizes?.n ?? 1)
    const button = openAppButton(ctx, 'Open Raffle Win', `raffles/${raffleId}`)

    // Entrants: their own message, with their tickets
    const holders = await tx
      .select({ id: users.id, telegramId: users.telegramId, tickets: sql<number>`sum(${entries.qty})::int` })
      .from(entries)
      .innerJoin(users, eq(users.id, entries.userId))
      .where(and(eq(entries.raffleId, raffleId), eq(users.status, 'active'), sql`${users.botBlockedAt} is null`, sql`${featureSql('draw_reminders')} = true`))
      .groupBy(users.id, users.telegramId)
    if (holders.length) {
      const short =
        raffle.entriesCount < need
          ? `\n\nIt has ${raffle.entriesCount} of the ${need} entries it needs to be drawn. If it is still short at the deadline, it is not drawn and every entry is refunded in full. Invite a friend to enter.`
          : ''
      await tx
        .insert(notifications)
        .values(
          holders.map((h) => ({
            userId: h.id,
            telegramId: h.telegramId,
            kind: 'raffle_soon' as const,
            text: `<b>${escapeHtml(raffle.prizeName)}: the draw is in ${when}</b>\n\nYou hold ${h.tickets} ${h.tickets === 1 ? 'ticket' : 'tickets'}. Open Raffle Win at ${at} (Lagos time) to watch the draw live.${short}`,
            buttons: button ? [[button]] : null,
            templateKey: `soon_${stage}`,
            dedupeKey: `${dedupePrefix(raffleId)}${stage}:${raffle.deadline.getTime()}`,
          })),
        )
        .onConflictDoNothing()
    }

    // Everyone else: last chance, unless it is sold out or the middle of the night
    const open = raffle.entriesCount < raffle.entriesTarget
    const night = inQuietHours(now, quiet.quietStartHour, quiet.quietEndHour)
    const b =
      open && !night
        ? await createBroadcast(tx, {
            kind: 'raffle_soon',
            title: `Last chance: ${raffle.prizeName}`,
            text: `Entries close in ${when}, at ${at} (Lagos time). One entry: ${raffle.entryPriceRaffs.toLocaleString('en-NG')} Raff${raffle.entryPriceRaffs === 1 ? '' : 's'}.\n\nThe draw is live in the app the moment entries close.`,
            openButton: true,
            audience: { type: 'all' },
            refType: 'raffle',
            refId: raffleId,
            adminId: null,
          })
        : null
    await tx
      .update(raffleReminders)
      .set({ entrantsTold: holders.length, broadcastId: b?.id ?? null })
      .where(and(eq(raffleReminders.raffleId, raffleId), eq(raffleReminders.stage, stage), eq(raffleReminders.deadline, raffle.deadline)))
    return { stage, entrants: holders.length, broadcast: !!b }
  })
}

/** The raffle closed (drawn, cancelled, unpublished): reminders still waiting to go out are skipped. */
export async function stopDrawReminders(tx: Tx, raffleId: string, at: Date): Promise<void> {
  await cancelBroadcastsFor(tx, { type: 'raffle', id: raffleId }, ['raffle_soon'], at)
  await tx
    .update(notifications)
    .set({ status: 'skipped', error: 'raffle closed', lockedAt: null })
    .where(and(eq(notifications.kind, 'raffle_soon'), inArray(notifications.status, ['pending']), like(notifications.dedupeKey, `${dedupePrefix(raffleId)}%`)))
}
