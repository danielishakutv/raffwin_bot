/**
 * Data reset and player delete (super admin only).
 *
 *   reset          clears whole parts: players, raffles, finance, messages
 *                  ("everything" is all four), or test_money: finance minus
 *                  what players paid for (purchases and voucher redemptions
 *                  stay, each balance becomes what they bought). Admins, settings, feature
 *                  switches, rate history, the audit log and security events
 *                  are always kept.
 *   delete player  removes one player and everything that is theirs, so the
 *                  same Telegram account can sign up again as brand new.
 *
 * Both take a pg_dump first (RESET_BACKUP_DIR) and refuse to run without it,
 * so a wrong tap can be undone by restoring that file. The rows really go: the
 * guard triggers (migration 0018) let them through only inside a transaction
 * that sets raffwin.data_reset, which only this file does; the audit log and
 * security events stay protected even then. Each run writes its own audit row
 * with what it removed and where the backup is.
 */
import { spawn } from 'node:child_process'
import { open, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { sql, type SQL } from 'drizzle-orm'
import { resetPhrase, type ResetPart } from '@raffwin/shared/admin-schemas'
import type { AdminResetPreview, AdminResetResult } from '@raffwin/shared/admin-types'
import type { AppContext } from '../context'
import { HttpError } from '../lib/http-error'
import { forgetRaffles } from '../lib/shared-cache'
import type { Tx } from '../services/ledger'
import type { APPROVAL_ACTIONS } from '../db/schema'
import { appendAudit } from './audit'

type ApprovalAction = (typeof APPROVAL_ACTIONS)[number]

const DUMP_TIMEOUT_MS = 120_000

/* Backup ------------------------------------------------------------------ */

/** The copy taken before any wipe. A property so tests can stand in for pg_dump. */
export const backup = { take: dumpDatabase }

async function dumpDatabase(ctx: AppContext, what: string): Promise<string> {
  const dir = ctx.config.RESET_BACKUP_DIR
  if (!dir) throw new HttpError('NOT_READY', 'Resets are switched off on this server: no backup folder is set up. Nothing was changed.')
  const stamp = new Date(ctx.now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const file = join(dir, `${ctx.config.NODE_ENV}-before-${what}-${stamp}Z.dump`)
  // Written under another name and renamed once complete: a half-written copy never looks like a backup
  const partial = `${file}.partial`
  // The password goes in the environment, never on the command line where `ps` would show it
  const url = new URL(ctx.config.DATABASE_URL)
  const password = decodeURIComponent(url.password)
  url.password = ''
  // Every player's data is in this file: created readable by the service user only, before a byte is written
  const out = await open(partial, 'wx', 0o600)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ctx.config.PG_DUMP_BIN, ['--format=custom', '--no-owner', `--dbname=${url.toString()}`], {
        env: { ...process.env, PGPASSWORD: password },
        stdio: ['ignore', out.fd, 'pipe'],
      })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000)
      })
      const timer = setTimeout(() => child.kill('SIGTERM'), DUMP_TIMEOUT_MS)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`pg_dump ${signal ? `stopped by ${signal}` : `exited with ${code}`}: ${stderr.trim() || 'no message'}`))
      })
    })
  } finally {
    await out.close()
  }
  const { size } = await stat(partial)
  if (size === 0) throw new Error('pg_dump wrote an empty file')
  await rename(partial, file)
  return file
}

async function takeBackup(ctx: AppContext, what: string): Promise<string> {
  try {
    return await backup.take(ctx, what)
  } catch (error) {
    if (error instanceof HttpError) throw error
    ctx.log.error({ err: error, what }, 'backup before a data reset failed; nothing was changed')
    throw new HttpError('SERVER_ERROR', 'The backup taken before every reset failed, so nothing was changed. The server log has the reason.')
  }
}

/* Helpers ----------------------------------------------------------------- */

const rows = async (tx: Tx, statement: SQL): Promise<number> => (await tx.execute(statement)).rowCount ?? 0

/** Releases the guard triggers for this transaction only (migration 0018) */
async function openGuards(tx: Tx): Promise<void> {
  await tx.execute(sql`set local raffwin.data_reset = 'on'`)
}

/** Pending approvals that act on each part; a rate or sales change is about none of them */
const APPROVALS_OF: Record<ResetPart, ApprovalAction[]> = {
  players: ['balance_adjustment', 'balance_adjustment_bulk'],
  raffles: ['raffle_cancel', 'raffle_delete'],
  finance: ['balance_adjustment', 'balance_adjustment_bulk', 'voucher_batch_create'],
  test_money: ['balance_adjustment', 'balance_adjustment_bulk'],
  messages: [],
}

/** Pending approvals whose subject is about to disappear can never run; they end as failed, kept for the record */
async function failPending(tx: Tx, at: Date, which: { actions: ApprovalAction[] } | { mention: string }): Promise<number> {
  const result = {
    error: 'Cancelled: the data it was about was removed by a data reset.',
  }
  if ('actions' in which && !which.actions.length) return 0
  const scope =
    'actions' in which
      ? sql`action in (${sql.join(
          [...new Set(which.actions)].map((a) => sql`${a}`),
          sql`, `,
        )})`
      : sql`payload::text like ${`%${which.mention}%`}`
  return rows(tx, sql`update approvals set status = 'failed', decided_at = ${at}, result = ${JSON.stringify(result)}::jsonb where status = 'pending' and ${scope}`)
}

/** Raffs a player paid real money for: kept by test_money */
const PAID_FOR = sql`('purchase', 'voucher')`

/** Raffle photos uploaded to the media table are referenced by URL (/v1/media/<id>) */
const MEDIA_ID = sql`substring(image_url from '/v1/media/([0-9a-fA-F-]{36})')::uuid`

/* Preview ----------------------------------------------------------------- */

export async function resetPreview(ctx: AppContext): Promise<AdminResetPreview> {
  const count = async (statement: SQL) => Number(((await ctx.db.execute(statement)).rows[0] as { n: string | number } | undefined)?.n ?? 0)
  const env = ctx.config.NODE_ENV
  return {
    available: !!ctx.config.RESET_BACKUP_DIR,
    phrase: resetPhrase(env),
    env,
    counts: {
      players: await count(sql`select count(*) as n from users`),
      raffles: await count(sql`select count(*) as n from raffles`),
      entries: await count(sql`select count(*) as n from entries`),
      ledgerLines: await count(sql`select count(*) as n from ledger`),
      raffsInBalances: await count(sql`select coalesce(sum(balance_cache), 0) as n from users`),
      testMoneyLines: await count(sql`select count(*) as n from ledger where type not in ${PAID_FOR}`),
      raffsPaidFor: await count(sql`select coalesce(sum(raffs), 0) as n from ledger where type in ${PAID_FOR}`),
      purchases: await count(sql`select count(*) as n from purchases`),
      vouchers: await count(sql`select count(*) as n from vouchers`),
      expenses: await count(sql`select count(*) as n from finance_expenses`),
      transfers: await count(sql`select count(*) as n from raffs_transfers`),
      broadcasts: await count(sql`select count(*) as n from broadcasts`),
      notifications: await count(sql`select count(*) as n from notifications`),
    },
  }
}

/* Reset ------------------------------------------------------------------- */

export interface ResetInput {
  parts: ResetPart[]
  confirm: string
  reason: string
}

export async function resetData(ctx: AppContext, adminId: string, input: ResetInput, ipHash: string | null): Promise<AdminResetResult> {
  const phrase = resetPhrase(ctx.config.NODE_ENV)
  if (input.confirm !== phrase)
    throw new HttpError('INVALID_INPUT', `Type ${phrase} exactly to confirm.`, {
      confirm: `Type ${phrase}`,
    })
  const parts = new Set(input.parts)
  const P = parts.has('players')
  const R = parts.has('raffles')
  const F = parts.has('finance')
  const M = parts.has('messages')
  // Finance and players already clear every Raffs record
  const T = parts.has('test_money') && !F && !P
  const before = await resetPreview(ctx)
  const backupFile = await takeBackup(ctx, 'reset')
  const at = new Date(ctx.now())
  const deleted: Record<string, number> = {}
  const updated: Record<string, number> = {}

  await ctx.db.transaction(async (tx) => {
    await openGuards(tx)
    // Nobody enters, pays or signs up halfway through
    await tx.execute(sql`lock table users, raffles, entries, ledger in exclusive mode`)

    updated.approvals = await failPending(tx, at, {
      actions: [...parts].flatMap((p) => APPROVALS_OF[p]),
    })

    // Messages and reminders (reminders point at raffles and at broadcasts)
    if (R) deleted.raffle_reminders = await rows(tx, sql`delete from raffle_reminders`)
    else if (M) updated.raffle_reminders = await rows(tx, sql`update raffle_reminders set broadcast_id = null where broadcast_id is not null`)
    // Every notification is addressed to a player
    if (M || P) deleted.notifications = await rows(tx, sql`delete from notifications`)
    if (M) deleted.broadcasts = await rows(tx, sql`delete from broadcasts`)

    // Money records, children before the ledger lines they point at
    if (P || R || F || T) deleted.referral_earnings = await rows(tx, sql`delete from referral_earnings`)
    if (P || F || T) {
      deleted.raffs_transfers = await rows(tx, sql`delete from raffs_transfers`)
      if (!T) deleted.purchases = await rows(tx, sql`delete from purchases`)
      deleted.comeback_offers = await rows(tx, sql`delete from comeback_offers`)
      deleted.daily_checkins = await rows(tx, sql`delete from daily_checkins`)
    }
    if (F) {
      deleted.vouchers = await rows(tx, sql`delete from vouchers`)
      deleted.voucher_batches = await rows(tx, sql`delete from voucher_batches`)
      deleted.finance_expenses = await rows(tx, sql`delete from finance_expenses`)
    } else if (P) {
      // A code that was used stays used, so a sold voucher can never pay out twice
      updated.vouchers = await rows(tx, sql`update vouchers set redeemed_by_user_id = null, ledger_id = null where redeemed_by_user_id is not null or ledger_id is not null`)
    }
    if (R && !F) updated.finance_expenses = await rows(tx, sql`update finance_expenses set raffle_id = null where raffle_id is not null`)

    if (P || F) deleted.ledger = await rows(tx, sql`delete from ledger`)
    else if (T) deleted.ledger = await rows(tx, sql`delete from ledger where type not in ${PAID_FOR}`)
    else if (R) deleted.ledger = await rows(tx, sql`delete from ledger where reference_type in ('entry', 'raffle_prize')`)

    if (P) deleted.feature_flag_overrides = await rows(tx, sql`delete from feature_flag_overrides where user_id is not null`)

    // Raffles and tickets
    if (P || R) deleted.entries = await rows(tx, sql`delete from entries`)
    if (R) {
      const photos = (await tx.execute(sql`select distinct ${MEDIA_ID} as id from raffles where image_url ~ '/v1/media/'`)).rows
        .map((r) => (r as { id: string | null }).id)
        .filter((id): id is string => !!id)
      deleted.raffle_prizes = await rows(tx, sql`delete from raffle_prizes`)
      await tx.execute(sql`update raffles set copied_from_raffle_id = null where copied_from_raffle_id is not null`)
      deleted.raffles = await rows(tx, sql`delete from raffles`)
      deleted.media = photos.length
        ? await rows(
            tx,
            sql`delete from media where id in (${sql.join(
              photos.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`,
          )
        : 0
    } else if (P) {
      updated.raffle_prizes = await rows(tx, sql`update raffle_prizes set winner_user_id = null where winner_user_id is not null`)
      // Raffles not drawn yet start again from ticket 1
      updated.raffles = await rows(tx, sql`update raffles set entries_count = 0, updated_at = now() where status in ('draft', 'open', 'drawing') and entries_count <> 0`)
    }

    // Players last: everything above pointed at them
    if (P) {
      deleted.sessions = await rows(tx, sql`delete from sessions`)
      deleted.addresses = await rows(tx, sql`delete from addresses`)
      deleted.delivery_points = await rows(tx, sql`delete from delivery_points`)
      deleted.referral_hints = await rows(tx, sql`delete from referral_hints`)
      await tx.execute(sql`update users set referred_by_user_id = null where referred_by_user_id is not null`)
      deleted.users = await rows(tx, sql`delete from users`)
    } else if (F) {
      updated.balances = await rows(tx, sql`update users set balance_cache = 0, updated_at = now() where balance_cache <> 0`)
    } else if (R || T) {
      // Balances as if what was removed had never been: what the remaining lines add up to
      updated.balances = await rebuildBalances(tx)
    }

    await appendAudit(tx, {
      adminId,
      action: 'data.reset',
      targetType: 'system',
      targetId: [...parts].sort().join(','),
      before: { counts: before.counts, reason: input.reason },
      after: { backupFile, deleted, updated },
      ipHash,
    })
  })
  forgetRaffles(ctx.cache)
  ctx.log.warn({ adminId, parts: [...parts], backupFile, deleted }, 'data reset')
  return { backupFile, deleted, updated }
}

/** balance_cache = SUM(ledger) per player, and every line's balance_after re-run in order */
async function rebuildBalances(tx: Tx): Promise<number> {
  const changed = await rows(
    tx,
    sql`update users u set balance_cache = s.total, updated_at = now()
        from (select u2.id, coalesce(sum(l.raffs), 0)::int as total from users u2 left join ledger l on l.user_id = u2.id group by u2.id) s
        where s.id = u.id and u.balance_cache <> s.total`,
  )
  await tx.execute(
    sql`update ledger l set balance_after = s.running
        from (select id, (sum(raffs) over (partition by user_id order by created_at, id))::int as running from ledger) s
        where s.id = l.id and l.balance_after <> s.running`,
  )
  return changed
}

/* One player -------------------------------------------------------------- */

export interface DeletePlayerInput {
  confirm: string
  reason: string
}

/** What must be typed to delete this player: the username, or the Telegram id when they never chose one */
export const playerConfirmation = (u: { username: string | null; telegramId: number }) => u.username ?? String(u.telegramId)

export async function deletePlayer(ctx: AppContext, adminId: string, userId: string, input: DeletePlayerInput, ipHash: string | null): Promise<AdminResetResult> {
  const found = (await ctx.db.execute(sql`select id, telegram_id, username, tg_username, balance_cache from users where id = ${userId}`)).rows[0] as
    | {
        id: string
        telegram_id: string | number
        username: string | null
        tg_username: string | null
        balance_cache: number
      }
    | undefined
  if (!found) throw new HttpError('NOT_FOUND', 'No such player.')
  const telegramId = Number(found.telegram_id)
  const expected = playerConfirmation({ username: found.username, telegramId })
  if (input.confirm.replace(/^@/, '').toLowerCase() !== expected.toLowerCase()) {
    throw new HttpError('INVALID_INPUT', `Type ${expected} exactly to confirm.`, { confirm: `Type ${expected}` })
  }
  const backupFile = await takeBackup(ctx, 'player-delete')
  const at = new Date(ctx.now())
  const deleted: Record<string, number> = {}
  const updated: Record<string, number> = {}

  await ctx.db.transaction(async (tx) => {
    await openGuards(tx)
    const locked = await rows(tx, sql`select 1 from users where id = ${userId} for update`)
    if (!locked) throw new HttpError('NOT_FOUND', 'No such player.')
    // Raffles they hold tickets in and that are not drawn yet: locked like an entry would, then renumbered
    const open = (
      await tx.execute(
        sql`select r.id from raffles r where r.status in ('draft', 'open', 'drawing') and exists (select 1 from entries e where e.raffle_id = r.id and e.user_id = ${userId})
            order by r.id for update`,
      )
    ).rows.map((r) => (r as { id: string }).id)
    const held = (await tx.execute(sql`select count(*)::int as entries, coalesce(sum(qty), 0)::int as tickets from entries where user_id = ${userId}`)).rows[0] as {
      entries: number
      tickets: number
    }

    updated.approvals = await failPending(tx, at, { mention: userId })
    deleted.notifications = await rows(tx, sql`delete from notifications where user_id = ${userId}`)
    deleted.referral_earnings = await rows(tx, sql`delete from referral_earnings where referrer_user_id = ${userId} or referred_user_id = ${userId}`)
    deleted.raffs_transfers = await rows(tx, sql`delete from raffs_transfers where from_user_id = ${userId} or to_user_id = ${userId}`)
    deleted.purchases = await rows(tx, sql`delete from purchases where user_id = ${userId}`)
    updated.vouchers = await rows(tx, sql`update vouchers set redeemed_by_user_id = null, ledger_id = null where redeemed_by_user_id = ${userId}`)
    deleted.comeback_offers = await rows(tx, sql`delete from comeback_offers where user_id = ${userId}`)
    deleted.daily_checkins = await rows(tx, sql`delete from daily_checkins where user_id = ${userId}`)
    deleted.feature_flag_overrides = await rows(tx, sql`delete from feature_flag_overrides where user_id = ${userId}`)
    // A prize they won stays drawn, with no winner to show
    updated.raffle_prizes = await rows(tx, sql`update raffle_prizes set winner_user_id = null where winner_user_id = ${userId}`)
    deleted.entries = await rows(tx, sql`delete from entries where user_id = ${userId}`)
    updated.tickets = 0
    for (const raffleId of open) updated.tickets += await renumber(tx, raffleId)
    deleted.ledger = await rows(tx, sql`delete from ledger where user_id = ${userId}`)
    deleted.sessions = await rows(tx, sql`delete from sessions where user_id = ${userId}`)
    deleted.addresses = await rows(tx, sql`delete from addresses where user_id = ${userId}`)
    deleted.delivery_points = await rows(tx, sql`delete from delivery_points where user_id = ${userId}`)
    deleted.referral_hints = await rows(tx, sql`delete from referral_hints where telegram_id = ${telegramId}`)
    updated.referred_players = await rows(tx, sql`update users set referred_by_user_id = null, referred_at = null where referred_by_user_id = ${userId}`)
    deleted.users = await rows(tx, sql`delete from users where id = ${userId}`)

    await appendAudit(tx, {
      adminId,
      action: 'user.delete',
      targetType: 'user',
      targetId: userId,
      // Who it was, for the record; their profile and contact details are not copied here
      before: {
        telegramId,
        username: found.username,
        tgUsername: found.tg_username,
        balance: found.balance_cache,
        ...held,
        reason: input.reason,
      },
      after: { backupFile, deleted, updated },
      ipHash,
    })
  })
  forgetRaffles(ctx.cache)
  ctx.log.warn({ adminId, userId, backupFile, deleted }, 'player deleted')
  return { backupFile, deleted, updated }
}

/**
 * Tickets of a raffle not drawn yet, renumbered 1..n in their original order
 * after a player's tickets left it, and entries_count set to n. The draw
 * picks from 1..entries_count, so a gap would point at nobody.
 */
async function renumber(tx: Tx, raffleId: string): Promise<number> {
  // Out of the way first: (raffle, ticket_from) is unique and checked row by row
  await tx.execute(sql`update entries set ticket_from = ticket_from + 1000000000, ticket_to = ticket_to + 1000000000 where raffle_id = ${raffleId}`)
  const changed = await rows(
    tx,
    sql`update entries e set ticket_from = n.upto - e.qty + 1, ticket_to = n.upto
        from (select id, (sum(qty) over (order by ticket_from, id))::int as upto from entries where raffle_id = ${raffleId}) n
        where n.id = e.id`,
  )
  await tx.execute(sql`update raffles set entries_count = coalesce((select sum(qty) from entries where raffle_id = ${raffleId}), 0), updated_at = now() where id = ${raffleId}`)
  return changed
}
