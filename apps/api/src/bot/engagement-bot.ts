/**
 * The bot's side of engagement:
 *
 *   reminders:off / reminders:on   the button under every reminder and offer
 *   /phone, /start phone           asks for the player's number with Telegram's
 *                                  "share contact" button (the app links here
 *                                  when it cannot ask for the number itself)
 *   a shared contact               saved as the player's verified phone, only
 *                                  when it is their own Telegram account
 *   my_chat_member                 blocking the bot marks the player unreachable
 *                                  (the outbox stops queueing for them); starting
 *                                  it again clears that
 *   write_access_allowed           a player who opened the Mini App without ever
 *                                  pressing Start (so the first message was refused
 *                                  and marked them unreachable) allowed the bot to
 *                                  message them: reachable again, silently
 *
 * Needs the database, so it is installed only when the bot has an AppContext.
 */
import { InlineKeyboard, Keyboard, type Bot, type Context } from 'grammy'
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { formatPhoneDisplay, normalizeNigerianPhone } from '@raffwin/shared'
import type { AppContext, RequestMeta } from '../context'
import { users, type UserRow } from '../db/schema'
import { escapeHtml, firstName } from '../lib/html'
import { HttpError } from '../lib/http-error'
import { recordSecurityEvent } from '../lib/security-events'
import { nextReminderAfter, setReminders } from '../services/engagement'
import { REMINDERS_OFF, REMINDERS_ON, TURN_OFF_LABEL, TURN_ON_LABEL } from '../services/engagement-messages'
import { saveVerifiedPhone } from '../services/phone'

/** https://t.me/<bot>?start=phone */
export const PHONE_START_PAYLOAD = 'phone'
const SHARE_LABEL = 'Share my phone number'
const SUSPENDED = 'This account is suspended. Send /paysupport for help.'

export function isPhoneStart(payload: string): boolean {
  return payload.trim().toLowerCase() === PHONE_START_PAYLOAD
}

async function accountOf(app: AppContext, telegramId: number): Promise<UserRow | null> {
  const [row] = await app.db.select().from(users).where(eq(users.telegramId, telegramId))
  return row ?? null
}

function shareKeyboard(): Keyboard {
  return new Keyboard().requestContact(SHARE_LABEL).oneTime().resized()
}

/**
 * Marks the player reachable or not (blocked the bot / started it again). No
 * account = nothing to mark. Reachable again: a reminder that fell due while
 * they were blocked is moved to at least min..max hours from now, so it does
 * not arrive a minute after the welcome. No schedule (the spell's cap was
 * reached) stays none until the next app open.
 */
async function setBotBlocked(app: AppContext, telegramId: number, blocked: boolean): Promise<void> {
  if (blocked) {
    await app.db
      .update(users)
      .set({ botBlockedAt: sql`coalesce(${users.botBlockedAt}, ${new Date(app.now())})` })
      .where(eq(users.telegramId, telegramId))
    return
  }
  const later = await nextReminderAfter(app, app.now())
  await app.db
    .update(users)
    .set({
      botBlockedAt: null,
      nextReminderAt: sql`case when ${users.nextReminderAt} is null then null else greatest(${users.nextReminderAt}, ${later}) end`,
    })
    // Only a player who was marked: a /start from a reachable one changes nothing
    .where(and(eq(users.telegramId, telegramId), isNotNull(users.botBlockedAt)))
}

/**
 * /start with any payload: a player who blocked the bot and comes back is
 * reachable again. Never stops the welcome; a failure is logged.
 */
export async function botStarted(app: AppContext, telegramId: number): Promise<void> {
  try {
    await setBotBlocked(app, telegramId, false)
  } catch (error) {
    app.log.error({ err: error, telegramId }, 'could not clear bot_blocked_at on /start')
  }
}

/** The "share your phone" prompt, with Telegram's contact button as a one-time reply keyboard. */
export async function askForPhone(ctx: Context, app: AppContext, appUrl: string): Promise<void> {
  if (ctx.chat?.type !== 'private' || !ctx.from) return
  const user = await accountOf(app, ctx.from.id)
  if (!user) {
    await ctx.reply('Open Raffle Win once first (button below), then send /phone again.', {
      reply_markup: new InlineKeyboard().webApp('Open Raffle Win', appUrl),
    })
    return
  }
  const current = user.phone && user.phoneVerifiedAt
    ? [`Your number on Raffle Win is <b>${escapeHtml(formatPhoneDisplay(user.phone))}</b>. To change it to the number on this Telegram account, share it again.`, '']
    : []
  await ctx.reply(
    [
      '<b>Share your phone number</b>',
      '',
      ...current,
      'If you win, the courier calls this number to deliver your prize to your motor park. We use it only for that, and other players never see it.',
      '',
      `Tap <b>${SHARE_LABEL}</b> below. Telegram sends the number on your account, so there is nothing to type.`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: shareKeyboard() },
  )
}

/** The same keyboard with the reminders button flipped to offer the opposite. */
function flippedKeyboard(markup: InlineKeyboardMarkup | undefined, nowOn: boolean): InlineKeyboardMarkup {
  const toggle: InlineKeyboardButton = nowOn
    ? { text: TURN_OFF_LABEL, callback_data: REMINDERS_OFF }
    : { text: TURN_ON_LABEL, callback_data: REMINDERS_ON }
  const isToggle = (b: InlineKeyboardButton) =>
    'callback_data' in b && (b.callback_data === REMINDERS_OFF || b.callback_data === REMINDERS_ON)
  const rows = (markup?.inline_keyboard ?? []).map((row) => row.map((b) => (isToggle(b) ? toggle : b)))
  if (!rows.some((row) => row.includes(toggle))) rows.push([toggle])
  return { inline_keyboard: rows }
}

export function installEngagement(bot: Bot, app: AppContext, appUrl: string): void {
  const openButton = () => new InlineKeyboard().webApp('Open Raffle Win', appUrl)

  bot.callbackQuery([REMINDERS_OFF, REMINDERS_ON], async (ctx) => {
    const on = ctx.callbackQuery.data === REMINDERS_ON
    const user = await accountOf(app, ctx.from.id)
    if (!user) {
      await ctx.answerCallbackQuery({ text: 'Open Raffle Win once first, then try again.' })
      return
    }
    await setReminders(app, user.id, on)
    await ctx.answerCallbackQuery({
      text: on ? 'Reminders are back on.' : 'Done: no more reminders. You can turn them back on in your Profile in the app.',
    })
    const message = ctx.callbackQuery.message
    if (!message) return
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: flippedKeyboard('reply_markup' in message ? message.reply_markup : undefined, on) })
    } catch (error) {
      // The setting is saved; only the button under an old message still shows the previous choice
      app.log.warn({ err: error, telegramId: ctx.from.id }, 'could not update the reminders button')
    }
  })

  bot.command('phone', (ctx) => askForPhone(ctx, app, appUrl))

  bot.on('message:contact', async (ctx) => {
    if (ctx.chat.type !== 'private') return
    const contact = ctx.message.contact
    const user = await accountOf(app, ctx.from.id)
    const meta: RequestMeta = { ipHash: null, userAgent: null, requestId: `tg:${ctx.update.update_id}`, route: 'bot message:contact' }

    if (contact.user_id !== ctx.from.id) {
      await recordSecurityEvent(app.db, app.log, {
        severity: 'high',
        category: 'fraud',
        kind: 'bot_contact_other_account',
        ipHash: null,
        route: meta.route,
        userId: user?.id ?? null,
        requestId: meta.requestId,
        details: { telegramId: ctx.from.id, contactUserId: contact.user_id ?? null },
      })
      await ctx.reply(`That is not the number on your own Telegram account. Tap ${SHARE_LABEL} below to send yours.`, {
        reply_markup: shareKeyboard(),
      })
      return
    }
    if (!user) {
      await ctx.reply('Open Raffle Win once first (button below), then send /phone again.', { reply_markup: openButton() })
      return
    }
    const done = { remove_keyboard: true } as const
    if (user.status !== 'active') {
      await ctx.reply(SUSPENDED, { reply_markup: done })
      return
    }
    const phone = normalizeNigerianPhone(contact.phone_number)
    if (!phone) {
      await ctx.reply(
        'Raffle Win delivers prizes in Nigeria only, so we need a Nigerian number. This Telegram account uses a number from outside Nigeria.',
        { reply_markup: done },
      )
      return
    }

    try {
      if (user.phone !== phone || !user.phoneVerifiedAt) await saveVerifiedPhone(app, user, phone, 'bot', meta)
    } catch (error) {
      if (error instanceof HttpError && error.code === 'PHONE_IN_USE') {
        await ctx.reply(
          'That number is already on another Raffle Win account. One account per person: if you think this is a mistake, send /paysupport.',
          { reply_markup: done },
        )
        return
      }
      if (error instanceof HttpError) {
        await ctx.reply(error.message, { reply_markup: done })
        return
      }
      app.log.error({ err: error, userId: user.id }, 'could not save a phone number shared in the bot')
      await ctx.reply('Something went wrong on our side and your number was not saved. Please send /phone again in a minute.', {
        reply_markup: done,
      })
      return
    }
    await ctx.reply(
      `Thank you, ${escapeHtml(firstName(user))}. Your number <b>${escapeHtml(formatPhoneDisplay(phone))}</b> is saved. If you win, this is the number the courier will call.`,
      { parse_mode: 'HTML', reply_markup: done },
    )
    await ctx.reply('Back to the raffles whenever you are ready.', { reply_markup: openButton() })
  })

  // Service message: the player allowed the bot to write to them (Mini App, login widget, ...). No reply.
  bot.on('message:write_access_allowed', async (ctx) => {
    if (ctx.chat.type !== 'private') return
    try {
      await setBotBlocked(app, ctx.chat.id, false)
    } catch (error) {
      app.log.error({ err: error, telegramId: ctx.chat.id }, 'could not clear bot_blocked_at on write_access_allowed')
    }
  })

  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember
    if (update.chat.type !== 'private') return
    const status = update.new_chat_member.status
    // kicked = the player blocked the bot; member = unblocked (or started it)
    if (status === 'kicked') await setBotBlocked(app, update.chat.id, true)
    else if (status === 'member') await setBotBlocked(app, update.chat.id, false)
  })
}
