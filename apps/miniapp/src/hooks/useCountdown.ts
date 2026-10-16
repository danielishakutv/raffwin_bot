import { useNow } from './useNow'
import { splitDuration, type Duration } from '@/services/format'
import { URGENT_MS } from '@/data/raffleStatus'

export interface Countdown extends Duration {
  done: boolean
  urgent: boolean
}

/** Live countdown to an ISO timestamp (or epoch ms). Ticks every second. */
export function useCountdown(target: string | number | Date): Countdown {
  const now = useNow(1000)
  const end = new Date(target).getTime()
  const remaining = end - now
  const d = splitDuration(remaining)
  return { ...d, done: remaining <= 0, urgent: remaining > 0 && remaining <= URGENT_MS }
}
