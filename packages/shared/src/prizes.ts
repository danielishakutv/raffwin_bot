/**
 * Prize places. A raffle has one prize by default and up to MAX_PRIZES;
 * places are numbered 1..n with no gaps. A single prize is just "Prize";
 * with more than one they read 1st, 2nd, 3rd ... nth.
 */
export const MAX_PRIZES = 20

export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

/** "Prize" when it is the only one, otherwise "1st", "2nd" ... */
export function prizeLabel(position: number, total: number): string {
  return total <= 1 ? 'Prize' : ordinal(position)
}

/** "1 winner" / "5 winners" */
export function winnersLabel(total: number): string {
  return `${total} ${total === 1 ? 'winner' : 'winners'}`
}
