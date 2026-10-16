/**
 * Long-polling runner for local testing:  cd bot && npm run dev
 * Deletes any webhook first, because Telegram refuses polling while one is set.
 */
import { createBot, readConfig, registerCommands } from './bot.js'
import { loadDotEnv } from './env.js'

loadDotEnv()

const config = readConfig()
const bot = createBot(config)

await bot.api.deleteWebhook({ drop_pending_updates: false })
await registerCommands(bot)

const me = await bot.api.getMe()
console.log(`[bot] @${me.username} polling. Mini App -> ${config.webAppUrl} (${config.env})`)

const stop = () => {
  console.log('[bot] stopping')
  void bot.stop()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

await bot.start()
