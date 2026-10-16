/**
 * Raffle Win bot (grammY). Minimal by design for the demo phase:
 * no database, no backend calls, just the entry points into the Mini App.
 *
 * The same code serves both environments; only BOT_WEBAPP_URL changes.
 */
import { Bot, InlineKeyboard } from 'grammy'

export interface BotConfig {
  token: string
  webAppUrl: string
  env: string
}

export function readConfig(): BotConfig {
  const token = process.env.BOT_TOKEN?.trim()
  const webAppUrl = process.env.BOT_WEBAPP_URL?.trim()
  if (!token) throw new Error('BOT_TOKEN is not set. Get one from @BotFather and put it in bot/.env')
  if (!webAppUrl || !webAppUrl.startsWith('https://')) {
    throw new Error('BOT_WEBAPP_URL must be an https:// URL (Telegram only opens Mini Apps over HTTPS)')
  }
  return { token, webAppUrl, env: process.env.BOT_ENV?.trim() || 'production' }
}

export function createBot(config: BotConfig): Bot {
  const bot = new Bot(config.token)
  const openButton = () => new InlineKeyboard().webApp('Open Raffle Win', config.webAppUrl)
  const envNote = config.env === 'production' ? '' : `\n\n<i>Environment: ${escapeHtml(config.env)}</i>`

  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name ? escapeHtml(ctx.from.first_name) : 'there'
    await ctx.reply(
      [
        `<b>Welcome to Raffle Win, ${name}!</b>`,
        '',
        'Buy Raffs with Naira, enter raffles for phones, laptops, TVs and cash, and watch the draw happen live.',
        'Every raffle has three winners.',
        '',
        'Tap the button below to open the app.',
        envNote,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: openButton() },
    )
  })

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        '<b>Raffle Win commands</b>',
        '',
        '/start - open the app',
        '/rules - how draws work, in short',
        '/help - this message',
        '',
        'Raffle Win is a Telegram Mini App: create your account, fund it with Raffs, enter raffles and track your entries and wins, all inside Telegram.',
        envNote,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: openButton() },
    )
  })

  bot.command('rules', async (ctx) => {
    await ctx.reply(
      [
        '<b>Rules in short</b>',
        '',
        '1. You must be 18+ and resident in Nigeria. One account per person.',
        '2. Raffles are entered with Raffs, bought at the rate shown in the app (locked for one hour at a time).',
        '3. Every raffle has a deadline. The draw happens at that exact moment and entries close then.',
        '4. One draw per raffle, three winners picked at random: 1st, 2nd and 3rd place, each with its own prize.',
        '5. Winners confirm their details within 7 days. Prizes need a verified identity and a delivery address.',
        '',
        'The full rules are in the app under onboarding.',
        envNote,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: openButton() },
    )
  })

  // Anything else: point people at the app rather than staying silent.
  bot.on('message', async (ctx) => {
    await ctx.reply('Open Raffle Win to enter raffles, or send /help for the commands.', { reply_markup: openButton() })
  })

  bot.catch((err) => {
    console.error('[bot] update failed', err.error)
  })

  return bot
}

export async function registerCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Open Raffle Win' },
    { command: 'rules', description: 'How the draws work' },
    { command: 'help', description: 'Commands and what the app does' },
  ])
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
