/**
 * Registers (or removes) the webhook with Telegram and publishes the command list.
 *   npm run set-webhook      -> uses WEBHOOK_URL (+ optional WEBHOOK_SECRET)
 *   npm run delete-webhook   -> back to polling
 */
import { createBot, readConfig, registerCommands } from './bot.js'
import { loadDotEnv } from './env.js'

loadDotEnv()

const config = readConfig()
const bot = createBot(config)

if (process.argv.includes('--delete')) {
  await bot.api.deleteWebhook()
  console.log('[bot] webhook removed')
} else {
  const url = process.env.WEBHOOK_URL?.trim()
  if (!url || !url.startsWith('https://')) throw new Error('WEBHOOK_URL must be the public https:// URL of the deployed bot')
  const secret = process.env.WEBHOOK_SECRET?.trim() || undefined
  await bot.api.setWebhook(url, { secret_token: secret, drop_pending_updates: true })
  await registerCommands(bot)
  const info = await bot.api.getWebhookInfo()
  console.log(`[bot] webhook set: ${info.url} (pending: ${info.pending_update_count})`)
}
