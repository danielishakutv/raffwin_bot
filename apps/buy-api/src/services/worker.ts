/**
 * Background loops in the API process (WORKERS=on):
 *
 *   credits    every 5 s     deliver due credits to the main API (outbox.ts)
 *   flags      every 15 s    report due flags to the main API (flags.ts)
 *   reconcile  every 10 min  run yesterday's reconciliation once it is due
 *
 * Each loop waits for its own tick to finish before scheduling the next, and
 * a failing tick is logged and tried again; it never stops the loop.
 */
import type { AppContext } from '../context'
import { reportFlags } from './flags'
import { deliverCredits } from './outbox'
import { reconcileIfDue } from './reconcile'

function loop(ctx: AppContext, name: string, everyMs: number, tick: () => Promise<unknown>) {
  let timer: NodeJS.Timeout | null = null
  let running: Promise<void> | null = null
  let stopped = false
  const run = () => {
    running = tick()
      .then(() => undefined)
      .catch((error: unknown) => ctx.log.error({ err: error, worker: name }, 'worker tick failed'))
      .finally(() => {
        running = null
        if (!stopped) timer = setTimeout(run, everyMs)
      })
  }
  timer = setTimeout(run, 1_000)
  return async () => {
    stopped = true
    if (timer) clearTimeout(timer)
    await running
  }
}

export function startWorkers(ctx: AppContext): () => Promise<void> {
  const stops = [
    loop(ctx, 'credits', 5_000, () => deliverCredits(ctx)),
    loop(ctx, 'flags', 15_000, () => reportFlags(ctx)),
    loop(ctx, 'reconcile', 10 * 60_000, () => reconcileIfDue(ctx)),
  ]
  ctx.log.info('workers started: credits, flags, reconcile')
  return async () => {
    await Promise.all(stops.map((s) => s()))
  }
}

/** After a webhook or a return visit: deliver at once instead of waiting for the next tick */
let kicking: Promise<unknown> | null = null
export function kickCredits(ctx: AppContext): Promise<unknown> {
  kicking ??= deliverCredits(ctx)
    .catch((error: unknown) => ctx.log.error({ err: error }, 'immediate credit delivery failed; the worker retries'))
    .finally(() => {
      kicking = null
    })
  return kicking
}
