import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, RotateCcw, Send, UserRound } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import * as api from '@/api'
import { errorMessage, isApiError } from '@/api/errors'
import { AnimatedNumber } from '@/components/ui/AnimatedNumber'
import { Avatar } from '@/components/ui/Avatar'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { cn } from '@/components/ui/cn'
import { Field, Input } from '@/components/ui/Field'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { Sheet } from '@/components/ui/Sheet'
import { Spinner } from '@/components/ui/Spinner'
import { toast } from '@/components/ui/toastStore'
import type { TransferLimits, TransferRecipient } from '@/data/types'
import { PhoneSheet } from '@/features/phone/PhoneShare'
import { burst } from '@/services/confetti'
import { formatInt } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { validateUsername } from '@/services/validation'
import { useAppStore } from '@/store/useAppStore'

type Step = 'who' | 'amount' | 'confirm' | 'sending' | 'success' | 'error'

type Lookup =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'found'; recipient: TransferRecipient }
  | { state: 'failed'; message: string }

const QUICK_AMOUNTS = [10, 50, 100, 500]

const raffsWord = (n: number) => (n === 1 ? 'Raff' : 'Raffs')
const normalize = (raw: string) => raw.trim().replace(/^@/, '').toLowerCase()

/**
 * Send Raffs (feature raffs_transfer): who (looked up as you type, so you see
 * "Ada (@ada_obi)" before choosing an amount) -> how many (today's remaining
 * limit shown) -> confirm -> sent. One idempotency key per confirmation, kept
 * across a retry, so a lost reply can never send twice.
 */
export function SendRaffsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const balance = useAppStore((s) => s.balance)
  const hasPhone = useAppStore((s) => !!s.profile?.phone)
  const myUsername = useAppStore((s) => s.profile?.username ?? '')
  const sendRaffs = useAppStore((s) => s.sendRaffs)

  const [step, setStep] = useState<Step>('who')
  const [username, setUsername] = useState('')
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  const [limits, setLimits] = useState<TransferLimits | null>(null)
  const [limitsError, setLimitsError] = useState<string | null>(null)
  const [amountRaw, setAmountRaw] = useState('')
  const [amountError, setAmountError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fatal, setFatal] = useState(false)
  const [phoneOpen, setPhoneOpen] = useState(false)
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID())
  const [sent, setSent] = useState<{ raffs: number; to: TransferRecipient } | null>(null)

  const amount = Number(amountRaw.replace(/\D/g, '')) || 0
  const recipient = lookup.state === 'found' ? lookup.recipient : null
  const handle = normalize(username)

  const loadLimits = useCallback(() => {
    setLimitsError(null)
    api.getTransferLimits().then(setLimits, (e: unknown) => {
      console.warn('[transfer] could not load limits', e)
      setLimitsError(errorMessage(e, 'Could not load your sending limit.'))
    })
  }, [])

  // Every opening starts fresh
  useEffect(() => {
    if (!open) return
    setStep('who')
    setUsername('')
    setLookup({ state: 'idle' })
    setAmountRaw('')
    setAmountError(null)
    setError(null)
    setFatal(false)
    setSent(null)
    setLimits(null)
    setAttemptKey(crypto.randomUUID())
    loadLimits()
  }, [open, loadLimits])

  // A different recipient or amount is a different confirmation
  useEffect(() => {
    setAttemptKey(crypto.randomUUID())
  }, [handle, amount])

  // Look the player up as the username is typed
  useEffect(() => {
    if (!open || validateUsername(handle)) {
      setLookup({ state: 'idle' })
      return
    }
    if (handle === myUsername) {
      setLookup({ state: 'failed', message: 'That is your own username. Send Raffs to another player.' })
      return
    }
    setLookup({ state: 'checking' })
    let cancelled = false
    const id = window.setTimeout(() => {
      api.findRecipient(handle).then(
        (r) => {
          if (!cancelled) setLookup({ state: 'found', recipient: r })
        },
        (e: unknown) => {
          if (!cancelled) setLookup({ state: 'failed', message: errorMessage(e) })
        },
      )
    }, 450)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [open, handle, myUsername])

  const remainingToday = limits ? Math.max(0, limits.dailyMaxRaffs - limits.sentToday) : 0
  const maxNow = Math.min(balance, remainingToday)
  const amountProblem = (() => {
    if (!limits || amountRaw === '') return null
    if (amount < limits.minRaffs) return `Send at least ${formatInt(limits.minRaffs)} ${raffsWord(limits.minRaffs)}.`
    if (amount > remainingToday) {
      return remainingToday > 0
        ? `You can send ${formatInt(remainingToday)} more ${raffsWord(remainingToday)} today.`
        : 'You have sent the most allowed today. Try again tomorrow.'
    }
    if (amount > balance) return `You have ${formatInt(balance)} ${raffsWord(balance)}.`
    return null
  })()
  const amountOk = !!limits && amount > 0 && !amountProblem

  const send = async () => {
    if (!recipient) return
    setStep('sending')
    setError(null)
    try {
      const res = await sendRaffs({ to: recipient.username, raffs: amount, idempotencyKey: attemptKey })
      setSent({ raffs: res.raffs, to: recipient })
      setAttemptKey(crypto.randomUUID())
      setStep('success')
      sound.play('coin')
      haptics.notify('success')
      burst({ x: 0.5, y: 0.55 })
      setLimits((l) => (l ? { ...l, sentToday: l.sentToday + res.raffs } : l))
    } catch (e) {
      const message = errorMessage(e)
      sound.play('error')
      haptics.notify('error')
      if (isApiError(e, 'PHONE_REQUIRED')) {
        // Nothing was sent: ask for the number, then retry the same confirmation
        setStep('confirm')
        setPhoneOpen(true)
      } else if (isApiError(e, 'LIMIT_REACHED') || isApiError(e, 'INSUFFICIENT_FUNDS') || (isApiError(e, 'INVALID_INPUT') && e.fields?.raffs)) {
        // An amount problem (including a raised minimum): keep the recipient, fix the amount
        setAmountError(message)
        setStep('amount')
        loadLimits()
      } else if (isApiError(e, 'NOT_FOUND') || (isApiError(e, 'INVALID_INPUT') && e.fields?.to)) {
        setLookup({ state: 'failed', message })
        setStep('who')
      } else {
        setError(message)
        setFatal(isApiError(e, 'FEATURE_OFF'))
        setStep('error')
      }
    }
  }

  const confirmOrAskPhone = () => {
    if (!hasPhone) setPhoneOpen(true)
    else void send()
  }

  const title =
    step === 'success' ? 'Raffs sent' : step === 'confirm' || step === 'sending' ? 'Check and send' : step === 'amount' ? 'How many Raffs?' : 'Send Raffs'

  return (
    <>
      <Sheet open={open} onClose={step === 'sending' ? () => undefined : onClose} title={title} heightClass="max-h-[90dvh]">
        <AnimatePresence mode="wait" initial={false}>
          {step === 'who' && (
            <motion.div key="who" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="flex flex-col gap-5 pt-2">
              <p className="text-[14px] text-mist">Send Raffs from your balance to another Raffle Win player. They can use them to enter raffles.</p>
              <Field
                label="Their Raffle Win username"
                htmlFor="send-to"
                hint="Ask them: it is on their Profile, under their name."
                error={lookup.state === 'failed' ? lookup.message : null}
              >
                <Input
                  id="send-to"
                  leading="@"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                  placeholder="ada_obi"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
                  invalid={lookup.state === 'failed'}
                  suffix={lookup.state === 'checking' ? <Spinner className="h-4 w-4 text-mist" /> : null}
                />
              </Field>
              <AnimatePresence initial={false}>
                {recipient && (
                  <motion.div key={recipient.username} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                    <RecipientCard recipient={recipient} />
                  </motion.div>
                )}
              </AnimatePresence>
              <BouncyButton size="lg" block pulse={!!recipient} disabled={!recipient} onClick={() => setStep('amount')}>
                {recipient ? `Continue to ${recipient.displayName}` : 'Continue'}
              </BouncyButton>
            </motion.div>
          )}

          {step === 'amount' && recipient && (
            <motion.div key="amount" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex flex-col gap-5 pt-2">
              <RecipientCard recipient={recipient} onChange={() => setStep('who')} />
              {limits ? (
                <>
                  <Field
                    label="Raffs to send"
                    htmlFor="send-amount"
                    error={amountError ?? amountProblem}
                    hint={`You have ${formatInt(balance)} ${raffsWord(balance)}. You can send ${formatInt(remainingToday)} more today.`}
                  >
                    <Input
                      id="send-amount"
                      inputMode="numeric"
                      autoFocus
                      leading={<RaffsCoin size={18} />}
                      placeholder="50"
                      value={amountRaw}
                      onChange={(e) => {
                        setAmountError(null)
                        setAmountRaw(e.target.value.replace(/[^\d]/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ','))
                      }}
                      invalid={!!(amountError ?? amountProblem)}
                    />
                  </Field>
                  {maxNow > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {QUICK_AMOUNTS.filter((q) => q <= maxNow).map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => {
                            sound.play('click')
                            haptics.select()
                            setAmountError(null)
                            setAmountRaw(formatInt(q))
                          }}
                          className={cn('tap h-9 rounded-pill px-4 text-[13px] font-bold', amount === q ? 'bg-brand text-white' : 'bg-white/8 text-mist')}
                        >
                          {formatInt(q)}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-3">
                    <BouncyButton variant="secondary" size="lg" sfx="click" onClick={() => setStep('who')}>
                      Back
                    </BouncyButton>
                    <BouncyButton size="lg" block pulse={amountOk} disabled={!amountOk || !!amountError} onClick={() => setStep('confirm')}>
                      {amountOk ? `Continue with ${formatInt(amount)} ${raffsWord(amount)}` : 'Continue'}
                    </BouncyButton>
                  </div>
                </>
              ) : limitsError ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[13px] text-coral">{limitsError}</p>
                  <BouncyButton size="sm" variant="secondary" sfx="click" icon={<RotateCcw size={16} />} onClick={loadLimits}>
                    Retry
                  </BouncyButton>
                </div>
              ) : (
                <p className="flex items-center gap-2 text-[13px] text-mist">
                  <Spinner className="h-4 w-4" /> Checking how much you can send today
                </p>
              )}
            </motion.div>
          )}

          {step === 'confirm' && recipient && (
            <motion.div key="confirm" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex flex-col gap-5 pt-2">
              <div className="rounded-card bg-brand p-5 text-white shadow-glow">
                <p className="text-[13px] font-semibold text-white/80">You are sending</p>
                <p className="mt-1 flex items-center gap-2 font-display text-[30px] font-extrabold leading-none">
                  <RaffsCoin size={26} /> <span className="nums">{formatInt(amount)}</span> {raffsWord(amount)}
                </p>
                <p className="mt-3 text-[15px]">
                  to <span className="font-extrabold">{recipient.displayName}</span> <span className="text-white/80">(@{recipient.username})</span>
                </p>
                <p className="mt-2 text-[12px] text-white/75">Sent Raffs cannot be taken back. Check the username before you send.</p>
              </div>
              <p className="text-[13px] text-mist">
                Your balance after: <span className="nums font-bold text-cloud">{formatInt(balance - amount)}</span> {raffsWord(balance - amount)}
              </p>
              {!hasPhone && <p className="text-[13px] text-mist">Sending Raffs needs your phone number on the account. It takes one tap.</p>}
              <div className="flex gap-3">
                <BouncyButton variant="secondary" size="lg" sfx="click" onClick={() => setStep('amount')}>
                  Back
                </BouncyButton>
                <BouncyButton size="lg" block pulse sfx={null} icon={<Send size={18} />} onClick={confirmOrAskPhone}>
                  {`Send ${formatInt(amount)} ${raffsWord(amount)}`}
                </BouncyButton>
              </div>
            </motion.div>
          )}

          {step === 'sending' && (
            <motion.div key="sending" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-4 py-12">
              <motion.div animate={{ x: [0, 40, 0], opacity: [1, 0.2, 1] }} transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}>
                <RaffsCoin size={56} />
              </motion.div>
              <p className="text-[15px] font-bold">Sending to {recipient?.displayName}</p>
            </motion.div>
          )}

          {step === 'success' && sent && (
            <motion.div key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 18 }} className="flex flex-col items-center gap-4 pt-4 text-center">
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 12, delay: 0.1 }} className="flex h-20 w-20 items-center justify-center rounded-full bg-lagoon text-ink shadow-glow-mint">
                <CheckCircle2 size={44} />
              </motion.div>
              <h3 className="text-[24px] font-bold">Sent to {sent.to.displayName}</h3>
              <p className="max-w-[32ch] text-[14px] text-mist">
                @{sent.to.username} now has your {formatInt(sent.raffs)} {raffsWord(sent.raffs)}. The bot lets them know in Telegram.
              </p>
              <div className="w-full rounded-card bg-white/5 p-4">
                <p className="text-[12px] font-semibold text-mist">My balance</p>
                <p className="flex items-center justify-center gap-1.5 text-[26px] font-extrabold">
                  <RaffsCoin size={18} />
                  <AnimatedNumber value={balance} countUpOnMount={false} />
                </p>
              </div>
              <BouncyButton size="lg" block sfx="click" onClick={onClose}>
                Done
              </BouncyButton>
            </motion.div>
          )}

          {step === 'error' && (
            <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-4 pt-4">
              <p className="text-[15px] font-bold">Those Raffs were not sent</p>
              <p className="text-[13px] text-coral">{error}</p>
              {fatal ? (
                <BouncyButton size="lg" block variant="secondary" onClick={onClose}>
                  Close
                </BouncyButton>
              ) : (
                <BouncyButton size="lg" block onClick={() => void send()}>
                  Try again
                </BouncyButton>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </Sheet>
      <PhoneSheet
        open={open && phoneOpen}
        onClose={() => setPhoneOpen(false)}
        reason="Sending Raffs needs your phone number on the account. It is never shown to the player you send to."
        onSaved={() => {
          setPhoneOpen(false)
          toast.success('Phone number saved. Sending now.')
          void send()
        }}
      />
    </>
  )
}

function RecipientCard({ recipient, onChange }: { recipient: TransferRecipient; onChange?: () => void }) {
  return (
    <div className="surface flex items-center gap-3 rounded-2xl p-3">
      <Avatar name={recipient.displayName} seed={recipient.username} size={44} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold">{recipient.displayName}</p>
        <p className="truncate text-[13px] text-mist">@{recipient.username}</p>
      </div>
      {onChange ? (
        <button type="button" onClick={onChange} className="tap px-2 text-[13px] font-semibold text-mist underline underline-offset-4">
          Change
        </button>
      ) : (
        <UserRound size={18} className="text-mint" aria-label="Player found" />
      )}
    </div>
  )
}
