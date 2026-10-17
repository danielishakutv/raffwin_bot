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
import type { InlineKeyboardButton } from 'grammy/types'
import type { AppContext, SendTelegram } from './context'
import type { NotificationButton } from './db/schema'
import { AccessTokens } from './lib/access-token'
import { startWorkers } from './services/worker'

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
// A hung Telegram call must not hold the outbox sender's transaction (and its advisory lock) for minutes
const botApi = new Api(config.BOT_TOKEN, { timeoutSeconds: 15 })

function toInlineButton(b: NotificationButton): InlineKeyboardButton {
  if (b.webApp) return { text: b.text, web_app: { url: b.webApp } }
  return { text: b.text, callback_data: b.callbackData ?? b.text }
}

/** Rejects with grammY's GrammyError (error_code, description, parameters) for the outbox to classify. */
const sendTelegram: SendTelegram = async (chatId, text, opts = {}) => {
  const message = await botApi.sendMessage(chatId, text, {
    parse_mode: opts.html ? 'HTML' : undefined,
    reply_markup: opts.buttons?.length ? { inline_keyboard: opts.buttons.map((row) => row.map(toInlineButton)) } : undefined,
    disable_notification: opts.silent,
    link_preview_options: { is_disabled: true },
  })
  return { messageId: message.message_id }
}

const ctx: AppContext = {
  config,
  db: handle.db,
  log,
  tokens: new AccessTokens(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS),
  now: Date.now,
  sendTelegram,
}
const app = createApp(ctx)

let stopWorkers: (() => Promise<void>) | null = null
const server = app.listen(config.PORT, config.HOST, () => {
  log.info(`listening on http://${config.HOST}:${config.PORT} (${config.NODE_ENV}, commit ${config.GIT_COMMIT})`)
  if (config.WORKERS === 'on') stopWorkers = startWorkers(ctx)
  else log.info('WORKERS=off: this process sends no bot messages and runs no scheduler')
})

function shutdown(signal: string) {
  log.info(`${signal}: closing`)
  // Workers finish their tick (no message left half-recorded) before the pool closes
  const workersDone = (stopWorkers ? stopWorkers() : Promise.resolve()).catch((err: unknown) =>
    log.error({ err }, 'stopping workers failed'),
  )
  server.close((error) => {
    if (error) log.error({ err: error }, 'http server close failed')
    workersDone
      .then(() => handle.close())
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
