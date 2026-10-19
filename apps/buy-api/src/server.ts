/**
 * Process entry point: config, database, logger, HTTP server, workers, clean shutdown.
 *   development:  pnpm --filter @instaplay/buy-api dev
 *   production:   node dist/server.js   (systemd, behind Apache)
 */
import { pino } from 'pino'
import { createApp } from './app'
import { loadConfig } from './config'
import type { AppContext } from './context'
import { createDb } from './db/client'
import { createMainApi } from './lib/main-api'
import { Paystack } from './lib/paystack'
import { startWorkers } from './services/worker'

const config = loadConfig()
const log = pino({
  level: config.LOG_LEVEL,
  base: { service: 'buy-api', env: config.NODE_ENV },
  redact: { paths: ['req.headers.cookie', 'req.headers["x-paystack-signature"]', 'res.headers["set-cookie"]'], censor: '[redacted]' },
  ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
})

const handle = createDb(config.DATABASE_URL)
const ctx: AppContext = {
  config,
  db: handle.db,
  log,
  now: Date.now,
  paystack: new Paystack(config.PAYSTACK_SECRET_KEY, config.PAYSTACK_API_URL),
  mainApi: createMainApi(config),
}
const app = createApp(ctx)

let stopWorkers: (() => Promise<void>) | null = null
const server = app.listen(config.PORT, config.HOST, () => {
  log.info(`listening on ${config.HOST}:${config.PORT} (${config.NODE_ENV}, commit ${config.GIT_COMMIT}, paystack ${config.PAYSTACK_SECRET_KEY.slice(0, 8)}...)`)
  if (config.WORKERS === 'on') stopWorkers = startWorkers(ctx)
})

function shutdown(signal: string) {
  log.info(`${signal}: closing`)
  const workersDone = (stopWorkers ? stopWorkers() : Promise.resolve()).catch((err: unknown) => log.error({ err }, 'stopping workers failed'))
  server.close((error) => {
    if (error) log.error({ err: error }, 'http server close failed')
    workersDone
      .then(() => handle.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
