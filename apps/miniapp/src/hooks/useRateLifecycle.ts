import { useEffect } from 'react'
import { useAppStore } from '@/store/useAppStore'

/**
 * Keeps the Naira/Raffs quote alive: fetches it on mount and re-fetches the
 * moment the one-hour validity expires. Mount once near the app root.
 */
export function useRateLifecycle(): void {
  const refreshRate = useAppStore((s) => s.refreshRate)
  const tickRate = useAppStore((s) => s.tickRate)
  useEffect(() => {
    void refreshRate()
    const id = window.setInterval(() => tickRate(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [refreshRate, tickRate])
}
