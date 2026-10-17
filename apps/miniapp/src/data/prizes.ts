/** How prize places look in the player app: medal colours for the podium, a quiet chip after it. */
export { prizeLabel, winnersLabel, ordinal } from '@raffwin/shared'

const MEDALS = ['bg-sunny text-ink', 'bg-white/80 text-ink', 'bg-[#d9a066] text-ink']

export function medalClass(position: number): string {
  return MEDALS[position - 1] ?? 'bg-white/10 text-cloud'
}

const TROPHY = ['text-sun', 'text-mist', 'text-[#d9a066]']

export function trophyClass(position: number): string {
  return TROPHY[position - 1] ?? 'text-haze'
}
