/**
 * Vouchers sold offline (19 Oct): a batch needs two admins, its codes are
 * handed out once and stored hashed, each code works once, and guessing is
 * stopped per player.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { AdminVoucherBatch } from '@raffwin/shared/admin-types'
import { hashPassword, issueTicket } from '../src/admin/session'
import { adminUsers, auditLog, ledger, voucherBatches, vouchers, type AdminRole } from '../src/db/schema'
import { formatCode, generateCode, hashCode, normalizeCode, VOUCHER_ALPHABET } from '../src/services/vouchers'
import { member as open } from './fixtures'
import { initData, telegramId, testApp } from './helpers'

const { http, db, ctx } = testApp()

/** An admin session, made the way the other admin tests make them */
async function admin(role: AdminRole) {
  const tg = telegramId()
  const [a] = await db
    .insert(adminUsers)
    .values({ name: `Voucher ${role}`, username: `vch_${tg}`, telegramUsername: `vch${tg}`, telegramId: tg, role, passwordHash: await hashPassword('x'.repeat(16)) })
    .returning({ id: adminUsers.id })
  const ticket = await issueTicket(ctx, a!.id, tg)
  const res = await http.post('/admin/v1/auth/ticket').send({ ticket, initData: initData({ id: tg }) })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const headers = { authorization: `Bearer ${res.body.token as string}` }
  return {
    id: a!.id,
    get: (path: string) => http.get(`/admin/v1${path}`).set(headers),
    post: (path: string, body: object = {}) => http.post(`/admin/v1${path}`).set(headers).send(body),
  }
}

async function approvedBatch(valueRaffs = 500, count = 3, expiresAt: string | null = null) {
  const finance = await admin('finance')
  const boss = await admin('super_admin')
  const asked = await finance.post('/vouchers/batches', { vendor: 'Jibowu Kiosk 4', valueRaffs, count, expiresAt, reason: 'Vendor restock' })
  expect(asked.status, JSON.stringify(asked.body)).toBe(202)
  const ok = await boss.post(`/approvals/${asked.body.id}/approve`)
  expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  const batchId = ok.body.result.batchId as string
  return { finance, boss, batchId, approvalId: asked.body.id as string }
}

describe('voucher codes', () => {
  it('are 16 characters from an alphabet with no look-alikes, typed any way', () => {
    const c = generateCode()
    expect(c).toHaveLength(16)
    expect([...c].every((ch) => VOUCHER_ALPHABET.includes(ch))).toBe(true)
    expect(VOUCHER_ALPHABET).not.toMatch(/[01IO]/)
    expect(formatCode('ABCDEFGHJKLMNPQR')).toBe('ABCD-EFGH-JKLM-NPQR')
    expect(normalizeCode(' abcd-efgh jklm-npqr ')).toBe('ABCDEFGHJKLMNPQR')
    expect(normalizeCode('ABCD-EFGH-JKLM-NPQ0')).toBeNull()
    expect(normalizeCode('SHORT')).toBeNull()
  })
})

describe('voucher batches', () => {
  it('need a second admin, then hand out their codes exactly once, stored only as hashes', async () => {
    const { finance, batchId, approvalId } = await approvedBatch(500, 3)
    const listed = ((await finance.get('/vouchers/batches')).body as AdminVoucherBatch[]).find((b) => b.id === batchId)
    expect(listed).toMatchObject({ vendor: 'Jibowu Kiosk 4', valueRaffs: 500, count: 3, redeemed: 0, status: 'ready', codesIssuedAt: null })

    const issued = await finance.post(`/vouchers/batches/${batchId}/issue`)
    expect(issued.status, JSON.stringify(issued.body)).toBe(200)
    const codes = issued.body.codes as string[]
    expect(codes).toHaveLength(3)
    expect(codes.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c))).toBe(true)

    // Never shown again
    const again = await finance.post(`/vouchers/batches/${batchId}/issue`)
    expect(again.status).toBe(409)

    // The table holds hashes and the last 4, never a code
    const rows = await db.select().from(vouchers).where(eq(vouchers.batchId, batchId))
    expect(rows).toHaveLength(3)
    for (const c of codes) {
      const plain = c.replaceAll('-', '')
      expect(rows.some((r) => r.codeHash === hashCode(plain) && r.codeTail === plain.slice(-4))).toBe(true)
      expect(JSON.stringify(rows)).not.toContain(plain)
    }
    // ...and so does the audit trail
    const audit = await db.select().from(auditLog).where(eq(auditLog.targetId, approvalId))
    expect(JSON.stringify(audit)).not.toContain(codes[0]!.replaceAll('-', ''))
  })

  it('a viewer can look but not ask; a batch above 5,000 codes is refused', async () => {
    const viewer = await admin('viewer')
    expect((await viewer.get('/vouchers/batches')).status).toBe(200)
    expect((await viewer.post('/vouchers/batches', { vendor: 'X shop', valueRaffs: 10, count: 2, expiresAt: null, reason: 'Trying it' })).status).toBe(403)
    const finance = await admin('finance')
    expect((await finance.post('/vouchers/batches', { vendor: 'X shop', valueRaffs: 10, count: 5001, expiresAt: null, reason: 'Too many' })).status).toBe(400)
  })
})

describe('redeeming', () => {
  it('adds the Raffs once; a second use is refused; admins see who used it', async () => {
    const { finance, batchId } = await approvedBatch(250, 2)
    const [code] = (await finance.post(`/vouchers/batches/${batchId}/issue`)).body.codes as string[]
    const ada = await open(http)
    const res = await ada.post('/v1/vouchers/redeem', { code: code!.toLowerCase().replaceAll('-', ' ') })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ raffs: 250, balance: 250 })
    const [entry] = await db.select().from(ledger).where(and(eq(ledger.userId, ada.userId), eq(ledger.type, 'voucher')))
    expect(entry).toMatchObject({ raffs: 250, note: `Voucher ...${code!.slice(-4)}` })

    const bayo = await open(http)
    const twice = await bayo.post('/v1/vouchers/redeem', { code })
    expect(twice.status).toBe(400)
    expect(twice.body.error.message).toBe('That code has already been used.')
    expect((await bayo.get('/v1/bootstrap')).body.balance).toBe(0)

    const found = await finance.post('/vouchers/lookup', { code })
    expect(found.body).toMatchObject({ found: true, status: 'redeemed', vendor: 'Jibowu Kiosk 4', valueRaffs: 250, redeemedBy: { userId: ada.userId } })
    expect((await finance.post('/vouchers/lookup', { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' })).body).toEqual({ found: false })
  })

  it('two players racing for one code: exactly one gets it', async () => {
    const { finance, batchId } = await approvedBatch(100, 1)
    const [code] = (await finance.post(`/vouchers/batches/${batchId}/issue`)).body.codes as string[]
    const players = [await open(http), await open(http), await open(http), await open(http)]
    const results = await Promise.all(players.map((p) => p.post('/v1/vouchers/redeem', { code })))
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    const balances = await Promise.all(players.map(async (p) => (await p.get('/v1/bootstrap')).body.balance as number))
    expect(balances.sort()).toEqual([0, 0, 0, 100])
  })

  it('voided and expired codes do not work', async () => {
    const { finance, batchId } = await approvedBatch(100, 3)
    const codes = (await finance.post(`/vouchers/batches/${batchId}/issue`)).body.codes as string[]
    const p = await open(http)
    // One code voided on its own
    expect((await finance.post('/vouchers/void-code', { code: codes[0] })).body).toMatchObject({ voided: true })
    expect((await p.post('/v1/vouchers/redeem', { code: codes[0] })).status).toBe(400)
    // The whole batch voided: the rest stop too, and it cannot be voided twice
    expect((await finance.post(`/vouchers/batches/${batchId}/void`, { reason: 'Vendor lost the sheet' })).body).toEqual({ codesVoided: 2 })
    expect((await p.post('/v1/vouchers/redeem', { code: codes[1] })).status).toBe(400)
    expect((await finance.post(`/vouchers/batches/${batchId}/void`, { reason: 'Again please' })).status).toBe(409)

    const soon = new Date(Date.now() + 60_000).toISOString()
    const later = await approvedBatch(100, 1, soon)
    const [code] = (await later.finance.post(`/vouchers/batches/${later.batchId}/issue`)).body.codes as string[]
    // Move the batch's expiry into the past instead of waiting
    await db.update(voucherBatches).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(voucherBatches.id, later.batchId))
    const expired = await p.post('/v1/vouchers/redeem', { code })
    expect(expired.body.error.message).toBe('That code has expired.')
    expect((await p.get('/v1/bootstrap')).body.balance).toBe(0)
  })

  it('stops a player after 5 wrong codes in an hour', async () => {
    const p = await open(http)
    for (let i = 0; i < 5; i++) expect((await p.post('/v1/vouchers/redeem', { code: generateCode() })).status).toBe(400)
    const blocked = await p.post('/v1/vouchers/redeem', { code: generateCode() })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe('LIMIT_REACHED')
  })
})
