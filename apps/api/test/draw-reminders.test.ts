/**
 * Draw reminders (19 Oct): 1 hour, 30 minutes and 5 minutes before a draw.
 * Entrants get their own message with their tickets; everyone else with alerts
 * and reminders on gets one "last chance" broadcast, never at night and not
 * once sold out. Players and entries are made first, in real time (initData
 * must be fresh); then the clock moves to known Lagos times.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, like } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { broadcasts, featureFlagOverrides, notifications, raffleReminders, type RaffleRow } from '../src/db/schema'
import { settleRaffle } from '../src/services/draw'
import { remindOne } from '../src/services/draw-reminders'
import { fanOutOnce } from '../src/services/notify'
import { createRaffle, credit, member as open, type Member } from './fixtures'
import { contactProof, nigerianPhone, testApp } from './helpers'

const { http, db, ctx, clock } = testApp({ PUBLIC_APP_URL: 'https://raffwintest.example/' })
const MIN = 60_000

/** The next Lagos clock time hh:00 at least 2 hours after now (Lagos is UTC+1) */
function nextLagos(hour: number, after = Date.now() + 2 * 3_600_000): number {
  const d = new Date(after)
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 1)
  while (t < after) t += 86_400_000
  return t
}
/** Moves the test clock to an absolute time */
const setClock = (ms: number) => clock.advance((ms - ctx.now()) / 1000)

const NOON = nextLagos(12)
const NIGHT = nextLagos(23, NOON)

async function player(): Promise<Member> {
  const m = await open(http)
  expect((await m.put('/v1/phone', { contactProof: contactProof(m.telegramId, nigerianPhone().slice(1)) })).status).toBe(200)
  return m
}
async function buy(m: Member, raffle: RaffleRow, qty: number) {
  await credit(db, m.userId, qty * raffle.entryPriceRaffs)
  const res = await m.post('/v1/entries', { raffleId: raffle.id, qty, idempotencyKey: randomUUID() })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
}
const soonFor = (raffleId: string) => db.select().from(notifications).where(and(eq(notifications.kind, 'raffle_soon'), like(notifications.dedupeKey, `soon:${raffleId}:%`)))
const lastChance = (raffleId: string) => db.select().from(broadcasts).where(and(eq(broadcasts.kind, 'raffle_soon'), eq(broadcasts.refId, raffleId)))

let ada: Member, bayo: Member, chidi: Member, quiet: Member, muted: Member
let a: RaffleRow, b: RaffleRow, soldOut: RaffleRow, night: RaffleRow

beforeAll(async () => {
  ;[ada, bayo, chidi, quiet, muted] = [await player(), await player(), await player(), await player(), await player()]
  a = await createRaffle(db, { entryPriceRaffs: 10, deadline: new Date(NOON + 59 * MIN) })
  b = await createRaffle(db, { entryPriceRaffs: 10, deadline: new Date(NOON + 20 * MIN) })
  soldOut = await createRaffle(db, { entryPriceRaffs: 10, entriesTarget: 5, deadline: new Date(NOON + 5 * MIN) })
  night = await createRaffle(db, { entryPriceRaffs: 10, deadline: new Date(NIGHT + 30 * MIN) })
  await buy(ada, a, 3)
  await buy(bayo, a, 1)
  await buy(muted, a, 2)
  await buy(ada, b, 5)
  await buy(bayo, soldOut, 5)
  await buy(chidi, night, 1)
  // quiet switched reminders off; muted has draw reminders switched off by an admin
  expect((await quiet.put('/v1/profile/reminders', { on: false })).status).toBe(200)
  await db.insert(featureFlagOverrides).values({ flagKey: 'draw_reminders', userId: muted.userId, enabled: false, note: 'test' })
})

describe('draw reminders', () => {
  it('an hour before: each entrant hears their tickets, the shortfall, and everyone else gets a last chance', async () => {
    setClock(NOON)
    expect(await remindOne(ctx, a.id)).toEqual({ stage: 60, entrants: 2, broadcast: true })
    const sent = await soonFor(a.id)
    const text = (m: Member) => sent.find((n) => n.userId === m.userId)?.text
    // 6 tickets sold, enough to draw: no shortfall line
    expect(text(ada)).toBe('<b>Tecno Spark 20: the draw is in 59 minutes</b>\n\nYou hold 3 tickets. Open Raffle Win at 12:59 pm (Lagos time) to watch the draw live.')
    expect(text(bayo)).toMatch(/^<b>Tecno Spark 20: the draw is in 59 minutes<\/b>\n\nYou hold 1 ticket\./)
    expect(text(muted)).toBeUndefined()
    expect(sent[0]?.buttons).toEqual([[{ text: 'Open Raffle Win', webApp: `https://raffwintest.example/#/raffles/${a.id}` }]])

    const [bc] = await lastChance(a.id)
    expect(bc).toMatchObject({ title: 'Last chance: Tecno Spark 20', audience: { type: 'all' }, openButton: true })
    expect(bc?.text).toBe('Entries close in 59 minutes, at 12:59 pm (Lagos time). One entry: 10 Raffs.\n\nThe draw is live in the app the moment entries close.')
    await fanOutOnce(ctx, 5000, 100)
    const reached = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(and(eq(notifications.broadcastId, bc!.id), inArray(notifications.userId, [ada.userId, bayo.userId, chidi.userId, quiet.userId, muted.userId])))
    // Not the entrants (they have their own), not who switched reminders off
    expect(reached.map((r) => r.userId)).toEqual([chidi.userId])

    // Once only
    expect(await remindOne(ctx, a.id)).toBeNull()
  })

  it('a raffle short of 5 entries says so to its entrants', async () => {
    const short = await createRaffle(db, { entryPriceRaffs: 10, deadline: new Date(NOON + 30 * MIN) })
    // Back to real time to enter (the player's session is checked against the clock)
    setClock(Date.now())
    await buy(chidi, short, 2)
    setClock(NOON)
    expect(await remindOne(ctx, short.id)).toMatchObject({ stage: 30, entrants: 1 })
    const [n] = await soonFor(short.id)
    expect(n?.text).toContain('It has 2 of the 5 entries it needs to be drawn. If it is still short at the deadline, it is not drawn and every entry is refunded in full.')
  })

  it('a stage reached late sends only the closest one, with the real time left', async () => {
    setClock(NOON)
    expect(await remindOne(ctx, b.id)).toEqual({ stage: 30, entrants: 1, broadcast: true })
    const [n] = await soonFor(b.id)
    expect(n?.text).toMatch(/the draw is in 20 minutes<\/b>\n\nYou hold 5 tickets\./)
    const stages = await db.select({ stage: raffleReminders.stage }).from(raffleReminders).where(eq(raffleReminders.raffleId, b.id))
    expect(stages.map((s) => s.stage).sort()).toEqual([30, 60])
  })

  it('30 and 5 minutes before follow; nothing in the last minute', async () => {
    setClock(NOON + 29 * MIN)
    expect(await remindOne(ctx, a.id)).toMatchObject({ stage: 30 })
    setClock(NOON + 54 * MIN)
    expect(await remindOne(ctx, a.id)).toMatchObject({ stage: 5 })
    expect((await soonFor(a.id)).filter((n) => n.userId === ada.userId).map((n) => n.templateKey)).toEqual(['soon_60', 'soon_30', 'soon_5'])
    setClock(NOON + 58 * MIN + 20_000)
    expect(await remindOne(ctx, a.id)).toBeNull()
  })

  it('no last chance for a sold-out raffle; entrants still hear', async () => {
    setClock(NOON)
    expect(await remindOne(ctx, soldOut.id)).toEqual({ stage: 5, entrants: 1, broadcast: false })
  })

  it('the draw stops reminders still waiting to go out', async () => {
    setClock(NOON + 59 * MIN + 1000)
    expect(await settleRaffle(ctx, a.id)).toBe('drawn')
    const left = (await soonFor(a.id)).filter((n) => n.status === 'pending')
    expect(left).toHaveLength(0)
    expect((await lastChance(a.id)).every((x) => x.status === 'cancelled' || x.status === 'done')).toBe(true)
  })

  it('at night only the entrants hear', async () => {
    setClock(NIGHT)
    expect(await remindOne(ctx, night.id)).toEqual({ stage: 30, entrants: 1, broadcast: false })
  })
})
