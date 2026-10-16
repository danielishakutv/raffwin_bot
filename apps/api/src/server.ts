/**
 * Process entry point: config, database, logger, HTTP server, clean shutdown.
 *   development:  pnpm --filter @raffwin/api dev
 *   production:   node dist/server.js   (PM2 cluster, behind Apache)
 */
import { pino } from 'pino'
import { createApp } from './app'
import { loadConfig } from './config'
import { createDb } from './db/client'
import { Api } from 'grammy'
import { AccessTokens } from './lib/access-token'

const config = loadConfig()
const log = pino({
  level: config.LOG_LEVEL,
  base: { service: 'raffwin-api', env: config.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.initData',
      'req.body.refreshToken',
      'req.body.contactProof',
    ],
    censor: '[redacted]',
  },
  ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
})

const handle = createDb(config.DATABASE_URL)
const botApi = new Api(config.BOT_TOKEN)
const app = createApp({
  config,
  db: handle.db,
  log,
  tokens: new AccessTokens(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS),
  now: Date.now,
  sendTelegram: async (chatId, text) => {
    await botApi.sendMessage(chatId, text)
  },
})

const server = app.listen(config.PORT, config.HOST, () => {
  log.info(`listening on http://${config.HOST}:${config.PORT} (${config.NODE_ENV}, commit ${config.GIT_COMMIT})`)
})

function shutdown(signal: string) {
  log.info(`${signal}: closing`)
  server.close((error) => {
    if (error) log.error({ err: error }, 'http server close failed')
    handle
      .close()
      .catch((err: unknown) => log.error({ err }, 'database pool close failed'))
      .finally(() => process.exit(error ? 1 : 0))
  })
  // PM2 sends SIGKILL after its own timeout; leave before that with a reason in the log
  setTimeout(() => {
    log.error('shutdown took longer than 10s, exiting')
    process.exit(1)
  }, 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
