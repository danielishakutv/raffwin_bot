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
}

/** Signs in with fresh initData and completes sign-up. */
export async function member(http: Http, opts: { startParam?: string } = {}): Promise<Member> {
  const id = telegramId()
  const auth = await http.post('/v1/auth/telegram').send({ initData: initData({ id }, { startParam: opts.startParam }) })
  expect(auth.status, JSON.stringify(auth.body)).toBe(200)
  const token = auth.body.accessToken as string
  const username = uniqueUsername()
  const signed = await http
    .post('/v1/signup')
    .set('authorization', `Bearer ${token}`)
    .send({ fullName: 'Ada Obi', username, email: 'a@b.co', contactProof: contactProof(id, nigerianPhone().slice(1)) })
  expect(signed.status, JSON.stringify(signed.body)).toBe(201)
  const profile = (signed.body as Bootstrap).profile
  if (!profile) throw new Error('sign-up returned no profile')
  return {
    userId: profile.id,
    telegramId: id,
    username,
    referralCode: profile.referralCode,
    get: (path) => http.get(path).set('authorization', `Bearer ${token}`),
    post: (path, body) => http.post(path).set('authorization', `Bearer ${token}`).send(body),
  }
}
