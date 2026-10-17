/** Reward for streak day `day` (1-based); past the end of the list the last value repeats. */
export function rewardForDay(rewards: number[], day: number): number {
  if (rewards.length === 0) return 0
  return rewards[Math.min(Math.max(day, 1), rewards.length) - 1]
}

/** Seven days around today: from day 1 while the streak is young, then three back and three ahead. */
export function stripDays(today: number): number[] {
  const start = Math.max(1, today - 3)
  return Array.from({ length: 7 }, (_, i) => start + i)
}
