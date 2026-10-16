/**
 * Admin sign-in through the bot (see admin/session.ts for the whole model).
 *
 *   /<ADMIN_BOT_COMMAND>  ->  master password  ->  admin username  ->  admin password
 *
 * Private chats only. The bot deletes every message carrying a secret as soon
 * as it has read it. One wrong answer ends the attempt with the same reply
 * whatever was wrong; 5 failures in a row lock that Telegram account out of
 * admin sign-in for an hour. Every step is written to the audit log.
 */
import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { eq, sql } from 'drizzle-orm'
import type { AppContext } from '../context'
import { adminLoginFlows, adminUsers } from '../db/schema'
import { recordSecurityEvent } from '../lib/security-events'
import { auditLogin, issueTicket, TICKET_MINUTES, verifyPassword } from '../admin/session'

const STEP_MINUTES = 5
const MAX_FAILED = 5
const LOCK_MINUTES = 60
const FAILED_REPLY = 'That did not work. Send the admin command again to start over.'

/**
 * telegram_username sentinel set only by `admin:create --telegram first-signin`
 * (never accepted by the admin screen, whose usernames are [a-z0-9_]). Used
 * once, to bootstrap the first admin when their Telegram username is not known.
 */
export const FIRST_SIGNIN_CLAIM = '*first-signin*'

export function installAdminLogin(bot: Bot, app: AppContext, appUrl: string): void {
  const command = app.config.ADMIN_BOT_COMMAND
  const masterHash = app.config.ADMIN_MASTER_PASSWORD_HASH
  // Without a master password configured, the command does not exist at all
  if (!masterHash) return

  bot.command(command, async (ctx) => {
    if (ctx.chat?.type !== 'private' || !ctx.from) return
    const started = await startAdminSignIn(app, ctx.from.id, ctx.chat.id, 'command')
    await ctx.reply(started === 'locked' ? FAILED_REPLY : masterPrompt(app.config))
  })

  // Runs before the generic message handler; passes through anything that is not part of a sign-in
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'private' || ctx.message.text.startsWith('/')) return next()
    const now = app.now()
    const [flow] = await app.db.select().from(adminLoginFlows).where(eq(adminLoginFlows.telegramId, ctx.from.id))
    if (!flow || flow.step === 'idle' || flow.expiresAt.getTime() <= now) return next()

    await removeSecret(app, ctx)
    const text = ctx.message.text.trim()

    if (flow.step === 'master') {
      if (!(await verifyPassword(masterHash, text))) return fail(app, ctx, flow, 'master_password')
      await setStep(app, ctx.from.id, 'master', 'username', null, now)
      await ctx.reply('Admin username?')
      return
    }

    if (flow.step === 'username') {
      await setStep(app, ctx.from.id, 'username', 'password', text.toLowerCase().slice(0, 64), now)
      await ctx.reply('Admin password?')
      return
    }

    // step === 'password'
    const [admin] = await app.db.select().from(adminUsers).where(eq(adminUsers.username, flow.username ?? ''))
    if (!admin || admin.status !== 'active' || !(await verifyPassword(admin.passwordHash, text))) {
      return fail(app, ctx, flow, 'username_or_password', admin?.id ?? null)
    }
    const tgUsername = ctx.from.username?.toLowerCase() ?? null
    if (admin.telegramId === null) {
      // First login binds the account, but only the one the super admin named.
      // FIRST_SIGNIN_CLAIM (CLI-only, for the very first admin) lets the first account
      // that completes the whole sign-in claim it; the secrets exist only on the server.
      const claim = admin.telegramUsername === FIRST_SIGNIN_CLAIM
      if (!claim && (!admin.telegramUsername || admin.telegramUsername !== tgUsername)) {
        return fail(app, ctx, flow, 'telegram_username_mismatch', admin.id, 'critical')
      }
      await app.db
        .update(adminUsers)
        .set({ telegramId: ctx.from.id, telegramUsername: claim ? tgUsername : admin.telegramUsername, updatedAt: sql`now()` })
        .where(eq(adminUsers.id, admin.id))
      await auditLogin(app, {
        adminId: admin.id,
        action: claim ? 'admin.telegram.claimed' : 'admin.telegram.bound',
        telegramId: ctx.from.id,
        details: { telegramUsername: tgUsername },
      })
    } else if (admin.telegramId !== ctx.from.id) {
      return fail(app, ctx, flow, 'wrong_telegram_account', admin.id, 'critical')
    }

    await app.db
      .update(adminLoginFlows)
      .set({ step: 'idle', username: null, failedCount: 0, lockedUntil: null, updatedAt: sql`now()` })
      .where(eq(adminLoginFlows.telegramId, ctx.from.id))
    await app.db.update(adminUsers).set({ lastLoginAt: new Date(now), failedLogins: 0, updatedAt: sql`now()` }).where(eq(adminUsers.id, admin.id))
    const ticket = await issueTicket(app, admin.id, ctx.from.id)
    await auditLogin(app, { adminId: admin.id, action: 'admin.login.success', telegramId: ctx.from.id })
    const url = new URL(appUrl)
    url.searchParams.set('admin_ticket', ticket)
    await ctx.reply(`Signed in as ${admin.name}. The button works once, for ${TICKET_MINUTES} minutes.`, {
      reply_markup: new InlineKeyboard().webApp('Open admin', url.toString()),
    })
  })
}

/**
 * Names the environment first: test and live have different master passwords
 * and admin passwords, and mixing them up looked like "the admin shows demo data".
 */
export function masterPrompt(config: { NODE_ENV: string; BOT_USERNAME: string }): string {
  const where =
    config.NODE_ENV === 'production'
      ? `LIVE admin sign-in (@${config.BOT_USERNAME}: real players, real raffles).`
      : `TEST admin sign-in (@${config.BOT_USERNAME}: sample data only, nothing here reaches the live app).`
  return `${where} Send the ${config.NODE_ENV === 'production' ? 'LIVE' : 'TEST'} master password. Each message is deleted as soon as it is read.`
}

/**
 * Puts a Telegram account at the first step (master password) of the sign-in.
 * Used by the hidden command and by the "Start admin sign-in" button in the app.
 * A locked account stays locked; nothing else is checked or revealed here.
 */
export async function startAdminSignIn(
  app: AppContext,
  telegramId: number,
  chatId: number,
  via: 'command' | 'app',
): Promise<'started' | 'locked'> {
  const now = app.now()
  const [flow] = await app.db.select().from(adminLoginFlows).where(eq(adminLoginFlows.telegramId, telegramId))
  if (flow?.lockedUntil && flow.lockedUntil.getTime() > now) return 'locked'
  const expiresAt = new Date(now + STEP_MINUTES * 60_000)
  await app.db
    .insert(adminLoginFlows)
    .values({ telegramId, chatId, step: 'master', expiresAt })
    .onConflictDoUpdate({
      target: adminLoginFlows.telegramId,
      set: { chatId, step: 'master', username: null, expiresAt, updatedAt: sql`now()` },
    })
  await auditLogin(app, { adminId: null, action: 'admin.login.started', telegramId, details: { via } })
  return 'started'
}

/** Deletes the message that carried a secret; if Telegram refuses, says so instead of leaving it silently. */
async function removeSecret(app: AppContext, ctx: Context): Promise<void> {
  try {
    await ctx.deleteMessage()
  } catch (error) {
    app.log.warn({ err: error, telegramId: ctx.from?.id }, 'could not delete an admin sign-in message')
    await ctx.reply('I could not delete your last message. Please delete it yourself now.')
  }
}

async function setStep(
  app: AppContext,
  telegramId: number,
  from: 'master' | 'username',
  to: 'username' | 'password',
  username: string | null,
  now: number,
): Promise<void> {
  await app.db
    .update(adminLoginFlows)
    .set({ step: to, ...(from === 'username' ? { username } : {}), expiresAt: new Date(now + STEP_MINUTES * 60_000), updatedAt: sql`now()` })
    .where(eq(adminLoginFlows.telegramId, telegramId))
}

async function fail(
  app: AppContext,
  ctx: Context,
  flow: typeof adminLoginFlows.$inferSelect,
  reason: string,
  adminId: string | null = null,
  severity: 'high' | 'critical' = 'high',
): Promise<void> {
  const telegramId = flow.telegramId
  const failed = flow.failedCount + 1
  const lock = failed >= MAX_FAILED
  await app.db
    .update(adminLoginFlows)
    .set({
      step: 'idle',
      username: null,
      failedCount: lock ? 0 : failed,
      lockedUntil: lock ? new Date(app.now() + LOCK_MINUTES * 60_000) : flow.lockedUntil,
      updatedAt: sql`now()`,
    })
    .where(eq(adminLoginFlows.telegramId, telegramId))
  await recordSecurityEvent(app.db, app.log, {
    severity: lock ? 'critical' : severity,
    category: 'admin',
    kind: `admin_bot_login_${reason}`,
    ipHash: null,
    route: 'bot admin sign-in',
    details: { telegramId, telegramUsername: ctx.from?.username ?? null, adminId, failedInARow: failed },
    actionTaken: lock ? 'blocked' : 'none',
  })
  await auditLogin(app, { adminId, action: 'admin.login.failed', telegramId, details: { reason, locked: lock } })
  await ctx.reply(FAILED_REPLY)
}
