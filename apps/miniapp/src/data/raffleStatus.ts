import type { Raffle, RaffleStatus } from './types'

export const CLOSING_SOON_MS = 24 * 60 * 60 * 1000
export const URGENT_MS = 60 * 60 * 1000

/** Status is derived from the deadline and drawnAt so it stays correct as time passes. */
export function getRaffleStatus(raffle: Raffle, now: number = Date.now()): RaffleStatus {
  if (raffle.drawnAt) return 'drawn'
  const deadline = new Date(raffle.deadline).getTime()
  if (now >= deadline) return 'drawing'
  if (deadline - now <= CLOSING_SOON_MS) return 'closing_soon'
  return 'open'
}

export function isEnterable(raffle: Raffle, now: number = Date.now()): boolean {
  const status = getRaffleStatus(raffle, now)
  return status === 'open' || status === 'closing_soon'
}

export function isUrgent(raffle: Raffle, now: number = Date.now()): boolean {
  const remaining = new Date(raffle.deadline).getTime() - now
  return remaining > 0 && remaining <= URGENT_MS
}

export const STATUS_LABEL: Record<RaffleStatus, string> = {
  open: 'Open',
  closing_soon: 'Closing soon',
  drawing: 'Drawing now',
  drawn: 'Drawn',
}

/** Deck order: live raffles by soonest deadline, then drawing, then drawn (most recent first). */
export function sortRafflesForDeck(raffles: Raffle[], now: number = Date.now()): Raffle[] {
  const rank: Record<RaffleStatus, number> = { closing_soon: 0, open: 0, drawing: 1, drawn: 2 }
  return [...raffles].sort((a, b) => {
    const sa = getRaffleStatus(a, now)
    const sb = getRaffleStatus(b, now)
    if (rank[sa] !== rank[sb]) return rank[sa] - rank[sb]
    const da = new Date(a.deadline).getTime()
    const db = new Date(b.deadline).getTime()
    return sa === 'drawn' ? db - da : da - db
  })
}
