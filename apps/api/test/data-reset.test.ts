/**
 * 20 Oct: a super admin can delete a player for good and reset players,
 * raffles, finance and messages back to zero. Both take a backup first and
 * refuse without one; logs and admins always stay.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import type { AdminResetPreview } from '@raffwin/shared/admin-types'
import { hashPassword, issueTicket } from '../src/admin/session'
import { backup } from '../src/admin/data-reset'
import { adminUsers, approvals, auditLog, entries, ledger, rafflePrizes, raffles, users, type AdminRole } from '../src/db/schema'
import { newDrawSeed, settleRaffle } from '../src/services/draw'
import { createRaffle, credit, member } from './fixtures'
import { contactProof, initData, nigerianPhone, telegramId, testApp } from './helpers'

const realTake = backup.take
const taken: string[] = []
afterEach(() => {
  backup.take = realTake
})
/** Stands in for pg_dump: records the request and returns a file name */
const fakeBackup = () => {
  backup.take = async (_ctx, what) => {
    taken.push(what)
    return `/backups/test-before-${what}.dump`
  }
}

const { http, db, ctx } = testApp({ RESET_BACKUP_DIR: mkdtempSync(join(tmpdir(), 'raffwin-reset-')) })
// The same database, on a server that has no backup folder
const noBackups = testApp()

async function signIn(role: AdminRole, client = http, context = ctx) {
  const tg = telegramId()
  const [a] = await db
    .insert(adminUsers)
    .values({ name: `Reset ${role}`, username: `rst_${tg}`, telegramUsername: `rst${tg}`, telegramId: tg, role, passwordHash: await hashPassword('x'.repeat(16)) })
    .returning({ id: adminUsers.id })
  const ticket = await issueTicket(context, a!.id, tg)
  const res = await client.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: tg }) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { id: a!.id, authorization: `Bearer ${res.body.token as string}` }
}

/** A player who shared a phone, as entering needs one */
async function player(opts: { startParam?: string } = {}) {
  const m = await member(http, opts)
  const res = await m.put('/v1/phone', { contactProof: contactProof(m.telegramId, nigerianPhone().slice(1)) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return m
}

/** What the database said, under the driver's "Failed query" wrapper */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    const e = error as { message: string; cause?: { message?: string } }
    return e.cause?.message ?? e.message
  }
  return 'not refused'
}

/** Enters `qty` tickets; with `fund` the Raffs are credited first, otherwise they come from the balance */
async function enter(m: Awaited<ReturnType<typeof member>>, raffleId: string, qty: number, fund = true) {
  if (fund) await credit(db, m.userId, qty * 10)
  const res = await m.post('/v1/entries', { raffleId, qty, idempotencyKey: randomUUID() })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
}

const count = async (table: string) => Number(((await db.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows[0] as { n: number }).n)
const balanceOf = async (userId: string) => (await db.select({ b: users.balanceCache }).from(users).where(eq(users.id, userId)))[0]?.b
const ledgerSum = async (userId: string) => Number(((await db.execute(sql`select coalesce(sum(raffs), 0)::int as n from ledger where user_id = ${userId}`)).rows[0] as { n: number }).n)
const PHRASE = 'RESET DEV'

describe('who may reset', () => {
  it('only a super admin: other roles cannot see or run a reset, or delete a player', async () => {
    fakeBackup()
    const finance = await signIn('finance')
    const m = await member(http)
    expect((await http.get('/admin/v1/system/reset').set(finance)).status).toBe(403)
    expect((await http.post('/admin/v1/system/reset').set(finance).send({ parts: ['finance'], confirm: PHRASE, reason: 'Clean up tests' })).status).toBe(403)
    expect((await http.post(`/admin/v1/users/${m.userId}/delete`).set(finance).send({ confirm: m.username, reason: 'Clean up tests' })).status).toBe(403)
    expect(await balanceOf(m.userId)).toBe(0)
    expect(taken).toHaveLength(0)
  })

  it('without a backup folder nothing can be wiped, and the preview says so', async () => {
    const admin = await signIn('super_admin', noBackups.http, noBackups.ctx)
    const m = await member(noBackups.http)
    const preview = (await noBackups.http.get('/admin/v1/system/reset').set(admin)).body as AdminResetPreview
    expect(preview).toMatchObject({ available: false, phrase: PHRASE })
    const res = await noBackups.http.post('/admin/v1/system/reset').set(admin).send({ parts: ['players'], confirm: PHRASE, reason: 'Clean up tests' })
    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/no backup folder/)
    const del = await noBackups.http.post(`/admin/v1/users/${m.userId}/delete`).set(admin).send({ confirm: m.username, reason: 'Clean up tests' })
    expect(del.status).toBe(409)
    expect(await balanceOf(m.userId)).toBe(0)
  })

  it('a failed backup stops the reset before anything is touched', async () => {
    backup.take = async () => {
      throw new Error('pg_dump: connection refused')
    }
    const admin = await signIn('super_admin')
    const m = await member(http)
    await credit(db, m.userId, 40)
    const res = await http.post('/admin/v1/system/reset').set(admin).send({ parts: ['finance'], confirm: PHRASE, reason: 'Clean up tests' })
    expect(res.status).toBe(500)
    expect(res.body.error.message).toMatch(/backup .* failed, so nothing was changed/)
    expect(await balanceOf(m.userId)).toBe(40)
  })

  it('the confirmation must be typed exactly', async () => {
    fakeBackup()
    const admin = await signIn('super_admin')
    const res = await http.post('/admin/v1/system/reset').set(admin).send({ parts: ['finance'], confirm: 'reset dev', reason: 'Clean up tests' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toBe(`Type ${PHRASE} exactly to confirm.`)
  })
})

describe('deleting one player', () => {
  it('removes them and all that is theirs, closes the gap in tickets, keeps the logs, and the same Telegram account starts again as new', async () => {
    fakeBackup()
    const admin = await signIn('super_admin')
    const a = await player()
    const b = await player()
    const referred = await member(http, { startParam: `ref_${a.referralCode}` })
    const raffle = await createRaffle(db, { entryPriceRaffs: 10 })
    await enter(a, raffle.id, 3) // tickets 1-3
    await enter(b, raffle.id, 2) // 4-5
    await enter(a, raffle.id, 1) // 6
    await enter(b, raffle.id, 1) // 7
    await credit(db, a.userId, 25)
    const auditBefore = await count('audit_log')

    const wrong = await http.post(`/admin/v1/users/${a.userId}/delete`).set(admin).send({ confirm: 'someone_else', reason: 'Test account' })
    expect(wrong.status).toBe(400)

    const res = await http.post(`/admin/v1/users/${a.userId}/delete`).set(admin).send({ confirm: `@${a.username.toUpperCase()}`, reason: 'Test account' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.backupFile).toBe('/backups/test-before-player-delete.dump')
    expect(res.body.deleted).toMatchObject({ users: 1, entries: 2 })

    expect(await db.select().from(users).where(eq(users.id, a.userId))).toHaveLength(0)
    expect(await ledgerSum(a.userId)).toBe(0)
    // b's tickets move up to 1-2 and 3; the raffle now holds 3 tickets
    const left = await db.select().from(entries).where(eq(entries.raffleId, raffle.id)).orderBy(entries.ticketFrom)
    expect(left.map((e) => [e.ticketFrom, e.ticketTo])).toEqual([
      [1, 2],
      [3, 3],
    ])
    expect((await db.select({ n: raffles.entriesCount }).from(raffles).where(eq(raffles.id, raffle.id)))[0]?.n).toBe(3)
    // b is untouched; the player a referred no longer points at a
    expect(await balanceOf(b.userId)).toBe(0)
    expect((await db.select({ r: users.referredByUserId }).from(users).where(eq(users.id, referred.userId)))[0]?.r).toBeNull()
    // The log grew; nothing in it went
    expect(await count('audit_log')).toBeGreaterThan(auditBefore)
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'user.delete')).orderBy(sql`seq desc`).limit(1)
    expect(entry?.before).toMatchObject({ telegramId: a.telegramId, username: a.username, entries: 2, tickets: 4 })

    // Their old session is refused; opening the app again makes a brand-new account
    expect((await a.get('/v1/bootstrap')).status).toBe(401)
    const again = await http.post('/v1/auth/telegram').send({ initData: initData({ id: a.telegramId, username: a.username, first_name: 'Ada' }) })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    const [fresh] = await db.select().from(users).where(eq(users.telegramId, a.telegramId))
    expect(fresh?.id).not.toBe(a.userId)
    expect(fresh?.balanceCache).toBe(0)
  })

  it('a prize they won stays drawn, with no winner to show', async () => {
    fakeBackup()
    const admin = await signIn('super_admin')
    const winner = await player()
    const { seed, commitment } = newDrawSeed()
    const raffle = await createRaffle(db, { entryPriceRaffs: 10, drawSeed: seed, seedCommitment: commitment })
    await enter(winner, raffle.id, 5)
    await db.update(raffles).set({ deadline: new Date(Date.now() - 1000) }).where(eq(raffles.id, raffle.id))
    expect(await settleRaffle(ctx, raffle.id)).toBe('drawn')
    const res = await http.post(`/admin/v1/users/${winner.userId}/delete`).set(admin).send({ confirm: winner.username, reason: 'Test account' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const prizes = await db.select().from(rafflePrizes).where(eq(rafflePrizes.raffleId, raffle.id))
    expect(prizes.every((p) => p.winnerUserId === null && p.winnerTicket !== null)).toBe(true)
    expect((await db.select({ s: raffles.status }).from(raffles).where(eq(raffles.id, raffle.id)))[0]?.s).toBe('drawn')
  })
})

describe('resetting parts', () => {
  it('raffles: every raffle and ticket goes, and balances are as if they never were', async () => {
    fakeBackup()
    const admin = await signIn('super_admin')
    const m = await player()
    await credit(db, m.userId, 100)
    const raffle = await createRaffle(db, { entryPriceRaffs: 10 })
    await enter(m, raffle.id, 3, false) // spends 30 of the 100
    expect(await balanceOf(m.userId)).toBe(70)
    const res = await http.post('/admin/v1/system/reset').set(admin).send({ parts: ['raffles'], confirm: PHRASE, reason: 'Start again' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await count('raffles')).toBe(0)
    expect(await count('entries')).toBe(0)
    expect(await balanceOf(m.userId)).toBe(100)
    expect(await ledgerSum(m.userId)).toBe(100)
    // The lines that remain still run up to the balance
    const lines = await db.select().from(ledger).where(eq(ledger.userId, m.userId)).orderBy(ledger.createdAt, ledger.id)
    expect(lines.at(-1)?.balanceAfter).toBe(100)
  })

  it('players: every player goes; raffles stay, drawn ones keep their winning tickets, the rest start again from 0', async () => {
    fakeBackup()
    const admin = await signIn('super_admin')
    const m = await player()
    const { seed, commitment } = newDrawSeed()
    const drawn = await createRaffle(db, { entryPriceRaffs: 10, drawSeed: seed, seedCommitment: commitment })
    await enter(m, drawn.id, 5)
    await db.update(raffles).set({ deadline: new Date(Date.now() - 1000) }).where(eq(raffles.id, drawn.id))
    expect(await settleRaffle(ctx, drawn.id)).toBe('drawn')
    const open = await createRaffle(db, { entryPriceRaffs: 10 })
    await enter(m, open.id, 2)

    const res = await http.post('/admin/v1/system/reset').set(admin).send({ parts: ['players'], confirm: PHRASE, reason: 'Start again' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await count('users')).toBe(0)
    expect(await count('ledger')).toBe(0)
    const prizes = await db.select().from(rafflePrizes).where(eq(rafflePrizes.raffleId, drawn.id))
    expect(prizes.every((p) => p.winnerUserId === null && p.winnerTicket !== null)).toBe(true)
    const counts = await db.select({ id: raffles.id, n: raffles.entriesCount }).from(raffles).where(sql`${raffles.id} in (${drawn.id}, ${open.id})`)
    expect(Object.fromEntries(counts.map((r) => [r.id, r.n]))).toEqual({ [drawn.id]: 5, [open.id]: 0 })
  })

  it('finance: every Raffs record goes and every balance is 0; players stay', async () => {
    fakeBackup()
    const admin = await signIn('super_admin')
    const m = await member(http)
    await credit(db, m.userId, 55)
    const pending = await db
      .insert(approvals)
      .values({ action: 'rate_base_change', payload: { nairaPerRaff: 12 }, reason: 'Keep me', requestedByAdminId: admin.id, expiresAt: new Date(Date.now() + 86_400_000) })
      .returning({ id: approvals.id })
    const res = await http.post('/admin/v1/system/reset').set(admin).send({ parts: ['finance'], confirm: PHRASE, reason: 'Start again' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await count('ledger')).toBe(0)
    expect(await balanceOf(m.userId)).toBe(0)
    expect(await db.select().from(users).where(eq(users.id, m.userId))).toHaveLength(1)
    // An approval about something else is left alone
    expect((await db.select({ s: approvals.status }).from(approvals).where(eq(approvals.id, pending[0]!.id)))[0]?.s).toBe('pending')
  })

  it('everything: back to zero; admins, settings and every log line stay, and the admin is still signed in', async () => {
    fakeBackup()
    const admin = await signIn('super_admin')
    const m = await player()
    const raffle = await createRaffle(db, { entryPriceRaffs: 10 })
    await enter(m, raffle.id, 2)
    const admins = await count('admin_users')
    const auditBefore = await count('audit_log')
    const security = await count('security_events')
    const settings = await count('settings')

    const res = await http.post('/admin/v1/system/reset').set(admin).send({ parts: ['players', 'raffles', 'finance', 'messages'], confirm: PHRASE, reason: 'Before launch' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const preview = (await http.get('/admin/v1/system/reset').set(admin)).body as AdminResetPreview
    expect(Object.values(preview.counts).every((n) => n === 0)).toBe(true)
    expect(await count('admin_users')).toBe(admins)
    expect(await count('settings')).toBe(settings)
    expect(await count('security_events')).toBeGreaterThanOrEqual(security)
    expect(await count('audit_log')).toBeGreaterThan(auditBefore)
    const [last] = await db.select().from(auditLog).where(eq(auditLog.action, 'data.reset')).orderBy(sql`seq desc`).limit(1)
    expect(last?.targetId).toBe('finance,messages,players,raffles')
    // The audit chain is intact after the reset
    expect((await http.get('/admin/v1/audit-log/verify').set(admin)).body).toMatchObject({ ok: true })
  })
})

describe('the backup', () => {
  it('is a real pg_dump file in the backup folder, written whole before it gets its name', async () => {
    const dir = ctx.config.RESET_BACKUP_DIR!
    const file = await backup.take(ctx, 'check')
    expect(file.startsWith(dir)).toBe(true)
    expect(file).toMatch(/test-before-check-\d{8}-\d{6}Z\.dump$/)
    const { statSync, readdirSync, readFileSync } = await import('node:fs')
    expect(statSync(file).size).toBeGreaterThan(1000)
    // Every player's data is in it: the service user alone may read it (modes do not apply on Windows)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file).subarray(0, 5).toString()).toBe('PGDMP')
    expect(readdirSync(dir).some((f) => f.endsWith('.partial'))).toBe(false)
  }, 120_000)
})

describe('the guards outside a reset', () => {
  it('still refuse deletes, and the audit log refuses them even inside one', async () => {
    const m = await member(http)
    await credit(db, m.userId, 5)
    expect(await refusal(db.execute(sql`delete from ledger where user_id = ${m.userId}`))).toMatch(/ledger is append-only/)
    const raffle = await createRaffle(db)
    expect(await refusal(db.execute(sql`delete from raffle_prizes where raffle_id = ${raffle.id}`))).toBe('not refused') // not guarded
    expect(await refusal(db.execute(sql`delete from raffles where id = ${raffle.id}`))).toMatch(/raffles is append-only/)
    for (const table of ['audit_log', 'security_events']) {
      const said = await refusal(
        db.transaction(async (tx) => {
          await tx.execute(sql`set local raffwin.data_reset = 'on'`)
          await tx.execute(sql.raw(`delete from ${table}`))
        }),
      )
      expect(said).toMatch(new RegExp(`${table} is append-only`))
    }
    expect(await ledgerSum(m.userId)).toBe(5)
  })
})
