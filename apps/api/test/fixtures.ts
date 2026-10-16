/** Test data builders that go straight to the database (the admin API is tested separately). */
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { Bootstrap } from '@raffwin/shared'
import type { Db } from '../src/db/client'
import { rafflePrizes, raffles, type RaffleRow } from '../src/db/schema'
import { post } from '../src/services/ledger'
import { contactProof, initData, nigerianPhone, telegramId, uniqueUsername } from './helpers'
import type supertest from 'supertest'

type Http = ReturnType<typeof supertest>

export async function createRaffle(
  db: Db,
  overrides: Partial<typeof raffles.$inferInsert> = {},
): Promise<RaffleRow> {
  const [row] = await db
    .insert(raffles)
    .values({
      slug: `test-${randomUUID().slice(0, 8)}`,
      prizeName: 'Tecno Spark 20',
      model: '128GB',
      category: 'Phones',
      kind: 'phone',
      marketPriceNaira: 150_000,
      entryPriceRaffs: 50,
      entriesTarget: 100,
      deadline: new Date(Date.now() + 86_400_000),
      status: 'open',
      openedAt: new Date(),
      rules: ['One draw, three winners'],
      ...overrides,
    })
    .returning()
  if (!row) throw new Error('raffle insert failed')
  await db.insert(rafflePrizes).values([
    { raffleId: row.id, position: 1, prizeItem: 'Tecno Spark 20', prizeType: 'physical' },
    { raffleId: row.id, position: 2, prizeItem: '5,000 Raffs credit', prizeType: 'raffs_credit', raffsValue: 5000 },
    { raffleId: row.id, position: 3, prizeItem: '1,000 Raffs credit', prizeType: 'raffs_credit', raffsValue: 1000 },
  ])
  return row
}

export async function credit(db: Db, userId: string, raffs: number): Promise<void> {
  await db.transaction((tx) => post(tx, { userId, type: 'adjustment', raffs, note: 'test credit' }))
}

export interface Member {
  userId: string
  telegramId: number
  username: string
  referralCode: string
  get: (path: string) => supertest.Test
  post: (path: string, body?: object) => supertest.Test
  put: (path: string, body: object) => supertest.Test
  patch: (path: string, body: object) => supertest.Test
}

/** Opens the app with fresh initData: that alone creates the account (no sign-up form). */
export async function member(http: Http, opts: { startParam?: string; username?: string } = {}): Promise<Member> {
  const id = telegramId()
  const username = opts.username ?? uniqueUsername()
  const auth = await http
    .post('/v1/auth/telegram')
    .send({ initData: initData({ id, username, first_name: 'Ada' }, { startParam: opts.startParam }) })
  expect(auth.status, JSON.stringify(auth.body)).toBe(200)
  const token = auth.body.accessToken as string
  const boot = await http.get('/v1/bootstrap').set('authorization', `Bearer ${token}`)
  const profile = (boot.body as Bootstrap).profile
  if (!profile) throw new Error('first open returned no profile')
  return {
    userId: profile.id,
    telegramId: id,
    username: profile.username,
    referralCode: profile.referralCode,
    get: (path) => http.get(path).set('authorization', `Bearer ${token}`),
    post: (path, body) => http.post(path).set('authorization', `Bearer ${token}`).send(body),
    put: (path, body) => http.put(path).set('authorization', `Bearer ${token}`).send(body),
    patch: (path, body) => http.patch(path).set('authorization', `Bearer ${token}`).send(body),
  }
}

/** A valid KYC body with a fresh, Telegram-signed phone share for this member. */
export function kyc(m: Pick<Member, 'telegramId'>, overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Ada Obi',
    state: 'Lagos',
    city: 'Ikeja',
    motorPark: 'Ojota Motor Park',
    contactProof: contactProof(m.telegramId, nigerianPhone().slice(1)),
    ...overrides,
  }
}
