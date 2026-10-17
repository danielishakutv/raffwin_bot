/**
 * Background loops inside the API process (no separate service to deploy):
 *
 *   sender     every 1.5 s  the outbox -> Telegram (notify.sendPendingOnce)
 *   scheduler  every 60 s   broadcast fan-out, then reminders and come-back
 *                           offers (engagement.runEngagementOnce)
 *
 * PM2 may run several API processes, and every one starts these loops. Each
 * tick first takes a Postgres advisory lock (held by a transaction for the
 * length of the tick); a process that cannot get it skips that tick, so two
 * processes never work the same loop at once. A failed tick is logged and the
 * loop carries on. Tests never start the loops: they call the *Once functions.
 */
import { sql } from 'drizzle-orm'
import type { AppContext } from '../context'
import { runEngagementOnce } from './engagement'
import { fanOutOnce, sendPendingOnce } from './notify'

/** Advisory lock keys, one per loop (admin/audit.ts uses 727_001) */
const SENDER_LOCK_KEY = 727_101
const SCHEDULER_LOCK_KEY = 727_102

const SENDER_INTERVAL_MS = 1_500
const SCHEDULER_INTERVAL_MS = 60_000

/**
 * Runs `work` only if this process gets the lock. The lock lives as long as
 * the surrounding transaction, which holds one pooled connection while the
 * work itself runs on others (its own queries and transactions).
 */
async function withLoopLock(ctx: AppContext, key: number, work: () => Promise<void>): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const result = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(${key}) as locked`)
    if (!result.rows[0]?.locked) return false
    await work()
    return true
  })
}

interface Loop {
  stop(): Promise<void>
}

function startLoop(ctx: AppContext, name: string, key: number, intervalMs: number, tick: () => Promise<void>): Loop {
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let running: Promise<void> | null = null

  const run = async () => {
    try {
      await withLoopLock(ctx, key, tick)
    } catch (error) {
      ctx.log.error({ err: error, worker: name }, 'worker tick failed')
    }
  }
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      running = run().finally(() => {
        running = null
        schedule()
      })
    }, intervalMs)
    // The HTTP server keeps the process alive; a worker alone never should
    timer.unref()
  }
  schedule()

  return {
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      // Let a tick in flight finish, so no claimed message is left half-recorded
      if (running) await running
    },
  }
}

/** Starts the sender and the scheduler. Returns a function that stops both (await it before closing the pool). */
export function startWorkers(ctx: AppContext): () => Promise<void> {
  const sender = startLoop(ctx, 'sender', SENDER_LOCK_KEY, SENDER_INTERVAL_MS, async () => {
    const counts = await sendPendingOnce(ctx)
    if (counts.sent || counts.failed || counts.retried || counts.skipped) ctx.log.info({ worker: 'sender', ...counts }, 'outbox pass')
  })

  const scheduler = startLoop(ctx, 'scheduler', SCHEDULER_LOCK_KEY, SCHEDULER_INTERVAL_MS, async () => {
    // Each step on its own: a broken fan-out must not stop reminders, nor the other way round
    try {
      const fan = await fanOutOnce(ctx)
      if (fan.queued || fan.finished) ctx.log.info({ worker: 'scheduler', ...fan }, 'broadcast fan-out')
    } catch (error) {
      ctx.log.error({ err: error, worker: 'scheduler', step: 'fanOut' }, 'broadcast fan-out failed')
    }
    try {
      await runEngagementOnce(ctx)
    } catch (error) {
      ctx.log.error({ err: error, worker: 'scheduler', step: 'engagement' }, 'engagement pass failed')
    }
  })

  ctx.log.info('workers started (outbox sender, scheduler)')
  return async () => {
    await Promise.all([sender.stop(), scheduler.stop()])
    ctx.log.info('workers stopped')
  }
}
