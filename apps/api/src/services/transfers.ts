/**
 * Send Raffs (feature raffs_transfer): a player sends Raffs from their balance
 * to another player by Raffle Win username. One transaction:
 *
 *   1. lock sender and recipient (in id order, so two transfers between the
 *      same pair, in either direction, can never wait on each other)
 *   2. check both are active, the daily cap and the sender's balance
 *   3. two ledger rows (transfer_out on the sender, transfer_in on the
 *      recipient) and one raffs_transfers row linking them
 *
 * The sender needs a verified phone (one phone = one person, which keeps
 * Raffs from being funnelled between throwaway accounts). The recipient must
 * already have opened the app, so they have an account to credit. A retry
 * with the same idempotency key returns the original transfer, never a second,
 * and never a refusal (the original already spent the balance and the cap).
 * After the commit the recipient gets a bot message through the outbox.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import type { TransferLimits, TransferRecipient, TransferResult } from '@raffwin/shared'
import type { TransferBody } from '@raffwin/shared/schemas'
import type { AppContext } from '../context'
import type { Db } from '../db/client'
import { uniqueViolation } from '../db/client'
import { raffsTransfers, users, type UserRow } from '../db/schema'
import { escapeHtml, firstName } from '../lib/html'
import { HttpError } from '../lib/http-error'
import { lagosDayStart } from './entries'
import { requireFeature } from './features'
import { post } from './ledger'
import { enqueue, openAppButton } from './notify'
import { getSetting } from './settings'

type Reader = Pick<Db, 'select'>

/** '@Ada_Obi ' -> 'ada_obi' (usernames are stored lower-case). */
function normaliseUsername(value: string): string {
  return value.trim().replace(/^@+/, '').toLowerCase()
}

async function sentSince(db: Reader, userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${raffsTransfers.raffs}), 0)::int` })
    .from(raffsTransfers)
    .where(and(eq(raffsTransfers.fromUserId, userId), gte(raffsTransfers.createdAt, since)))
  return row?.n ?? 0
}

export async function getLimits(ctx: AppContext, user: UserRow): Promise<TransferLimits> {
  await requireFeature(ctx.db, 'raffs_transfer', user.id)
  const [minRaffs, dailyMaxRaffs, sentToday] = await Promise.all([
    getSetting(ctx.db, 'transfers.min_raffs'),
    getSetting(ctx.db, 'transfers.daily_max_raffs'),
    sentSince(ctx.db, user.id, lagosDayStart(ctx.now())),
  ])
  return { minRaffs, dailyMaxRaffs, sentToday }
}

/** The player a username names, if Raffs may be sent to them by `sender`. */
async function resolveRecipient(ctx: AppContext, sender: UserRow, username: string): Promise<UserRow> {
  const name = normaliseUsername(username)
  const [row] = name ? await ctx.db.select().from(users).where(eq(users.username, name)) : []
  if (!row || !row.signedUpAt) throw new HttpError('NOT_FOUND', 'No Raffle Win player with that username.')
  if (row.id === sender.id) throw new HttpError('INVALID_INPUT', 'That is your own username. Enter the username of the player you are sending to.', { to: 'Not your own username' })
  if (row.status !== 'active') throw new HttpError('INVALID_INPUT', 'That player cannot receive Raffs right now.', { to: 'Cannot receive Raffs' })
  return row
}

export async function findRecipient(ctx: AppContext, user: UserRow, username: string): Promise<TransferRecipient> {
  await requireFeature(ctx.db, 'raffs_transfer', user.id)
  const to = await resolveRecipient(ctx, user, username)
  return { username: to.username as string, displayName: firstName(to) }
}

export async function sendRaffs(ctx: AppContext, sender: UserRow, body: TransferBody): Promise<TransferResult> {
  await requireFeature(ctx.db, 'raffs_transfer', sender.id)

  const replay = await findByKey(ctx, sender.id, body.idempotencyKey)
  if (replay) return replay

  if (!sender.phone) throw new HttpError('PHONE_REQUIRED', 'Share your phone number first, then you can send Raffs.')
  const to = await resolveRecipient(ctx, sender, body.to)
  const minRaffs = await getSetting(ctx.db, 'transfers.min_raffs')
  if (body.raffs < minRaffs) {
    throw new HttpError('INVALID_INPUT', `The smallest transfer is ${minRaffs} Raffs.`, { raffs: `At least ${minRaffs}` })
  }

  const now = ctx.now()
  let made: { id: string; replayed: boolean }
  try {
    made = await ctx.db.transaction(async (tx) => {
      const ids = [sender.id, to.id].sort()
      const locked = await tx.select().from(users).where(inArray(users.id, ids)).orderBy(asc(users.id)).for('update')
      const from = locked.find((u) => u.id === sender.id)
      const target = locked.find((u) => u.id === to.id)
      if (!from || from.status !== 'active') {
        throw new HttpError('ACCOUNT_SUSPENDED', 'This account is suspended. Send /paysupport to the bot for help.')
      }
      if (!target || target.status !== 'active') {
        throw new HttpError('INVALID_INPUT', 'That player cannot receive Raffs right now.', { to: 'Cannot receive Raffs' })
      }

      // A retry that waited on the lock behind its own first attempt: that attempt has
      // committed by now and spent the Raffs, so the checks below would refuse the retry
      const [earlier] = await tx
        .select({ id: raffsTransfers.id })
        .from(raffsTransfers)
        .where(and(eq(raffsTransfers.fromUserId, from.id), eq(raffsTransfers.idempotencyKey, body.idempotencyKey)))
      if (earlier) return { id: earlier.id, replayed: true }

      // The sender's row is locked, so this sum cannot change under us
      const dailyMax = await getSetting(tx, 'transfers.daily_max_raffs')
      const sentToday = await sentSince(tx, from.id, lagosDayStart(now))
      if (sentToday + body.raffs > dailyMax) {
        const left = Math.max(0, dailyMax - sentToday)
        throw new HttpError(
          'LIMIT_REACHED',
          left > 0
            ? `You can send up to ${dailyMax} Raffs a day; ${left} left today.`
            : `You have sent the most allowed today (${dailyMax} Raffs). Try again tomorrow.`,
          { raffs: `At most ${left}` },
        )
      }
      if (from.balanceCache < body.raffs) {
        throw new HttpError('INSUFFICIENT_FUNDS', `You have ${from.balanceCache} Raffs; you need ${body.raffs - from.balanceCache} more to send this.`)
      }

      const id = randomUUID()
      const out = await post(tx, {
        userId: from.id,
        type: 'transfer_out',
        raffs: -body.raffs,
        note: `Sent to @${target.username}`,
        referenceType: 'raffs_transfer',
        referenceId: id,
      })
      const credit = await post(tx, {
        userId: target.id,
        type: 'transfer_in',
        raffs: body.raffs,
        note: `From @${from.username}`,
        referenceType: 'raffs_transfer',
        referenceId: id,
      })
      const [row] = await tx
        .insert(raffsTransfers)
        .values({
          id,
          fromUserId: from.id,
          toUserId: target.id,
          raffs: body.raffs,
          note: body.note ?? '',
          idempotencyKey: body.idempotencyKey,
          outLedgerId: out.id,
          inLedgerId: credit.id,
        })
        .returning({ id: raffsTransfers.id })
      if (!row) throw new Error('transfer insert returned no row')
      return { id: row.id, replayed: false }
    })
  } catch (error) {
    // Two taps with one key raced past the replay check: return the winner's transfer
    if (uniqueViolation(error) === 'raffs_transfers_idempotency_key') {
      const winner = await findByKey(ctx, sender.id, body.idempotencyKey)
      if (winner) return winner
    }
    throw error
  }

  // The first attempt queued the message for a replayed transfer
  if (!made.replayed) await notifyRecipient(ctx, sender, to, body.raffs, body.note ?? '', made.id)
  const result = await findByKey(ctx, sender.id, body.idempotencyKey)
  if (!result) throw new Error(`transfer ${made.id} missing after commit`)
  return result
}

/**
 * "@ada sent you 20 Raffs", queued for the bot. The Raffs are already
 * credited, so a failure to queue is logged, never turned into an error the
 * sender would retry.
 */
async function notifyRecipient(ctx: AppContext, from: UserRow, to: UserRow, raffs: number, note: string, transferId: string) {
  const lines = [`<b>@${escapeHtml(from.username ?? 'a player')} sent you ${raffs} ${raffs === 1 ? 'Raff' : 'Raffs'}</b>`]
  if (note) lines.push(`"${escapeHtml(note)}"`)
  lines.push('They are already in your Raffle Win balance.')
  const button = openAppButton(ctx, 'Open my wallet', 'wallet')
  try {
    await enqueue(ctx.db, {
      userId: to.id,
      telegramId: to.telegramId,
      kind: 'transfer',
      text: lines.join('\n\n'),
      buttons: button ? [[button]] : null,
      dedupeKey: `transfer:${transferId}`,
    })
  } catch (error) {
    ctx.log.error({ err: error, transferId, toUserId: to.id }, 'transfer notification not queued')
  }
}

async function findByKey(ctx: AppContext, fromUserId: string, key: string): Promise<TransferResult | null> {
  const [row] = await ctx.db
    .select({ transfer: raffsTransfers, toUsername: users.username })
    .from(raffsTransfers)
    .innerJoin(users, eq(users.id, raffsTransfers.toUserId))
    .where(and(eq(raffsTransfers.fromUserId, fromUserId), eq(raffsTransfers.idempotencyKey, key)))
  if (!row) return null
  const [me] = await ctx.db.select({ balance: users.balanceCache }).from(users).where(eq(users.id, fromUserId))
  return {
    id: row.transfer.id,
    toUsername: row.toUsername ?? '',
    raffs: row.transfer.raffs,
    balance: me?.balance ?? 0,
    createdAt: row.transfer.createdAt.toISOString(),
  }
}
