import { useNow } from './useNow'
import { useAppStore } from '@/store/useAppStore'
import { isRateValid, type RateQuote } from '@/services/rates'

export interface LiveRate {
  quote: RateQuote | null
  /** True only while a quote exists and its hour has not run out */
  valid: boolean
  remainingMs: number
  status: ReturnType<typeof useAppStore.getState>['rateStatus']
}

/** The live Naira/Raffs quote plus a ticking expiry. */
export function useRate(): LiveRate {
  const now = useNow(1000)
  const quote = useAppStore((s) => s.rate)
  const status = useAppStore((s) => s.rateStatus)
  const valid = status === 'ready' && isRateValid(quote, now)
  return {
    quote: valid ? quote : null,
    valid,
    remainingMs: valid && quote ? quote.expiresAt - now : 0,
    status,
  }
}
