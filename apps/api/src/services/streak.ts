/**
 * Daily streak (feature daily_streak): a small Raffs bonus, claimed once per
 * Lagos calendar day. Claiming on consecutive days grows the streak, and the
 * streak picks the bonus from settings 'streak.rewards' (day 1 = rewards[0];
 * past the end the last value repeats). Missing a day starts again at day 1.
 *
 * One daily_checkins row per claimed day (insert-only, unique per player and
 * day); the bonus is a 'bonus' ledger row, written only when it is above zero.
 */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, max } from 'drizzle-orm'
import type { StreakClaimResult, StreakState } from '@raffwin/shared'
import type { AppContext } from '../context'
import type { Db } from '../db/client'
import { uniqueViolation } from '../db/client'
import { dailyCheckins, users, type UserRow } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { requireFeature } from './features'
import { post } from './ledger'
import { getSetting } from './settings'

type Reader = Pick<Db, 'select'>

const LAGOS_OFFSET_MS = 60 * 60 * 1000
const DAY_MS = 86_400_000

/** The Lagos calendar day (UTC+1, no daylight saving) of `now`, as YYYY-MM-DD. */
export function lagosDay(now: number): string {
  return new Date(now + LAGOS_OFFSET_MS).toISOString().slice(0, 10)
}

/** The bonus for streak day `day` (1-based). */
export function rewardFor(rewards: number[], day: number): number {
  return rewards[Math.min(Math.max(day, 1), rewards.length) - 1] ?? 0
}

const alreadyClaimed = () => new HttpError('ALREADY_CLAIMED', 'You have already claimed today. Come back tomorrow.')

async function lastCheckin(db: Reader, userId: string) {
  const [row] = await db
    .select({ day: dailyCheckins.day, streak: dailyCheckins.streak })
    .from(dailyCheckins)
    .where(eq(dailyCheckins.userId, userId))
    .orderBy(desc(dailyCheckins.day))
    .limit(1)
  return row ?? null
}

async function readState(db: Reader, userId: string, now: number): Promise<StreakState> {
  const today = lagosDay(now)
  const yesterday = lagosDay(now - DAY_MS)
  const [rewards, last, best] = await Promise.all([
    getSetting(db, 'streak.rewards'),
    lastCheckin(db, userId),
    db.select({ best: max(dailyCheckins.streak) }).from(dailyCheckins).where(eq(dailyCheckins.userId, userId)),
  ])
  const claimedToday = last?.day === today
  // A streak is alive while its last claim was today or yesterday
  const current = last && (claimedToday || last.day === yesterday) ? last.streak : 0
  return {
    current,
    claimedToday,
    nextReward: rewardFor(rewards, current + 1),
    rewards,
    lastClaimedDay: last?.day ?? null,
    best: best[0]?.best ?? 0,
  }
}

export async function getStreak(ctx: AppContext, user: UserRow): Promise<StreakState> {
  await requireFeature(ctx.db, 'daily_streak', user.id)
  return readState(ctx.db, user.id, ctx.now())
}

/**
 * Claims today's bonus. The player row is locked for the whole claim, so two
 * taps at once are served one after the other: the second sees today's row and
 * gets ALREADY_CLAIMED (the unique index backs this up).
 */
export async function claimStreak(ctx: AppContext, user: UserRow): Promise<StreakClaimResult> {
  await requireFeature(ctx.db, 'daily_streak', user.id)
  const now = ctx.now()
  const today = lagosDay(now)
  const yesterday = lagosDay(now - DAY_MS)

  let raffs: number
  try {
    raffs = await ctx.db.transaction(async (tx) => {
      const [me] = await tx.select({ status: users.status }).from(users).where(eq(users.id, user.id)).for('update')
      if (!me || me.status !== 'active') {
        throw new HttpError('ACCOUNT_SUSPENDED', 'This account is suspended. Send /paysupport to the bot for help.')
      }
      const [done] = await tx
        .select({ id: dailyCheckins.id })
        .from(dailyCheckins)
        .where(and(eq(dailyCheckins.userId, user.id), eq(dailyCheckins.day, today)))
      if (done) throw alreadyClaimed()

      const last = await lastCheckin(tx, user.id)
      const streak = last?.day === yesterday ? last.streak + 1 : 1
      const reward = rewardFor(await getSetting(tx, 'streak.rewards'), streak)
      const checkinId = randomUUID()
      const credit =
        reward > 0
          ? await post(tx, {
              userId: user.id,
              type: 'bonus',
              raffs: reward,
              note: `Daily streak day ${streak}`,
              referenceType: 'daily_streak',
              referenceId: checkinId,
            })
          : null
      await tx.insert(dailyCheckins).values({ id: checkinId, userId: user.id, day: today, streak, raffs: reward, ledgerId: credit?.id ?? null })
      return reward
    })
  } catch (error) {
    if (uniqueViolation(error) === 'daily_checkins_user_day_key') throw alreadyClaimed()
    throw error
  }

  const [state, [me]] = await Promise.all([
    readState(ctx.db, user.id, now),
    ctx.db.select({ balance: users.balanceCache }).from(users).where(eq(users.id, user.id)),
  ])
  return { state, raffs, balance: me?.balance ?? 0 }
}
