import { ArrowDownLeft, Gift, HandCoins, Send, SlidersHorizontal, Ticket, Trophy, Undo2, UserPlus } from 'lucide-react'
import type { ElementType } from 'react'
import type { TransactionType } from '@/data/types'

/** One icon per kind of Raffs movement, wherever transactions are listed. */
export const TRANSACTION_ICONS: Record<TransactionType, ElementType> = {
  purchase: ArrowDownLeft,
  entry: Ticket,
  bonus: Gift,
  prize: Trophy,
  refund: ArrowDownLeft,
  referral: UserPlus,
  referral_reversal: Undo2,
  adjustment: SlidersHorizontal,
  transfer_in: HandCoins,
  transfer_out: Send,
}

/**
 * A short kind label for the lines whose note alone does not say what
 * happened (the note of a transfer is just "From @ada" / "Sent to @ada").
 */
export function transactionKind(type: TransactionType): string | null {
  if (type === 'transfer_in') return 'Received from a player'
  if (type === 'transfer_out') return 'Sent to a player'
  return null
}
