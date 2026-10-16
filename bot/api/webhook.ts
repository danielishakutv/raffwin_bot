/**
 * Vercel serverless entry (deploy the /bot folder as its own Vercel project).
 * Telegram POSTs updates here; set the webhook to https://<project>.vercel.app/api/webhook
 */
import { webhookCallback } from 'grammy'
import { createBot, readConfig } from '../src/bot.js'

const bot = createBot(readConfig())

export default webhookCallback(bot, 'http', {
  secretToken: process.env.WEBHOOK_SECRET?.trim() || undefined,
})
