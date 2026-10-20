/**
 * 20 Oct: the 4-second poll was the heaviest load on the server. What every
 * player sees alike is now served from a short shared cache, the balance comes
 * from the sign-in check's own row, and the server sets the app's poll pace.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { LiveSnapshot, Raffle } from '@raffwin/shared'
import { adminUsers, entries, featureFlagOverrides, raffles } from '../src/db/schema'
import { CACHE_KEYS, forgetRaffles, SharedCache } from '../src/lib/shared-cache'
import { featuresForLive } from '../src/services/features'
import { nextPollMs } from '../src/services/raffles'
import { createRaffle, credit, member as open } from './fixtures'
import { telegramId, testApp } from './helpers'

const { http, db, ctx } = testApp()

describe('SharedCache', () => {
  it('serves concurrent and repeat reads from one load until it expires', async () => {
    let t = 0
    const cache = new SharedCache(1000, () => t)
    let loads = 0
    const load = async () => {
      loads += 1
      await new Promise((r) => setTimeout(r, 10))
      return loads
    }
    const answers = await Promise.all(Array.from({ length: 50 }, () => cache.get('k', load)))
    expect(new Set(answers)).toEqual(new Set([1]))
    expect(await cache.get('k', load)).toBe(1)
    t = 999
    expect(await cache.get('k', load)).toBe(1)
    t = 1000
    expect(await cache.get('k', load)).toBe(2)
    expect(cache.stats()).toEqual({ hits: 51, loads: 2 })
  })

  it('never caches a failure', async () => {
    const cache = new SharedCache(60_000)
    await expect(cache.get('k', () => Promise.reject(new Error('db down')))).rejects.toThrow('db down')
    expect(await cache.get('k', async () => 'ok')).toBe('ok')
  })

  it('a load that started before an invalidate does not store its older answer', async () => {
    const cache = new SharedCache(60_000)
    let release!: () => void
    const slow = cache.get('k', () => new Promise<string>((r) => (release = () => r('old'))))
    cache.invalidate('k')
    release()
    expect(await slow).toBe('old')
    expect(await cache.get('k', async () => 'new')).toBe('new')
  })
})

describe('/v1/live with the cache on', () => {
  it('raffle counts come from the cache, the balance never does, and the pace speeds up near a draw', async () => {
    ctx.cache = new SharedCache(60_000)
    try {
      const raffle = await createRaffle(db, { entriesCount: 10 })
      const p = await open(http)
      const first = (await p.get('/v1/live')).body as LiveSnapshot
      expect(first.raffles.find((r) => r.id === raffle.id)?.entriesCount).toBe(10)
      expect(first.balance).toBe(0)

      await db.update(raffles).set({ entriesCount: 25 }).where(eq(raffles.id, raffle.id))
      await credit(db, p.userId, 300)
      const second = (await p.get('/v1/live')).body as LiveSnapshot
      expect(second.raffles.find((r) => r.id === raffle.id)?.entriesCount).toBe(10)
      expect(second.balance).toBe(300)

      forgetRaffles(ctx.cache)
      const third = (await p.get('/v1/live')).body as LiveSnapshot
      expect(third.raffles.find((r) => r.id === raffle.id)?.entriesCount).toBe(25)

      // Many players polling: one raffle load serves all of them
      const players = await Promise.all(Array.from({ length: 5 }, () => open(http)))
      const before = ctx.cache.stats().loads
      await Promise.all(players.map((m) => m.get('/v1/live')))
      expect(ctx.cache.stats().loads).toBe(before)

      expect(third.pollMs).toBeGreaterThanOrEqual(3000)
    } finally {
      ctx.cache = undefined
    }
  })

  it('the full raffle list is shared, plus an older drawn raffle only its entrant still sees', async () => {
    ctx.cache = new SharedCache(60_000)
    try {
      const current = await createRaffle(db)
      const old = await createRaffle(db, { status: 'drawn', drawnAt: new Date(Date.now() - 40 * 86_400_000), deadline: new Date(Date.now() - 40 * 86_400_000) })
      const entrant = await open(http)
      const other = await open(http)
      await db.insert(entries).values({ raffleId: old.id, userId: entrant.userId, qty: 1, raffsSpent: 50, ticketFrom: 1, ticketTo: 1, idempotencyKey: randomUUID() })

      const mine = (await entrant.get('/v1/raffles')).body as Raffle[]
      const theirs = (await other.get('/v1/raffles')).body as Raffle[]
      expect(mine.some((r) => r.id === current.id) && theirs.some((r) => r.id === current.id)).toBe(true)
      expect(mine.some((r) => r.id === old.id)).toBe(true)
      expect(theirs.some((r) => r.id === old.id)).toBe(false)
      const deadlines = mine.map((r) => Date.parse(r.deadline))
      expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b))
    } finally {
      ctx.cache = undefined
    }
  })

  it('a player override is read only for players who have one, and shows once the list is refreshed', async () => {
    const cache = new SharedCache(60_000)
    const p = await open(http)
    const before = await featuresForLive(db, p.userId, cache)
    const tg = telegramId()
    const [admin] = await db
      .insert(adminUsers)
      .values({ name: 'Cache test', username: `cache_${tg}`, telegramId: tg, role: 'super_admin', passwordHash: 'x' })
      .returning({ id: adminUsers.id })
    await db.insert(featureFlagOverrides).values({ flagKey: 'raffs_transfer', userId: p.userId, enabled: !before.raffs_transfer, note: 'test', createdByAdminId: admin!.id })
    expect((await featuresForLive(db, p.userId, cache)).raffs_transfer).toBe(before.raffs_transfer)
    cache.invalidate(CACHE_KEYS.overrideUsers)
    expect((await featuresForLive(db, p.userId, cache)).raffs_transfer).toBe(!before.raffs_transfer)
  })
})

describe('the poll pace the server sets', () => {
  const at = Date.parse('2026-10-20T12:00:00Z')
  const row = (status: string, inMs: number) => ({ id: 'x', entriesCount: 0, entriesTarget: 10, status, deadline: new Date(at + inMs).toISOString(), drawnAt: null, version: 'v' })
  it('is the configured pace, faster within 2 minutes of a draw, slower under load, never over a minute', () => {
    expect(nextPollMs([row('open', 3_600_000)], at, 6000)).toBe(6000)
    expect(nextPollMs([row('open', 60_000)], at, 6000)).toBe(3000)
    expect(nextPollMs([row('drawing', -1000)], at, 6000)).toBe(3000)
    expect(nextPollMs([], at, 6000, 2.5)).toBe(15_000)
    expect(nextPollMs([], at, 6000, 50)).toBe(60_000)
  })
})
