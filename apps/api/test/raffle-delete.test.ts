/**
 * 20 Oct: admins can delete and archive raffles.
 *   delete   gone from the Mini App for every player (entrants and winners
 *            included) and from the admin list; an open raffle is refunded first
 *   archive  drawn or cancelled only: gone from the Mini App for every player,
 *            still in the admin under Archived, and can be unarchived
 * Either way every row stays in the database.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Entry, Raffle } from '@raffwin/shared'
import type { AdminRaffle } from '@raffwin/shared/admin-types'
import { hashPassword, issueTicket } from '../src/admin/session'
import { adminUsers, auditLog, broadcasts, entries, ledger, raffles, users, type AdminRole } from '../src/db/schema'
import { newDrawSeed, settleRaffle } from '../src/services/draw'
import { forgetRaffles } from '../src/lib/shared-cache'
import { createRaffle, credit, member as open } from './fixtures'
import { contactProof, initData, nigerianPhone, telegramId, testApp } from './helpers'

const { http, db, ctx } = testApp()

async function signIn(role: AdminRole) {
  const tg = telegramId()
  const [a] = await db
    .insert(adminUsers)
    .values({ name: `Delete ${role}`, username: `del_${tg}`, telegramUsername: `del${tg}`, telegramId: tg, role, passwordHash: await hashPassword('x'.repeat(16)) })
    .returning({ id: adminUsers.id })
  const ticket = await issueTicket(ctx, a!.id, tg)
  const res = await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: tg }) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { authorization: `Bearer ${res.body.token as string}` }
}

async function player() {
  const m = await open(http)
  const res = await m.put('/v1/phone', { contactProof: contactProof(m.telegramId, nigerianPhone().slice(1)) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return m
}
type Player = Awaited<ReturnType<typeof player>>

async function buy(m: Player, raffleId: string, qty: number) {
  await credit(db, m.userId, qty * 10)
  const res = await m.post('/v1/entries', { raffleId, qty, idempotencyKey: randomUUID() })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
}

/** A raffle with 5 tickets sold to `m`, drawn */
async function drawnRaffle(m: Player) {
  const { seed, commitment } = newDrawSeed()
  const raffle = await createRaffle(db, { entryPriceRaffs: 10, drawSeed: seed, seedCommitment: commitment })
  await buy(m, raffle.id, 5)
  await db.update(raffles).set({ deadline: new Date(Date.now() - 1000) }).where(eq(raffles.id, raffle.id))
  expect(await settleRaffle(ctx, raffle.id)).toBe('drawn')
  return raffle
}

const balanceOf = async (userId: string) => (await db.select({ b: users.balanceCache }).from(users).where(eq(users.id, userId)))[0]?.b ?? 0
const ids = async (auth: { authorization: string }, query = '') => ((await http.get(`/admin/v1/raffles${query}`).set(auth)).body as AdminRaffle[]).map((r) => r.id)
const playerList = async (m: Player) => {
  forgetRaffles(ctx.cache)
  return ((await m.get('/v1/raffles')).body as Raffle[]).map((r) => r.id)
}
const myEntries = async (m: Player, raffleId: string) => ((await m.get('/v1/entries')).body as Entry[]).filter((e) => e.raffleId === raffleId)

/** Nothing about this raffle reaches this player: not the list, not its page, not My entries */
async function goneFor(m: Player, raffleId: string) {
  expect(await playerList(m)).not.toContain(raffleId)
  expect((await m.get(`/v1/raffles/${raffleId}`)).status).toBe(404)
  expect(await myEntries(m, raffleId)).toHaveLength(0)
}

describe('deleting a raffle', () => {
  it('a draft goes at once for a raffle manager, leaves every list, and the row can never really be removed', async () => {
    const manager = await signIn('raffle_manager')
    const draft = await createRaffle(db, { status: 'draft', openedAt: null })
    const res = await http.post(`/admin/v1/raffles/${draft.id}/delete`).set(manager).send({ reason: 'Old test draft' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ id: draft.id, status: 'draft' })
    expect(res.body.deletedAt).toBeTruthy()

    expect(await ids(manager)).not.toContain(draft.id)
    expect(await ids(manager, '?status=archived')).not.toContain(draft.id)
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, draft.id), eq(auditLog.action, 'raffle.delete')))
    expect(audit?.after).toMatchObject({ reason: 'Old test draft' })

    const publish = await http.post(`/admin/v1/raffles/${draft.id}/open`).set(manager).send({})
    expect(publish.status).toBe(400)
    expect(publish.body.error.message).toBe('This raffle has been deleted.')
    // The trigger fires before any foreign key is checked, so this is the trigger refusing, not the prizes pointing at it
    await expect(db.execute(sql`delete from raffles where id = ${draft.id}`)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/raffles is append-only: DELETE refused/) }),
    })
  })

  it('an open raffle is refunded in full first and the entrants told, then it is gone from the app, entrants included', async () => {
    const boss = await signIn('super_admin')
    const raffle = await createRaffle(db, { entryPriceRaffs: 10 })
    const a = await player()
    const b = await player()
    await buy(a, raffle.id, 3)
    await buy(b, raffle.id, 1)
    expect(await balanceOf(a.userId)).toBe(0)

    const res = await http.post(`/admin/v1/raffles/${raffle.id}/delete`).set(boss).send({ reason: 'Supplier cannot deliver' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ action: 'raffle_delete', status: 'approved' })
    expect(res.body.result).toMatchObject({ statusBefore: 'open', entriesRefunded: 2, raffsRefunded: 40, direct: true })

    expect(await balanceOf(a.userId)).toBe(30)
    expect(await balanceOf(b.userId)).toBe(10)
    const refunds = await db.select().from(ledger).where(and(eq(ledger.userId, a.userId), eq(ledger.type, 'refund')))
    expect(refunds.map((r) => r.raffs)).toEqual([30])
    const [row] = await db.select().from(raffles).where(eq(raffles.id, raffle.id))
    expect(row).toMatchObject({ status: 'cancelled' })
    expect(row?.deletedAt).toBeTruthy()
    expect(await db.select().from(broadcasts).where(and(eq(broadcasts.refId, raffle.id), eq(broadcasts.kind, 'raffle_cancelled')))).toHaveLength(1)

    await goneFor(a, raffle.id)
    await goneFor(b, raffle.id)
    // The money lines stay in the wallet, and the entry rows in the database
    expect(((await a.get('/v1/transactions')).body as { type: string }[]).some((t) => t.type === 'refund')).toBe(true)
    expect(await db.select().from(entries).where(eq(entries.raffleId, raffle.id))).toHaveLength(2)
    expect(await ids(boss)).not.toContain(raffle.id)
    expect((await http.post(`/admin/v1/raffles/${raffle.id}/delete`).set(boss).send({ reason: 'Again please' })).status).toBe(400)
  })

  it('anyone but a super admin only asks; a second admin approving does the refund and delete', async () => {
    const manager = await signIn('raffle_manager')
    const approver = await signIn('super_admin')
    const raffle = await createRaffle(db, { entryPriceRaffs: 10 })
    const a = await player()
    await buy(a, raffle.id, 2)

    const asked = await http.post(`/admin/v1/raffles/${raffle.id}/delete`).set(manager).send({ reason: 'Wrong prize photo' })
    expect(asked.status, JSON.stringify(asked.body)).toBe(202)
    expect(asked.body.summary).toBe('Delete "Tecno Spark 20" and refund 2 entries')
    expect(await playerList(a)).toContain(raffle.id)
    expect(await balanceOf(a.userId)).toBe(0)

    const ok = await http.post(`/admin/v1/approvals/${asked.body.id}/approve`).set(approver).send({})
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await balanceOf(a.userId)).toBe(20)
    await goneFor(a, raffle.id)
  })

  it('a drawn raffle disappears for everyone, the winner too; prizes already won stay won', async () => {
    const boss = await signIn('super_admin')
    const winner = await player()
    const raffle = await drawnRaffle(winner)
    const won = await balanceOf(winner.userId)
    expect(won).toBeGreaterThan(0) // the Raffs prizes

    const res = await http.post(`/admin/v1/raffles/${raffle.id}/delete`).set(boss).send({ reason: 'Clearing old raffles' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.summary).toBe('Delete "Tecno Spark 20" (drawn) from the app and the admin')
    expect(res.body.result).toMatchObject({ statusBefore: 'drawn', entriesRefunded: 0 })
    await goneFor(winner, raffle.id)
    expect(await balanceOf(winner.userId)).toBe(won)
  })

  it('is refused while the draw owns an open raffle, and for a viewer', async () => {
    const boss = await signIn('super_admin')
    const viewer = await signIn('viewer')
    const due = await createRaffle(db, { deadline: new Date(Date.now() - 1000) })
    const res = await http.post(`/admin/v1/raffles/${due.id}/delete`).set(boss).send({ reason: 'Too late now' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('draw is running')
    const fresh = await createRaffle(db)
    expect((await http.post(`/admin/v1/raffles/${fresh.id}/delete`).set(viewer).send({ reason: 'Not allowed' })).status).toBe(403)
  })
})

describe('archiving a raffle', () => {
  it('a drawn raffle leaves the app for everyone, stays in the admin under Archived, and comes back when unarchived', async () => {
    const manager = await signIn('raffle_manager')
    const winner = await player()
    const outsider = await player()
    const raffle = await drawnRaffle(winner)
    expect(await playerList(outsider)).toContain(raffle.id)

    const res = await http.post(`/admin/v1/raffles/${raffle.id}/archive`).set(manager).send({ reason: 'Old raffle' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ status: 'drawn', archivedBy: 'Delete raffle_manager', deletedAt: null })
    await goneFor(winner, raffle.id)
    await goneFor(outsider, raffle.id)
    expect(await ids(manager)).not.toContain(raffle.id)
    expect(await ids(manager, '?status=archived')).toContain(raffle.id)
    expect((await http.post(`/admin/v1/raffles/${raffle.id}/archive`).set(manager).send({ reason: 'Twice over' })).status).toBe(400)

    const back = await http.post(`/admin/v1/raffles/${raffle.id}/unarchive`).set(manager).send({ reason: 'Show it again' })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(back.body).toMatchObject({ archivedAt: null, archivedBy: null })
    expect(await playerList(winner)).toContain(raffle.id)
    expect(await myEntries(winner, raffle.id)).toHaveLength(1)
    expect(await ids(manager)).toContain(raffle.id)
    const audit = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.targetId, raffle.id))
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['raffle.archive', 'raffle.unarchive']))
  })

  it('a cancelled raffle shows as refunded in My entries until it is archived', async () => {
    const boss = await signIn('super_admin')
    const raffle = await createRaffle(db, { entryPriceRaffs: 10 })
    const a = await player()
    await buy(a, raffle.id, 2)
    expect((await http.post(`/admin/v1/raffles/${raffle.id}/cancel`).set(boss).send({ reason: 'Supplier let us down' })).status).toBe(200)
    expect((await myEntries(a, raffle.id))[0]?.raffle).toMatchObject({ prizeName: 'Tecno Spark 20', refunded: true })

    expect((await http.post(`/admin/v1/raffles/${raffle.id}/archive`).set(boss).send({ reason: 'Tidy up' })).status).toBe(200)
    expect(await myEntries(a, raffle.id)).toHaveLength(0)
    expect(await balanceOf(a.userId)).toBe(20)
  })

  it('only drawn or cancelled raffles can be archived; an archived one can still be deleted', async () => {
    const manager = await signIn('raffle_manager')
    const boss = await signIn('super_admin')
    const live = await createRaffle(db)
    const refused = await http.post(`/admin/v1/raffles/${live.id}/archive`).set(manager).send({ reason: 'Not yet please' })
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toContain('Only a drawn or cancelled raffle')

    const winner = await player()
    const raffle = await drawnRaffle(winner)
    expect((await http.post(`/admin/v1/raffles/${raffle.id}/archive`).set(manager).send({ reason: 'Old raffle' })).status).toBe(200)
    expect((await http.post(`/admin/v1/raffles/${raffle.id}/delete`).set(boss).send({ reason: 'Gone for good' })).status).toBe(200)
    expect(await ids(boss, '?status=archived')).not.toContain(raffle.id)
    expect((await http.post(`/admin/v1/raffles/${raffle.id}/unarchive`).set(boss).send({ reason: 'Bring it back' })).status).toBe(404)
  })
})
