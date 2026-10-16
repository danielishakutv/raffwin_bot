import { and, eq, gte, sql } from 'drizzle-orm'
import type { Transformer } from 'grammy'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { hashPassword } from '../src/admin/session'
import { createBot } from '../src/bot/bot'
import { adminUsers, securityEvents } from '../src/db/schema'
import { BOT_TOKEN, initData, telegramId, testApp } from './helpers'

const MASTER = 'correct-master-password-2026'
const masterHash = await hashPassword(MASTER)
const { http, db, ctx } = testApp({ ADMIN_MASTER_PASSWORD_HASH: masterHash, ADMIN_BOT_COMMAND: 'staffdesk' })

interface Call {
  method: string
  payload: Record<string, unknown>
}

/** A bot wired to the test database whose Telegram API calls are recorded, never sent. */
function harness() {
  const calls: Call[] = []
  let nextId = 1000
  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    const result =
      method === 'sendMessage'
        ? { message_id: (nextId += 1), date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' }, text: '' }
        : true
    return { ok: true, result } as never
  }
  const bot = createBot({
    token: BOT_TOKEN,
    appUrl: 'https://raffwintest.example/',
    envLabel: 'test',
    log: pino({ level: 'silent' }),
    app: ctx,
    testing: { botInfo: { id: 1, is_bot: true, first_name: 'Raffle Win', username: 'raffwin_test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: true, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false }, transformer },
  })
  let updateId = 1
  let messageId = 1
  const send = async (from: { id: number; username?: string }, text: string) => {
    const isCommand = text.startsWith('/')
    messageId += 1
    await bot.handleUpdate({
      update_id: (updateId += 1),
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: from.id, type: 'private', first_name: 'Ada' },
        from: { id: from.id, is_bot: false, first_name: 'Ada', username: from.username },
        text,
        ...(isCommand ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }] } : {}),
      },
    } as never)
    return messageId
  }
  const replies = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text))
  const deleted = () => calls.filter((c) => c.method === 'deleteMessage').map((c) => Number(c.payload.message_id))
  return { calls, send, replies, deleted }
}

async function adminAccount(telegramUsername: string, password: string) {
  const username = `adm_${telegramId()}`
  const [row] = await db
    .insert(adminUsers)
    .values({ name: 'Ada Admin', username, telegramUsername, role: 'super_admin', passwordHash: await hashPassword(password) })
    .returning()
  return { ...row!, username }
}

async function eventsSince(kind: string, since: Date) {
  return db.select().from(securityEvents).where(and(eq(securityEvents.kind, kind), gte(securityEvents.occurredAt, since)))
}

describe('bot admin sign-in', () => {
  it('walks master password, username, password; deletes each; binds the account; hands out a working ticket', async () => {
    const tgName = `ada_${telegramId()}`
    const admin = await adminAccount(tgName, 'admin-password-xyz')
    const me = { id: telegramId(), username: tgName }
    const h = harness()

    await h.send(me, '/staffdesk')
    const m1 = await h.send(me, MASTER)
    const m2 = await h.send(me, admin.username)
    const m3 = await h.send(me, 'admin-password-xyz')

    expect(h.deleted()).toEqual([m1, m2, m3])
    expect(h.replies().slice(0, 3)).toEqual([
      'Admin sign-in. Send the master password. Each message is deleted as soon as it is read.',
      'Admin username?',
      'Admin password?',
    ])
    const last = h.calls.filter((c) => c.method === 'sendMessage').at(-1)
    expect(String(last?.payload.text)).toMatch(/^Signed in as Ada Admin/)
    const button = (last?.payload.reply_markup as { inline_keyboard: { text: string; web_app: { url: string } }[][] }).inline_keyboard[0]?.[0]
    expect(button?.text).toBe('Open admin')
    const ticket = new URL(button?.web_app.url ?? '').searchParams.get('admin_ticket')
    expect(ticket).toBeTruthy()

    const [bound] = await db.select().from(adminUsers).where(eq(adminUsers.id, admin.id))
    expect(bound?.telegramId).toBe(me.id)

    const session = await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: me.id }) })
    expect(session.status, JSON.stringify(session.body)).toBe(200)
    expect(session.body.admin.name).toBe('Ada Admin')

    const audit = await db.execute<{ action: string }>(
      sql`select action from audit_log where target_id = ${String(me.id)} and action like 'admin.%' order by seq`,
    )
    expect(audit.rows.map((r) => r.action)).toEqual(['admin.login.started', 'admin.telegram.bound', 'admin.login.success'])
  })

  it('gives one generic answer for a wrong master password and records it', async () => {
    const since = new Date(Date.now() - 1000)
    const me = { id: telegramId(), username: 'someone' }
    const h = harness()
    await h.send(me, '/staffdesk')
    await h.send(me, 'not the master password')
    expect(h.replies().at(-1)).toBe('That did not work. Send the admin command again to start over.')
    expect((await eventsSince('admin_bot_login_master_password', since))[0]).toMatchObject({ category: 'admin', severity: 'high' })
    // The attempt is over: the next message is an ordinary one
    await h.send(me, 'hello')
    expect(h.replies().at(-1)).toBe('Open Raffle Win to enter raffles, or send /help for the commands.')
  })

  it('refuses the right passwords from a Telegram account the super admin did not name', async () => {
    const since = new Date(Date.now() - 1000)
    const admin = await adminAccount(`real_${telegramId()}`, 'pw-for-real')
    const intruder = { id: telegramId(), username: 'intruder_x' }
    const h = harness()
    await h.send(intruder, '/staffdesk')
    await h.send(intruder, MASTER)
    await h.send(intruder, admin.username)
    await h.send(intruder, 'pw-for-real')
    expect(h.replies().at(-1)).toBe('That did not work. Send the admin command again to start over.')
    expect((await eventsSince('admin_bot_login_telegram_username_mismatch', since))[0]?.severity).toBe('critical')
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, admin.id))
    expect(row?.telegramId).toBeNull()
  })

  it('once bound, refuses the same admin from any other Telegram account', async () => {
    const tgName = `own_${telegramId()}`
    const admin = await adminAccount(tgName, 'pw-own')
    const owner = { id: telegramId(), username: tgName }
    const h = harness()
    for (const t of ['/staffdesk', MASTER, admin.username, 'pw-own']) await h.send(owner, t)
    // Someone else later takes the same Telegram username
    const other = { id: telegramId(), username: tgName }
    for (const t of ['/staffdesk', MASTER, admin.username, 'pw-own']) await h.send(other, t)
    expect(h.replies().at(-1)).toBe('That did not work. Send the admin command again to start over.')
  })

  it('locks a Telegram account out after 5 failures', async () => {
    const me = { id: telegramId(), username: 'locked_out' }
    const h = harness()
    for (let i = 0; i < 5; i += 1) {
      await h.send(me, '/staffdesk')
      await h.send(me, 'wrong')
    }
    await h.send(me, '/staffdesk')
    // Locked: no master-password prompt, just the generic reply
    expect(h.replies().at(-1)).toBe('That did not work. Send the admin command again to start over.')
    const before = h.deleted().length
    await h.send(me, MASTER)
    expect(h.deleted().length).toBe(before) // not treated as a secret: there is no sign-in in progress
  })

})
