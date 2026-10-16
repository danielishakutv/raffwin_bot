import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, CreditCard, Lock, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { errorMessage } from '@/api/errors'
import { AnimatedNumber } from '@/components/ui/AnimatedNumber'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Field, Input, Toggle } from '@/components/ui/Field'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { Sheet } from '@/components/ui/Sheet'
import { celebrate } from '@/services/confetti'
import { formatInt, formatNaira } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'
import type { Order } from './packages'

type Step = 'card' | 'processing' | 'success' | 'failed'

interface DemoCardSheetProps {
  order: Order | null
  open: boolean
  onClose: () => void
}

const PROCESSING_STEPS = ['Contacting your bank', 'Authorising the payment', 'Confirming your Raffs']

/**
 * Demo card payment. The fields are fake and live only in component state:
 * nothing typed here is validated against a real network, stored, or sent.
 */
export function DemoCardSheet({ order, open, onClose }: DemoCardSheetProps) {
  const buyRaffs = useAppStore((s) => s.buyRaffs)
  const balance = useAppStore((s) => s.balance)
  const [step, setStep] = useState<Step>('card')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [card, setCard] = useState({ number: '', expiry: '', cvv: '', name: '' })
  const [simulateFailure, setSimulateFailure] = useState(false)

  // Reset everything each time the sheet opens, so card data never lingers.
  useEffect(() => {
    if (open) {
      setStep('card')
      setProgress(0)
      setError(null)
      setCard({ number: '', expiry: '', cvv: '', name: '' })
      setSimulateFailure(false)
    }
  }, [open])

  if (!order) return null

  const digits = card.number.replace(/\D/g, '')
  const valid =
    digits.length >= 15 && /^(0[1-9]|1[0-2])\/\d{2}$/.test(card.expiry) && /^\d{3,4}$/.test(card.cvv) && card.name.trim().length >= 3

  const pay = async () => {
    setStep('processing')
    setError(null)
    for (let i = 0; i < PROCESSING_STEPS.length; i += 1) {
      setProgress(i)
      sound.play('tick')
      await new Promise((r) => setTimeout(r, 650))
    }
    try {
      await buyRaffs({
        packageId: order.packageId,
        naira: order.naira,
        raffs: order.totalRaffs,
        feeNaira: order.feeNaira,
        simulateFailure,
      })
      setStep('success')
      sound.play('fanfare')
      window.setTimeout(() => sound.play('coin'), 500)
      haptics.notify('success')
      celebrate()
    } catch (err) {
      setError(errorMessage(err))
      setStep('failed')
      sound.play('error')
      haptics.notify('error')
    }
  }

  return (
    <Sheet open={open} onClose={step === 'processing' ? () => undefined : onClose} title={step === 'success' ? 'Payment complete' : 'Pay with card'} heightClass="max-h-[90dvh]">
      <AnimatePresence mode="wait" initial={false}>
        {step === 'card' && (
          <motion.form
            key="card"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="flex flex-col gap-4 pt-1"
            onSubmit={(e) => {
              e.preventDefault()
              if (valid) void pay()
            }}
            noValidate
          >
            <div className="flex items-start gap-2 rounded-2xl border border-sun/40 bg-sun/10 p-3 text-[13px]">
              <Lock size={16} className="mt-0.5 shrink-0 text-sun" />
              <p>
                <span className="font-bold">Demo mode.</span> No real payment is processed. Type any numbers; nothing is stored or sent anywhere.
              </p>
            </div>

            <div className="relative overflow-hidden rounded-card bg-sky p-5 text-white shadow-float">
              <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-white/15 blur-2xl" />
              <div className="flex items-center justify-between">
                <CreditCard size={26} />
                <span className="text-[11px] font-bold tracking-wider text-white/70">DEMO CARD</span>
              </div>
              <p className="nums mt-6 text-[20px] font-bold tracking-[0.12em]">{formatCardNumber(card.number) || '•••• •••• •••• ••••'}</p>
              <div className="mt-3 flex justify-between text-[12px] font-semibold text-white/80">
                <span className="truncate uppercase">{card.name || 'Name on card'}</span>
                <span className="nums">{card.expiry || 'MM/YY'}</span>
              </div>
            </div>

            <Field label="Card number" htmlFor="cardNumber">
              <Input
                id="cardNumber"
                inputMode="numeric"
                autoComplete="off"
                placeholder="4111 1111 1111 1111"
                value={formatCardNumber(card.number)}
                onChange={(e) => setCard((c) => ({ ...c, number: e.target.value.replace(/\D/g, '').slice(0, 16) }))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Expiry" htmlFor="expiry">
                <Input
                  id="expiry"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="MM/YY"
                  value={card.expiry}
                  onChange={(e) => setCard((c) => ({ ...c, expiry: formatExpiry(e.target.value) }))}
                />
              </Field>
              <Field label="CVV" htmlFor="cvv">
                <Input
                  id="cvv"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="123"
                  type="password"
                  value={card.cvv}
                  onChange={(e) => setCard((c) => ({ ...c, cvv: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                />
              </Field>
            </div>
            <Field label="Name on card" htmlFor="cardName">
              <Input id="cardName" autoComplete="off" placeholder="ADA OBI" value={card.name} onChange={(e) => setCard((c) => ({ ...c, name: e.target.value }))} />
            </Field>

            <div className="rounded-2xl bg-white/5 px-3">
              <Toggle checked={simulateFailure} onChange={setSimulateFailure} label="Simulate a declined card" description="Testing switch for the failure path" />
            </div>

            <BouncyButton type="submit" size="lg" block pulse={valid} disabled={!valid} icon={<Lock size={18} />}>
              Pay {formatNaira(order.totalNaira)}
            </BouncyButton>
            <p className="text-center text-[12px] text-haze">
              You receive {formatInt(order.totalRaffs)} Raffs the moment the payment confirms.
            </p>
          </motion.form>
        )}

        {step === 'processing' && (
          <motion.div key="processing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-6 py-10">
            <div className="relative flex h-24 w-24 items-center justify-center">
              <motion.span
                className="absolute inset-0 rounded-full border-4 border-grape-2/30 border-t-grape-2"
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
              />
              <motion.div animate={{ scale: [1, 1.12, 1] }} transition={{ duration: 1.2, repeat: Infinity }}>
                <RaffsCoin size={48} />
              </motion.div>
            </div>
            <ol className="flex w-full flex-col gap-2">
              {PROCESSING_STEPS.map((label, i) => (
                <li key={label} className="flex items-center gap-3 text-[14px]">
                  <span
                    className={
                      i < progress
                        ? 'flex h-6 w-6 items-center justify-center rounded-full bg-mint text-ink'
                        : i === progress
                          ? 'flex h-6 w-6 items-center justify-center rounded-full border-2 border-grape-2 border-t-transparent animate-spin'
                          : 'flex h-6 w-6 items-center justify-center rounded-full border-2 border-white/15'
                    }
                  >
                    {i < progress && <CheckCircle2 size={14} />}
                  </span>
                  <span className={i <= progress ? 'font-semibold text-cloud' : 'text-haze'}>{label}</span>
                </li>
              ))}
            </ol>
          </motion.div>
        )}

        {step === 'success' && (
          <motion.div key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 18 }} className="flex flex-col items-center gap-4 pt-4 text-center">
            <motion.div initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 12, delay: 0.1 }} className="flex h-20 w-20 items-center justify-center rounded-full bg-sunny text-ink shadow-glow-sun">
              <RaffsCoin size={44} />
            </motion.div>
            <h3 className="text-[24px] font-bold">Raffs added</h3>
            <p className="text-[14px] text-mist">
              {formatInt(order.totalRaffs)} Raffs for {formatNaira(order.totalNaira)}, including the service fee.
            </p>
            <div className="w-full rounded-card bg-white/5 p-4">
              <p className="text-[12px] font-semibold text-mist">My new balance</p>
              <p className="mt-1 flex items-center justify-center gap-2 text-[34px] font-extrabold">
                <RaffsCoin size={24} />
                <AnimatedNumber value={balance} countUpOnMount={false} duration={1.4} />
              </p>
            </div>
            <BouncyButton size="lg" block onClick={onClose} sfx="click">
              Done
            </BouncyButton>
          </motion.div>
        )}

        {step === 'failed' && (
          <motion.div key="failed" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center gap-4 pt-4 text-center">
            <motion.div animate={{ x: [0, -8, 8, -6, 6, 0] }} transition={{ duration: 0.5 }} className="flex h-20 w-20 items-center justify-center rounded-full bg-coral/20 text-coral">
              <XCircle size={44} />
            </motion.div>
            <h3 className="text-[22px] font-bold">Payment declined</h3>
            <p className="max-w-[32ch] text-[14px] text-mist">{error}</p>
            <p className="text-[12px] text-haze">No Raffs were added and nothing was charged. The attempt is listed in your history.</p>
            <div className="flex w-full gap-3">
              <BouncyButton variant="secondary" size="lg" sfx="click" onClick={onClose}>
                Close
              </BouncyButton>
              <BouncyButton size="lg" block onClick={() => { setSimulateFailure(false); setStep('card') }}>
                Try again
              </BouncyButton>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Sheet>
  )
}

function formatCardNumber(value: string): string {
  return value.replace(/\D/g, '').slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 ')
}

function formatExpiry(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 4)
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d
}
