import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Wallet } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorMessage, isApiError } from '@/api/errors'
import { AnimatedNumber } from '@/components/ui/AnimatedNumber'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Stepper } from '@/components/ui/Field'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { Sheet } from '@/components/ui/Sheet'
import { toast } from '@/components/ui/toastStore'
import type { Raffle } from '@/data/types'
import { PhoneSheet } from '@/features/phone/PhoneShare'
import { burst } from '@/services/confetti'
import { formatInt } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'

type Step = 'pick' | 'confirm' | 'processing' | 'success' | 'error'

interface EnterRaffleSheetProps {
  raffle: Raffle | null
  open: boolean
  onClose: () => void
}

/** Quantity -> confirm -> processing -> celebration. Stacks above the detail sheet. */
export function EnterRaffleSheet({ raffle, open, onClose }: EnterRaffleSheetProps) {
  const navigate = useNavigate()
  const balance = useAppStore((s) => s.balance)
  const enterRaffle = useAppStore((s) => s.enterRaffle)
  const refreshRaffles = useAppStore((s) => s.refreshRaffles)
  const needsPhone = useAppStore((s) => s.features.require_phone_for_entry && !s.profile?.phone)
  const [phoneOpen, setPhoneOpen] = useState(false)
  const canRedeem = useAppStore((s) => s.features.vouchers)
  const [qty, setQty] = useState(1)
  const [step, setStep] = useState<Step>('pick')
  const [error, setError] = useState<string | null>(null)
  // One key per confirmation: kept across a retry, replaced when the quantity changes or after success
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID())
  const [result, setResult] = useState<{ qty: number; raffs: number; entries: number; ticketFrom: number; ticketTo: number } | null>(null)
  // The key of the confirmation waiting on a phone number. Set only when the player tapped Confirm
  // (or the server asked for the number mid-confirm); saving a number with nothing pending places nothing.
  const afterPhone = useRef<string | null>(null)

  useEffect(() => {
    // A phone sheet or a pending confirmation never outlives the sheet or the raffle it was for
    setPhoneOpen(false)
    afterPhone.current = null
    if (open) {
      setQty(1)
      setStep('pick')
      setError(null)
      setResult(null)
      setAttemptKey(crypto.randomUUID())
    }
  }, [open, raffle?.id])

  useEffect(() => {
    setAttemptKey(crypto.randomUUID())
  }, [qty])

  if (!raffle) return null

  // Fixed price in Raffs
  const unit = raffle.entryPriceRaffs
  const totalRaffs = unit * qty
  const remaining = Math.max(1, raffle.entriesTarget - raffle.entriesCount)
  const max = Math.min(50, remaining)
  const shortBy = Math.max(0, totalRaffs - balance)
  const insufficient = shortBy > 0

  const confirm = async (key = attemptKey) => {
    setStep('processing')
    setError(null)
    try {
      const res = await enterRaffle(raffle.id, qty, key, unit)
      setAttemptKey(crypto.randomUUID())
      setResult({ qty, raffs: res.entry.raffsSpent, entries: res.raffle.entriesCount, ticketFrom: res.entry.ticketFrom, ticketTo: res.entry.ticketTo })
      setStep('success')
      sound.play('chime')
      haptics.notify('success')
      burst({ x: 0.5, y: 0.6 })
    } catch (err) {
      setError(errorMessage(err))
      if (isApiError(err, 'PRICE_CHANGED')) {
        // Show the new price before anything is charged
        setAttemptKey(crypto.randomUUID())
        refreshRaffles().catch((e: unknown) => console.warn('[enter] could not reload raffles after a price change', e))
      }
      if (isApiError(err, 'PHONE_REQUIRED')) {
        // Nothing was charged: ask for the number, then the same confirmation is retried with its key
        setError(null)
        setStep('confirm')
        afterPhone.current = key
        setPhoneOpen(true)
        return
      }
      setStep(isApiError(err, 'INSUFFICIENT_FUNDS') || isApiError(err, 'PRICE_CHANGED') ? 'pick' : 'error')
      sound.play('error')
      haptics.notify('error')
    }
  }

  /** The phone is asked for before anything is sent when we already know it is needed. */
  const confirmOrAskPhone = () => {
    if (needsPhone) {
      afterPhone.current = attemptKey
      setPhoneOpen(true)
    } else void confirm()
  }

  return (
    <>
      <Sheet open={open} onClose={onClose} title={step === 'success' ? 'You are in' : `Enter: ${raffle.prizeName}`} heightClass="max-h-[88dvh]">
        <AnimatePresence mode="wait" initial={false}>
          {step === 'pick' && (
            <motion.div key="pick" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="flex flex-col gap-5 pt-2">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-semibold text-mist">Price per entry</p>
                <p className="flex items-center gap-1.5 text-[15px] font-extrabold"><RaffsCoin size={16} /><span className="nums">{formatInt(unit)}</span> Raffs</p>
              </div>
              <div className="flex flex-col items-center gap-3 rounded-card bg-white/5 py-6">
                <p className="text-[13px] font-semibold text-mist">How many entries?</p>
                <Stepper value={qty} min={1} max={max} onChange={setQty} />
                <p className="text-[12px] text-haze">Up to {max} for this raffle. Each entry is one ticket.</p>
              </div>
              <div className="flex flex-col gap-2 rounded-card bg-white/5 p-4">
                <Row label="Entries" value={<span className="nums">{qty}</span>} />
                <Row label="Price per entry" value={<Raffs value={unit} />} />
                <div className="my-1 h-px bg-white/10" />
                <Row label={<span className="font-bold text-cloud">Total</span>} value={<Raffs value={totalRaffs} big />} />
                <Row label="My balance after" value={<Raffs value={balance - totalRaffs} warn={insufficient} />} />
              </div>
              {error && <p className="text-[13px] font-medium text-coral">{error}</p>}
              {insufficient ? (
                <div className="flex flex-col gap-2 rounded-card border border-sun/40 bg-sun/10 p-4">
                  <p className="text-[14px] font-bold">You need {formatInt(shortBy)} more Raffs for this entry</p>
                  {canRedeem ? (
                    <>
                      <p className="text-[13px] text-mist">Have a voucher code? Redeem it in your wallet and come back; this raffle will still be here.</p>
                      <BouncyButton variant="sun" icon={<Wallet size={18} />} onClick={() => { onClose(); navigate('/wallet') }}>
                        Redeem a code
                      </BouncyButton>
                    </>
                  ) : (
                    <p className="text-[13px] text-mist">Choose fewer entries, or come back when you have more Raffs; this raffle will still be here.</p>
                  )}
                </div>
              ) : (
                <BouncyButton size="lg" block pulse onClick={() => setStep('confirm')}>
                  {`Continue with ${formatInt(totalRaffs)} Raffs`}
                </BouncyButton>
              )}
            </motion.div>
          )}

          {step === 'confirm' && (
            <motion.div key="confirm" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex flex-col gap-5 pt-2">
              <div className="rounded-card bg-brand p-5 text-white shadow-glow">
                <p className="text-[13px] font-semibold text-white/80">Confirm my entry</p>
                <p className="mt-1 font-display text-[22px] font-extrabold leading-tight">{raffle.prizeName}</p>
                <p className="mt-3 text-[14px]">
                  <span className="nums font-extrabold">{qty}</span> {qty === 1 ? 'entry' : 'entries'} for{' '}
                  <span className="nums font-extrabold">{formatInt(totalRaffs)} Raffs</span>
                </p>
                <p className="mt-1 text-[12px] text-white/70">Entries are final once confirmed. The draw happens at the deadline.</p>
              </div>
              {needsPhone && (
                <p className="text-[13px] text-mist">Before your first entry we need your phone number, so we can reach you if you win. It takes one tap.</p>
              )}
              <div className="flex gap-3">
                <BouncyButton variant="secondary" size="lg" sfx="click" onClick={() => setStep('pick')}>
                  Back
                </BouncyButton>
                <BouncyButton size="lg" block pulse onClick={confirmOrAskPhone}>
                  Confirm entry
                </BouncyButton>
              </div>
            </motion.div>
          )}

          {step === 'processing' && (
            <motion.div key="processing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-4 py-12">
              <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
                <RaffsCoin size={56} />
              </motion.div>
              <p className="text-[15px] font-bold">Placing your {qty === 1 ? 'entry' : 'entries'}</p>
              <p className="text-[13px] text-mist">Assigning your ticket numbers</p>
            </motion.div>
          )}

          {step === 'success' && result && (
            <motion.div key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 18 }} className="flex flex-col items-center gap-4 pt-4 text-center">
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 12, delay: 0.1 }} className="flex h-20 w-20 items-center justify-center rounded-full bg-lagoon text-ink shadow-glow-mint">
                <CheckCircle2 size={44} />
              </motion.div>
              <h3 className="text-[24px] font-bold">You are in the draw</h3>
              <p className="max-w-[30ch] text-[14px] text-mist">
                {result.qty === 1 ? `Ticket #${result.ticketFrom}` : `Tickets #${result.ticketFrom} to #${result.ticketTo}`} for the {raffle.prizeName}. We will tell you on Telegram the moment the draw happens.
              </p>
              <div className="grid w-full grid-cols-2 gap-3">
                <div className="rounded-card bg-white/5 p-4">
                  <p className="text-[12px] font-semibold text-mist">Entries so far</p>
                  <AnimatedNumber value={result.entries} countUpOnMount={false} className="text-[26px] font-extrabold" />
                </div>
                <div className="rounded-card bg-white/5 p-4">
                  <p className="text-[12px] font-semibold text-mist">My balance</p>
                  <p className="flex items-center gap-1.5 text-[26px] font-extrabold">
                    <RaffsCoin size={18} />
                    <AnimatedNumber value={balance} countUpOnMount={false} />
                  </p>
                </div>
              </div>
              <BouncyButton size="lg" block onClick={onClose} sfx="click">
                Done
              </BouncyButton>
            </motion.div>
          )}

          {step === 'error' && (
            <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-4 pt-4">
              <p className="text-[15px] font-bold">That entry did not go through</p>
              <p className="text-[13px] text-coral">{error}</p>
              <BouncyButton size="lg" block onClick={() => setStep('pick')}>
                Try again
              </BouncyButton>
            </motion.div>
          )}
        </AnimatePresence>
      </Sheet>
      {/* A sibling, not a child: a sheet inside a sheet would be positioned inside the moving panel */}
      <PhoneSheet
        open={open && phoneOpen}
        onClose={() => {
          setPhoneOpen(false)
          afterPhone.current = null
        }}
        reason="Entering a raffle needs your phone number, so we can reach you if you win."
        onSaved={() => {
          setPhoneOpen(false)
          const key = afterPhone.current
          afterPhone.current = null
          // Only the confirmation the player gave, unchanged since (same key), is placed
          if (key && key === attemptKey && step === 'confirm') {
            toast.success('Phone number saved. Placing your entry.')
            void confirm(key)
          } else {
            toast.success('Phone number saved.')
          }
        }}
      />
    </>
  )
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[14px]">
      <span className="text-mist">{label}</span>
      <span className="font-bold">{value}</span>
    </div>
  )
}

function Raffs({ value, big, warn }: { value: number; big?: boolean; warn?: boolean }) {
  return (
    <span className={big ? 'flex items-center gap-1.5 text-[18px]' : 'flex items-center gap-1.5'}>
      <RaffsCoin size={big ? 18 : 14} />
      <span className={warn ? 'nums text-coral' : 'nums'}>{formatInt(value)}</span>
    </span>
  )
}

