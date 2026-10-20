/**
 * Keeps what the player sees current without a refresh: entry counts filling
 * up, balance changes, new or finished raffles.
 *
 * A short poll is the backbone (it repairs a missed change within seconds,
 * where a missed push event would be lost for good). It runs only while the
 * app is on screen, backs off after failures, says so when it pauses, and does
 * a full reload whenever the app comes back to the foreground.
 *
 * The server sets the pace (pollMs in each answer: faster near a draw, slower
 * when it is busy). A player who has not touched the screen for a while polls
 * less often, except near a draw, and every wait is jittered so thousands of
 * phones opened at the same moment do not poll in step.
 */
import { useEffect } from 'react'
import * as api from '@/api'
import { errorMessage } from '@/api/errors'
import { getWebApp } from '@/services/telegram'
import { useAppStore } from '@/store/useAppStore'

/** Until the first answer says otherwise */
const BASE_MS = 6000
const MAX_MS = 60_000
/** At or below this pace the server is saying a draw is close: never slow down for idleness then */
const NEAR_DRAW_MS = 3000
/** No touch, key or scroll for this long: poll at half pace; for IDLE_LONG_MS, a quarter */
const IDLE_MS = 2 * 60_000
const IDLE_LONG_MS = 5 * 60_000

let lastInteraction = Date.now()
const noteInteraction = () => {
  lastInteraction = Date.now()
}

/** The wait before the next poll, from the server's pace, idleness and failures. Exported for tests. */
export function pollDelay(serverMs: number, failures: number, idleForMs: number, random = Math.random()): number {
  if (failures) return Math.min(MAX_MS, serverMs * 2 ** failures)
  const idle = serverMs <= NEAR_DRAW_MS ? 1 : idleForMs >= IDLE_LONG_MS ? 4 : idleForMs >= IDLE_MS ? 2 : 1
  const jitter = 0.85 + random * 0.3
  return Math.min(MAX_MS, Math.round(serverMs * idle * jitter))
}
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
    let serverMs = BASE_MS

    const tick = async () => {
      if (stopped) return
      if (document.visibilityState === 'visible' && !inFlight) {
        inFlight = true
        try {
          const live = await api.getLive()
          if (live.pollMs && Number.isFinite(live.pollMs)) serverMs = Math.min(MAX_MS, Math.max(2000, live.pollMs))
          await applyLive(live)
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
      timer = window.setTimeout(() => void tick(), pollDelay(serverMs, failures, Date.now() - lastInteraction))
    }
    timer = window.setTimeout(() => void tick(), pollDelay(serverMs, 0, 0))

    const seen = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const
    for (const e of seen) window.addEventListener(e, noteInteraction, { passive: true, capture: true })

    const comeBack = () => {
      if (document.visibilityState !== 'visible') return
      noteInteraction()
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
      for (const e of seen) window.removeEventListener(e, noteInteraction, { capture: true })
      document.removeEventListener('visibilitychange', comeBack)
      wa?.offEvent('activated', comeBack)
    }
  }, [booted])
}
