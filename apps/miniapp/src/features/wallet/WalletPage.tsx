import { motion } from 'framer-motion'
import { ArrowUpRight, ChevronRight, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { staggerContainer, popIn } from '@/components/motion'
import { AnimatedNumber } from '@/components/ui/AnimatedNumber'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { cn } from '@/components/ui/cn'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { toast } from '@/components/ui/toastStore'
import { formatInt, formatRelative } from '@/services/format'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'
import { TRANSACTION_ICONS, transactionKind } from '@/features/profile/transactionMeta'
import { SendRaffsSheet } from '@/features/transfer/SendRaffsSheet'
import { RedeemCode } from './RedeemCode'

/**
 * My Raffs: the balance, a voucher code to redeem, Send Raffs, and recent
 * activity. Raffs are not sold in the app (19 Oct): no prices, packages or
 * payment links here, by design.
 */
export function WalletPage() {
  const balance = useAppStore((s) => s.balance)
  const transactions = useAppStore((s) => s.transactions)
  // Send Raffs and Redeem codes are switchable features: they can appear or vanish while the app is open
  const canSend = useAppStore((s) => s.features.raffs_transfer)
  const canRedeem = useAppStore((s) => s.features.vouchers)
  const [sendOpen, setSendOpen] = useState(false)
  // Switched off: close for good, so the sheet does not pop back up by itself when it is switched on again
  useEffect(() => {
    if (canSend || !sendOpen) return
    setSendOpen(false)
    toast.info('Sending Raffs has just been switched off. Try again later.')
  }, [canSend, sendOpen])

  const recent = transactions.slice(0, 5)

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex flex-col gap-4">
      <motion.header variants={popIn}>
        <h1 className="text-[24px] font-bold">Wallet</h1>
        <p className="text-[13px] text-mist">Your Raffs and everything that moved them.</p>
      </motion.header>

      <motion.section variants={popIn} className="surface flex flex-col gap-4 rounded-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-semibold text-mist">My Raffs</p>
            <p className="mt-1 flex items-center gap-2 text-[32px] font-extrabold leading-none">
              <RaffsCoin size={24} />
              <AnimatedNumber value={balance} />
            </p>
          </div>
          <Link to="/profile/history" onClick={() => sound.play('click')} className="flex items-center gap-1 text-[13px] font-semibold text-mist">
            History <ChevronRight size={16} />
          </Link>
        </div>
        {canSend && (
          <BouncyButton variant="secondary" block icon={<Send size={18} />} onClick={() => setSendOpen(true)}>
            Send Raffs to a friend
          </BouncyButton>
        )}
      </motion.section>

      {canRedeem && (
        <motion.div variants={popIn}>
          <RedeemCode />
        </motion.div>
      )}

      {recent.length > 0 && (
        <motion.section variants={popIn}>
          <div className="flex items-center justify-between px-1">
            <h2 className="text-[17px] font-bold">Recent activity</h2>
            <Link to="/profile/history" onClick={() => sound.play('click')} className="flex items-center text-[13px] font-semibold text-mist">
              See all <ChevronRight size={16} />
            </Link>
          </div>
          <ul className="mt-2 flex flex-col gap-2">
            {recent.map((t) => {
              const Icon = t.status === 'failed' ? ArrowUpRight : TRANSACTION_ICONS[t.type]
              const kind = transactionKind(t.type)
              return (
                <li key={t.id} className="surface flex items-center gap-3 rounded-2xl p-3">
                  <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl', t.raffs >= 0 ? 'bg-mint/15 text-mint' : 'bg-magenta/15 text-magenta-2')}>
                    <Icon size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-bold">{t.note}</p>
                    <p className="text-[12px] text-mist">
                      {kind ? `${kind} · ` : ''}
                      {formatRelative(t.createdAt)}
                    </p>
                  </div>
                  <span className={cn('nums text-[14px] font-extrabold', t.status === 'failed' ? 'text-coral' : t.raffs >= 0 ? 'text-mint' : 'text-cloud')}>
                    {t.status === 'failed' ? 'Failed' : `${t.raffs >= 0 ? '+' : ''}${formatInt(t.raffs)}`}
                  </span>
                </li>
              )
            })}
          </ul>
        </motion.section>
      )}

      <SendRaffsSheet open={sendOpen && canSend} onClose={() => setSendOpen(false)} />
    </motion.div>
  )
}
