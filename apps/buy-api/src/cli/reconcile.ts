/**
 * Reconciliation by hand, for any window:
 *   node dist/reconcile.js 2026-10-01 2026-10-19     (Lagos days, the second one excluded)
 *   node dist/reconcile.js                           (yesterday and the day before)
 * Prints what it saw, recovered and flagged. Safe to run any number of times.
 */
import { pino } from 'pino'
import { loadConfig } from '../config'
import type { AppContext } from '../context'
import { createDb } from '../db/client'
import { createMainApi } from '../lib/main-api'
import { Paystack } from '../lib/paystack'
import { lagos, lagosMidnight } from '../lib/util'
import { deliverCredits } from '../services/outbox'
import { reconcile } from '../services/reconcile'

const config = loadConfig()
const log = pino({ level: 'info', base: { service: 'buy-reconcile' } })
const handle = createDb(config.DATABASE_URL, { max: 2 })
const ctx: AppContext = { config, db: handle.db, log, now: Date.now, paystack: new Paystack(config.PAYSTACK_SECRET_KEY, config.PAYSTACK_API_URL), mainApi: createMainApi(config) }

const [fromDay, toDay] = process.argv.slice(2)
const day = /^\d{4}-\d{2}-\d{2}$/
if ((fromDay && !day.test(fromDay)) || (toDay && !day.test(toDay))) {
  console.error('usage: reconcile [YYYY-MM-DD from] [YYYY-MM-DD to]')
  process.exit(2)
}
const today = lagos(Date.now()).day
const from = new Date(lagosMidnight(fromDay ?? today) - (fromDay ? 0 : 2 * 86_400_000))
const to = new Date(toDay ? lagosMidnight(toDay) : lagosMidnight(today))

reconcile(ctx, from, to, null)
  .then(async (r) => {
    console.log(`seen ${r.seen}, recovered ${r.recovered}, flagged ${r.flagged}`)
    const sent = await deliverCredits(ctx, 200)
    console.log(`credits delivered ${sent.delivered}, refused ${sent.refused}, still retrying ${sent.retrying}`)
  })
  .catch((error: unknown) => {
    console.error('reconciliation failed:', (error as Error).message)
    process.exitCode = 1
  })
  .finally(() => handle.close())
