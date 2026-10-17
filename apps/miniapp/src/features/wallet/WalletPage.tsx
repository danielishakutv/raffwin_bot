import { motion } from 'framer-motion'
import { ArrowUpRight, ChevronRight, CreditCard, Gift, Send } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { staggerContainer, popIn } from '@/components/motion'
import { AnimatedNumber } from '@/components/ui/AnimatedNumber'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Chip } from '@/components/ui/Chip'
import { cn } from '@/components/ui/cn'
import { Field, Input } from '@/components/ui/Field'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { RateChip } from '@/components/ui/RateChip'
import { Spinner } from '@/components/ui/Spinner'
import { toast } from '@/components/ui/toastStore'
import { useRate } from '@/hooks/useRate'
import { formatInt, formatNaira, formatRelative } from '@/services/format'
import { haptics } from '@/services/haptics'
import { raffsToNaira } from '@/services/rates'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'
import { TRANSACTION_ICONS, transactionKind } from '@/features/profile/transactionMeta'
import { SendRaffsSheet } from '@/features/transfer/SendRaffsSheet'
import { DemoCardSheet } from './DemoCardSheet'
import { CUSTOM_MAX, CUSTOM_MIN, PACKAGES, priceOrder, SERVICE_FEE_RATE } from './packages'

/** Fund account: pick a package (or custom amount), review, pay with the demo card. */
export function WalletPage() {
  const balance = useAppStore((s) => s.balance)
  const transactions = useAppStore((s) => s.transactions)
  // Send Raffs is a switchable feature: it can appear or vanish while the app is open
  const canSend = useAppStore((s) => s.features.raffs_transfer)
  const [sendOpen, setSendOpen] = useState(false)
  // Switched off: close for good, so the sheet does not pop back up by itself when it is switched on again
  useEffect(() => {
    if (canSend || !sendOpen) return
    setSendOpen(false)
    toast.info('Sending Raffs has just been switched off. Try again later.')
  }, [canSend, sendOpen])
  const { quote } = useRate()
  const [selected, setSelected] = useState<string>('p5k')
  const [customRaw, setCustomRaw] = useState('')
  const [payOpen, setPayOpen] = useState(false)

  const custom = Number(customRaw.replace(/\D/g, '')) || 0
  const customError =
    selected === 'custom' && customRaw !== '' && (custom < CUSTOM_MIN || custom > CUSTOM_MAX)
      ? `Enter between ${formatNaira(CUSTOM_MIN)} and ${formatNaira(CUSTOM_MAX)}`
      : null

  const order = useMemo(() => {
    if (selected === 'custom') {
      if (custom < CUSTOM_MIN || custom > CUSTOM_MAX) return null
      return priceOrder(custom, 0, quote, 'custom')
    }
    const pkg = PACKAGES.find((p) => p.id === selected)
    return pkg ? priceOrder(pkg.naira, pkg.bonusPct, quote, pkg.id) : null
  }, [selected, custom, quote])

  const recent = transactions.slice(0, 3)
  const balanceNaira = quote ? raffsToNaira(balance, quote) : null

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex flex-col gap-4">
      <motion.header variants={popIn} className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-bold">Wallet</h1>
          <p className="text-[13px] text-mist">Buy Raffs to enter raffles.</p>
        </div>
        <RateChip />
      </motion.header>

      <motion.section variants={popIn} className="surface flex flex-col gap-4 rounded-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-semibold text-mist">My Raffs</p>
            <p className="mt-1 flex items-center gap-2 text-[32px] font-extrabold leading-none">
              <RaffsCoin size={24} />
              <AnimatedNumber value={balance} />
            </p>
            <p className="mt-1 text-[12px] text-haze">{balanceNaira !== null ? `about ${formatNaira(balanceNaira)}` : 'Refreshing rate'}</p>
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

      <motion.section variants={popIn}>
        <h2 className="px-1 text-[17px] font-bold">Choose a package</h2>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {PACKAGES.map((pkg) => {
            const priced = priceOrder(pkg.naira, pkg.bonusPct, quote, pkg.id)
            const active = selected === pkg.id
            return (
              <motion.button
                key={pkg.id}
                type="button"
                whileTap={{ scale: 0.95 }}
                transition={{ type: 'spring', stiffness: 500, damping: 18 }}
                onClick={() => {
                  sound.play('click')
                  haptics.select()
                  setSelected(pkg.id)
                }}
                aria-pressed={active}
                className={cn(
                  'tap relative flex flex-col items-start rounded-card border p-4 text-left transition-colors',
                  active ? 'border-grape-2 bg-grape/25 shadow-glow' : 'border-white/10 bg-white/5',
                )}
              >
                {pkg.tag && (
                  <Chip tone={pkg.tag === 'Popular' ? 'magenta' : 'mint'} className="absolute -top-2.5 right-3 h-6 text-[11px]">
                    {pkg.tag}
                  </Chip>
                )}
                <span className="nums text-[22px] font-extrabold">{formatNaira(pkg.naira)}</span>
                <span className="mt-2 flex items-center gap-1.5 text-[14px] font-bold">
                  <RaffsCoin size={14} />
                  {priced ? <span className="nums">{formatInt(priced.totalRaffs)} Raffs</span> : <Spinner className="h-3 w-3 text-mist" />}
                </span>
                {pkg.bonusPct > 0 ? (
                  <span className="mt-1 flex items-center gap-1 text-[12px] font-bold text-sun">
                    <Gift size={12} /> +{pkg.bonusPct}% bonus
                  </span>
                ) : (
                  <span className="mt-1 text-[12px] text-haze">Standard rate</span>
                )}
              </motion.button>
            )
          })}
          <button
            type="button"
            onClick={() => {
              sound.play('click')
              setSelected('custom')
            }}
            aria-pressed={selected === 'custom'}
            className={cn(
              'tap col-span-2 flex flex-col rounded-card border p-4 text-left transition-colors',
              selected === 'custom' ? 'border-grape-2 bg-grape/25 shadow-glow' : 'border-white/10 bg-white/5',
            )}
          >
            <span className="text-[14px] font-bold">Custom amount</span>
            <span className="text-[12px] text-haze">
              From {formatNaira(CUSTOM_MIN)} to {formatNaira(CUSTOM_MAX)}
            </span>
            {selected === 'custom' && (
              <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                <Field label="Amount in Naira" htmlFor="custom" error={customError}>
                  <Input
                    id="custom"
                    inputMode="numeric"
                    leading="₦"
                    placeholder="2,500"
                    autoFocus
                    value={customRaw}
                    onChange={(e) => setCustomRaw(e.target.value.replace(/[^\d]/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ','))}
                    invalid={!!customError}
                  />
                </Field>
              </div>
            )}
          </button>
        </div>
      </motion.section>

      <motion.section variants={popIn} className="surface rounded-card p-4">
        <h2 className="text-[17px] font-bold">Order summary</h2>
        {order ? (
          <div className="mt-3 flex flex-col gap-2 text-[14px]">
            <Row label="Amount" value={formatNaira(order.naira)} />
            <Row label="Raffs" value={`${formatInt(order.baseRaffs)}`} />
            {order.bonusRaffs > 0 && <Row label="Bonus Raffs" value={`+${formatInt(order.bonusRaffs)}`} accent />}
            <Row label={`Service fee (${(SERVICE_FEE_RATE * 100).toFixed(1)}%, demo)`} value={formatNaira(order.feeNaira)} />
            <div className="my-1 h-px bg-white/10" />
            <Row label={<span className="font-bold text-cloud">Total to pay</span>} value={<span className="text-[18px]">{formatNaira(order.totalNaira)}</span>} />
            <Row
              label={<span className="font-bold text-cloud">You receive</span>}
              value={
                <span className="flex items-center gap-1.5 text-[18px]">
                  <RaffsCoin size={16} /> {formatInt(order.totalRaffs)}
                </span>
              }
            />
          </div>
        ) : (
          <p className="mt-2 flex items-center gap-2 text-[13px] text-mist">
            {quote ? 'Pick a package or enter a valid amount.' : (<><Spinner className="h-3 w-3" /> Waiting for the current rate</>)}
          </p>
        )}
        <BouncyButton size="lg" block pulse={!!order} disabled={!order} className="mt-4" icon={<CreditCard size={18} />} onClick={() => setPayOpen(true)}>
          {order ? `Pay ${formatNaira(order.totalNaira)} with card` : 'Pay with card'}
        </BouncyButton>
        <p className="mt-2 text-center text-[12px] text-haze">Demo mode. No real payment is processed.</p>
      </motion.section>

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

      <DemoCardSheet order={order} open={payOpen} onClose={() => setPayOpen(false)} />
      <SendRaffsSheet open={sendOpen && canSend} onClose={() => setSendOpen(false)} />
    </motion.div>
  )
}

function Row({ label, value, accent }: { label: React.ReactNode; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-mist">{label}</span>
      <span className={cn('nums font-bold', accent && 'text-sun')}>{value}</span>
    </div>
  )
}
