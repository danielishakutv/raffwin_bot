/** How prize places look in the player app: medal colours for the podium, a quiet chip after it. */
import type { WinnerSlot } from './types'
export { prizeLabel, winnersLabel, ordinal } from '@raffwin/shared'

const MEDALS = ['bg-sunny text-ink', 'bg-white/80 text-ink', 'bg-[#d9a066] text-ink']

export function medalClass(position: number): string {
  return MEDALS[position - 1] ?? 'bg-white/10 text-cloud'
}

const TROPHY = ['text-sun', 'text-mist', 'text-[#d9a066]']

export function trophyClass(position: number): string {
  return TROPHY[position - 1] ?? 'text-haze'
}

/** How a winner is shown: "@username", or the first name the server gives for a player without one */
export function winnerName(w: Pick<WinnerSlot, 'name' | 'username'>): string {
  return w.name ?? (w.username ? `@${w.username}` : 'A player')
}
