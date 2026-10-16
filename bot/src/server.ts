/**
 * Webhook runner for Render / Railway / any Node host:
 *   cd bot && npm run build && npm run start:webhook
 * Exposes POST /api/webhook for Telegram and GET /health for the host.
 * Register the URL once with `npm run set-webhook`.
 */
import { createServer } from 'node:http'
import { webhookCallback } from 'grammy'
import { createBot, readConfig } from './bot.js'
import { loadDotEnv } from './env.js'

loadDotEnv()

const config = readConfig()
const bot = createBot(config)
const secret = process.env.WEBHOOK_SECRET?.trim() || undefined
const handleUpdate = webhookCallback(bot, 'http', { secretToken: secret })
const port = Number(process.env.PORT) || 3000

const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, env: config.env }))
    return
  }
  if (req.method === 'POST' && req.url === '/api/webhook') {
    handleUpdate(req, res).catch((error: unknown) => {
      console.error('[bot] webhook error', error)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(port, () => {
  console.log(`[bot] webhook server on :${port} (POST /api/webhook). Mini App -> ${config.webAppUrl} (${config.env})`)
})
