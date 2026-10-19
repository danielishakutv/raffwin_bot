import type { RaffsPackage } from '@/data/types'
import { nairaToRaffs, type RateQuote } from '@/services/rates'

export const PACKAGES: RaffsPackage[] = [
  { id: 'p1k', naira: 1000, bonusPct: 0 },
  { id: 'p5k', naira: 5000, bonusPct: 5, tag: 'Popular' },
  { id: 'p10k', naira: 10000, bonusPct: 10 },
  { id: 'p25k', naira: 25000, bonusPct: 15, tag: 'Best value' },
]

export const CUSTOM_MIN = 500
export const CUSTOM_MAX = 500000

/** Demo service fee: 1.5% of the Naira amount, rounded to the Naira. */
export const SERVICE_FEE_RATE = 0.015

export interface Order {
  packageId: string
  naira: number
  baseRaffs: number
  bonusRaffs: number
  totalRaffs: number
  feeNaira: number
  totalNaira: number
}

/** Prices an order with the live quote. Returns null while no valid quote exists. */
export function priceOrder(naira: number, bonusPct: number, quote: RateQuote | null, packageId: string): Order | null {
  if (!quote || naira <= 0) return null
  const baseRaffs = nairaToRaffs(naira, quote)
  const bonusRaffs = Math.floor((baseRaffs * bonusPct) / 100)
  const feeNaira = Math.round(naira * SERVICE_FEE_RATE)
  return {
    packageId,
    naira,
    baseRaffs,
    bonusRaffs,
    totalRaffs: baseRaffs + bonusRaffs,
    feeNaira,
    totalNaira: naira + feeNaira,
  }
}
