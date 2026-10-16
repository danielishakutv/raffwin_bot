/**
 * Keeps what the player sees current without a refresh: entry counts filling
 * up, balance changes, new or finished raffles.
 *
 * A short poll is the backbone (it repairs a missed change within seconds,
 * where a missed push event would be lost for good). It runs only while the
 * app is on screen, backs off after failures, says so when it pauses, and does
 * a full reload whenever the app comes back to the foreground.
 */
import { useEffect } from 'react'
import * as api from '@/api'
import { errorMessage } from '@/api/errors'
import { getWebApp } from '@/services/telegram'
import { useAppStore } from '@/store/useAppStore'

const BASE_MS = 4000
const MAX_MS = 60_000
/** Failures in a row before the player is told updates are paused */
const TELL_AFTER = 3

export function useLiveSync(): void {
  const booted = useAppStore((s) => s.booted)

  useEffect(() => {
    if (!booted) return
    const { applyLive, refreshAll, setLiveError } = useAppStore.getState()
    let stopped = false
    let failures = 0
    let inFlight = false
    let timer: number | undefined

    const tick = async () => {
      if (stopped) return
      if (document.visibilityState === 'visible' && !inFlight) {
        inFlight = true
        try {
          await applyLive(await api.getLive())
          failures = 0
          setLiveError(null)
        } catch (error) {
          failures += 1
          console.warn('[live] update failed', failures, error)
          if (failures >= TELL_AFTER) setLiveError(errorMessage(error, 'Could not reach Raffle Win.'))
        } finally {
          inFlight = false
        }
      }
      const delay = failures ? Math.min(MAX_MS, BASE_MS * 2 ** failures) : BASE_MS
      timer = window.setTimeout(() => void tick(), delay)
    }
    timer = window.setTimeout(() => void tick(), BASE_MS)

    const comeBack = () => {
      if (document.visibilityState !== 'visible') return
      refreshAll().then(
        () => setLiveError(null),
        (error: unknown) => {
          console.warn('[live] refresh on return failed', error)
          setLiveError(errorMessage(error, 'Could not reach Raffle Win.'))
        },
      )
    }
    document.addEventListener('visibilitychange', comeBack)
    // Telegram (Bot API 8.0+) also tells us when the Mini App is reopened from the background
    const wa = getWebApp()
    wa?.onEvent('activated', comeBack)

    return () => {
      stopped = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', comeBack)
      wa?.offEvent('activated', comeBack)
    }
  }, [booted])
}
