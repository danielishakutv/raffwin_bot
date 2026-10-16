/**
 * Points the bot at this deployment: commands, the "Open" menu button and the
 * webhook (with its secret). Run once per environment after deploying:
 *
 *   node --env-file=.env dist/setup-bot.js
 *
 * Reads BOT_TOKEN, PUBLIC_APP_URL and TELEGRAM_WEBHOOK_SECRET from the env
 * file; prints what Telegram reports back, never the token.
 */
import { pino } from 'pino'
import { createBot, configureBot } from '../bot/bot'
import { loadConfig } from '../config'

async function main() {
  const config = loadConfig()
  if (!config.PUBLIC_APP_URL || !config.TELEGRAM_WEBHOOK_SECRET) {
    console.error('PUBLIC_APP_URL and TELEGRAM_WEBHOOK_SECRET must be set in the env file.')
    process.exit(2)
  }
  const appUrl = config.PUBLIC_APP_URL
  const webhookUrl = new URL('api/telegram/webhook', appUrl).toString()
  const bot = createBot({ token: config.BOT_TOKEN, appUrl, envLabel: config.NODE_ENV, log: pino({ level: 'warn' }) })
  const me = await bot.api.getMe()
  await configureBot(bot, { appUrl, webhookUrl, secret: config.TELEGRAM_WEBHOOK_SECRET })
  const info = await bot.api.getWebhookInfo()
  console.log(
    [
      `bot:            @${me.username}`,
      `menu button:    Open -> ${appUrl}`,
      `webhook:        ${info.url}`,
      `pending:        ${info.pending_update_count}`,
      `last error:     ${info.last_error_message ?? 'none'}`,
      '',
      'Still to do by hand in @BotFather (Bot Settings > Configure Mini App):',
      `  enable the Main Mini App with URL ${appUrl}`,
      '  so that referral links https://t.me/<bot>?startapp=ref_<code> open the app directly.',
    ].join('\n'),
  )
  if (me.username?.toLowerCase() !== config.BOT_USERNAME.toLowerCase()) {
    console.error(`\nWARNING: BOT_USERNAME is ${config.BOT_USERNAME} but the token belongs to @${me.username}.`)
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error('bot setup failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
