/**
 * The Telegram bot, served by the API as a webhook (no separate process).
 * It is the only door into Raffle Win: the Mini App opens from its menu
 * button and from the buttons below; referral links open the app directly
 * (https://t.me/<bot>?startapp=ref_<code>, which needs the bot's Main Mini
 * App set in BotFather).
 */
import { Bot, InlineKeyboard, type Transformer } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import type { Logger } from 'pino'
import { eq } from 'drizzle-orm'
import { parseStartParam } from '@raffwin/shared'
import type { AppContext } from '../context'
import { referralHints, users } from '../db/schema'
import { installAdminLogin } from './admin-login'

export interface BotOptions {
  token: string
  appUrl: string
  envLabel: string
  log: Logger
  /** When given, the hidden admin sign-in command is installed (needs the database) */
  app?: AppContext
  /** Tests only: skip getMe and intercept every Bot API call */
  testing?: { botInfo: UserFromGetMe; transformer: Transformer }
}

/**
 * `/start ref_<code>` (from a https://t.me/<bot>?start=ref_<code> invite) for
 * someone with no account yet: keep the code so their first open of the app is
 * bound to that referrer. First invite wins; an existing account is never re-bound.
 */
async function rememberInvite(app: AppContext, telegramId: number, payload: string): Promise<void> {
  const start = parseStartParam(payload.trim())
  if (start?.kind !== 'referral') return
  try {
    const [existing] = await app.db.select({ id: users.id }).from(users).where(eq(users.telegramId, telegramId))
    if (existing) return
    await app.db.insert(referralHints).values({ telegramId, code: start.code }).onConflictDoNothing({ target: referralHints.telegramId })
  } catch (error) {
    // The welcome still goes out; the referral is the only thing lost, and the log says so
    app.log.error({ err: error, telegramId }, 'could not remember a referral invite')
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function createBot(opts: BotOptions): Bot {
  const bot = new Bot(opts.token, opts.testing ? { botInfo: opts.testing.botInfo } : {})
  if (opts.testing) bot.api.config.use(opts.testing.transformer)
  const openButton = () => new InlineKeyboard().webApp('Open Raffle Win', opts.appUrl)
  const envNote = opts.envLabel === 'production' ? '' : `\n\n<i>Test environment: no real money.</i>`

  bot.command('start', async (ctx) => {
    if (opts.app && ctx.from) await rememberInvite(opts.app, ctx.from.id, ctx.match)
    const name = ctx.from?.first_name ? escapeHtml(ctx.from.first_name) : 'there'
    await ctx.reply(
      [
        `<b>Welcome to Raffle Win, ${name}!</b>`,
        '',
        'Enter raffles for phones, laptops, TVs and more, and watch the draw happen live. Each raffle shows its prizes and how many winners it has.',
        '',
        'Tap the button below to open the app. There is nothing to sign up for.',
        envNote,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: openButton() },
    )
  })

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        '<b>Raffle Win</b>',
        '',
        '/start - open the app',
        '/rules - how draws work',
        '/paysupport - help with a payment',
        '/help - this message',
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
        '2. Each raffle has a fixed entry price in Raffs and a deadline. Entries close at the deadline.',
        '3. One draw per raffle. A raffle has one prize or several (1st, 2nd, 3rd and so on); one ticket wins one prize.',
        '4. Winners give their name, phone and nearest motor park on the KYC page. Prizes are delivered to that motor park, never to a home address.',
        envNote,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: openButton() },
    )
  })

  // Required for bots that take Telegram Stars (Bot Developer Terms 6.2.1)
  bot.command('paysupport', async (ctx) => {
    await ctx.reply(
      'For help with a payment, reply here with what happened and when. A member of the Raffle Win team will answer in this chat.',
      { reply_markup: openButton() },
    )
  })

  if (opts.app) installAdminLogin(bot, opts.app, opts.appUrl)

  bot.on('message', async (ctx) => {
    await ctx.reply('Open Raffle Win to enter raffles, or send /help for the commands.', { reply_markup: openButton() })
  })

  bot.catch((err) => {
    opts.log.error({ err: err.error, updateId: err.ctx.update.update_id }, 'bot update failed')
  })

  return bot
}

/** One-time setup per environment: commands, the menu button and the webhook. */
export async function configureBot(
  bot: Bot,
  opts: { appUrl: string; webhookUrl: string; secret: string },
): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Open Raffle Win' },
    { command: 'rules', description: 'How the draws work' },
    { command: 'paysupport', description: 'Help with a payment' },
    { command: 'help', description: 'Commands' },
  ])
  await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Open', web_app: { url: opts.appUrl } } })
  await bot.api.setWebhook(opts.webhookUrl, {
    secret_token: opts.secret,
    allowed_updates: ['message', 'callback_query', 'pre_checkout_query', 'my_chat_member'],
    drop_pending_updates: false,
  })
}
