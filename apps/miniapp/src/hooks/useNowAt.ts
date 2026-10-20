import { useEffect, useState } from 'react'

/** setTimeout's ceiling (~24.8 days); a longer wait is taken in steps */
const MAX_DELAY = 2_147_483_647

/**
 * The current time, refreshed only as each of the given moments passes,
 * instead of every second. For screens whose look changes at known instants
 * (closing soon, the last hour, the deadline) while a Countdown ticks by itself.
 */
export function useNowAt(moments: number[]): number {
  const [now, setNow] = useState(() => Date.now())
  const key = moments.join(',')
  useEffect(() => {
    const current = Date.now()
    // A timer that fired a hair early finds the same moment again and simply re-arms
    const next = moments.filter((m) => m > current).sort((a, b) => a - b)[0]
    if (next === undefined) return
    const id = window.setTimeout(() => setNow(Date.now()), Math.min(MAX_DELAY, next - current + 50))
    return () => window.clearTimeout(id)
    // `key` stands for `moments`; `now` re-arms the timer after each refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, now])
  return now
}
