/**
 * Draw rules shared by the API (which draws) and the Mini App (which explains).
 *
 * A raffle draws at its deadline only when at least MIN_DRAW_ENTRIES entries
 * (tickets) were sold, and never fewer than it has prizes: below that there is
 * nothing worth drawing, so it is cancelled and every entry refunded in full.
 */
export const MIN_DRAW_ENTRIES = 5

/** Entries a raffle with `prizeCount` prizes needs sold by its deadline to be drawn. */
export function minEntriesToDraw(prizeCount: number): number {
  return Math.max(MIN_DRAW_ENTRIES, prizeCount)
}

/**
 * How winning ticket numbers come from the seed, in words (the API's
 * services/draw.ts is the implementation). Shown with every drawn raffle.
 */
export const DRAW_METHOD =
  'For each place, from 1st down: ticket = 1 + (SHA-256 of "seed:raffleId:ticketsSold:place:try" as a number) mod ticketsSold, ' +
  'starting at try 0 and adding 1 whenever that ticket has already won. The seed was fixed, and its SHA-256 shown, before the draw.'
