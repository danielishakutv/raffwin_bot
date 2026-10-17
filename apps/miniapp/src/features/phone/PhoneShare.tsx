import { AnimatePresence, motion } from 'framer-motion'
import { Check, EyeOff, MessageCircle, Phone, Trophy, Truck } from 'lucide-react'
import type { ReactNode } from 'react'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Field, Input } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import type { Profile } from '@/data/types'
import { formatPhoneDisplay } from '@/services/format'
import { usePhoneShare, type PhoneShare } from './usePhoneShare'

const REASONS = [
  { icon: Trophy, tone: 'bg-sun/15 text-sun', text: 'If you win, we call you to arrange your prize.' },
  { icon: Truck, tone: 'bg-mint/15 text-mint', text: 'The courier calls this number when your prize reaches the motor park.' },
  { icon: EyeOff, tone: 'bg-grape/30 text-grape-2', text: 'Never shown to other players. Used only to reach you about prizes.' },
]

/**
 * Why we ask, plus whatever the current step needs: the typed number (demo),
 * the bot-chat route (old Telegram apps), the error, or the saved number.
 */
export function PhoneShareBody({ share, intro }: { share: PhoneShare; intro?: ReactNode }) {
  if (share.status === 'saved') {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 18 }}
        className="flex flex-col items-center gap-3 py-4 text-center"
      >
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-lagoon text-ink shadow-glow-mint">
          <Check size={34} strokeWidth={3} />
        </span>
        <p className="text-[18px] font-bold">Phone number saved</p>
        {share.phone && <p className="nums text-[15px] font-semibold text-mist">{formatPhoneDisplay(share.phone)}</p>}
        <p className="max-w-[32ch] text-[13px] text-haze">If you win, this is the number we call.</p>
      </motion.div>
    )
  }

  const inBot = share.status === 'bot' || share.status === 'checking'
  return (
    <div className="flex flex-col gap-4">
      {intro && <p className="text-[14px] leading-6 text-mist">{intro}</p>}
      <ul className="flex flex-col gap-2.5">
        {REASONS.map((r) => (
          <li key={r.text} className="flex items-start gap-3">
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${r.tone}`}>
              <r.icon size={18} />
            </span>
            <span className="pt-1.5 text-[14px] leading-5 text-cloud">{r.text}</span>
          </li>
        ))}
      </ul>

      {share.typed ? (
        <Field label="Phone number" htmlFor="phone-share-demo" hint="Demo: there is no Telegram account to share from, so type a Nigerian number.">
          <Input
            id="phone-share-demo"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            leading="+234"
            placeholder="803 123 4567"
            value={share.demoPhone}
            onChange={(e) => share.setDemoPhone(e.target.value)}
            invalid={!!share.error}
          />
        </Field>
      ) : inBot ? (
        <div className="flex flex-col gap-3 rounded-card border border-electric/40 bg-electric/10 p-4">
          <p className="text-[14px] font-bold">Share it in the bot chat instead</p>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px] leading-5 text-mist">
            <li>Tap Open the bot chat.</li>
            <li>Tap Share my phone number at the bottom of the chat.</li>
            <li>Come back here and tap Done.</li>
          </ol>
          <BouncyButton variant="secondary" sfx="click" icon={<MessageCircle size={18} />} onClick={share.openBot}>
            Open the bot chat
          </BouncyButton>
        </div>
      ) : (
        <p className="text-[13px] text-haze">Telegram shares the number on your account, so there is nothing to type.</p>
      )}

      <AnimatePresence initial={false}>
        {share.error && (
          <motion.p key={share.error} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-[13px] font-medium text-coral" role="alert">
            {share.error}
          </motion.p>
        )}
      </AnimatePresence>

      {!share.typed && !inBot && (
        <button type="button" onClick={share.openBot} className="tap self-start text-[13px] font-semibold text-mist underline underline-offset-4">
          Trouble sharing? Use the bot chat instead
        </button>
      )}
    </div>
  )
}

/** The one main button: share, then (bot route) "Done", then whatever comes next. */
export function PhoneSharePrimary({ share, savedLabel, onSavedClick }: { share: PhoneShare; savedLabel: string; onSavedClick: () => void }) {
  if (share.status === 'saved') {
    return (
      <BouncyButton size="lg" block pulse onClick={onSavedClick}>
        {savedLabel}
      </BouncyButton>
    )
  }
  if (share.status === 'bot' || share.status === 'checking') {
    return (
      <BouncyButton size="lg" block loading={share.status === 'checking'} icon={<Check size={18} />} onClick={() => void share.recheck()}>
        Done, I have shared it
      </BouncyButton>
    )
  }
  return (
    <BouncyButton size="lg" block pulse loading={share.status === 'asking' || share.status === 'saving'} icon={<Phone size={18} />} onClick={() => void share.share()}>
      {share.typed ? 'Save my phone number' : 'Share my phone number'}
    </BouncyButton>
  )
}

interface PhoneSheetProps {
  open: boolean
  onClose: () => void
  /** Called once the number is on the account (e.g. to retry an entry) */
  onSaved?: (profile: Profile) => void
  /** Why it is needed right now, in one sentence */
  reason?: string
  /** Label of the button after saving; it closes the sheet */
  continueLabel?: string
}

/** The phone-share flow in a bottom sheet. Render it as a sibling of other sheets, never inside one. */
export function PhoneSheet({ open, onClose, onSaved, reason, continueLabel = 'Done' }: PhoneSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Add your phone number" heightClass="max-h-[90dvh]">
      <PhoneSheetContent onClose={onClose} onSaved={onSaved} reason={reason} continueLabel={continueLabel} />
    </Sheet>
  )
}

/** Mounted only while the sheet is open, so every opening starts fresh. */
function PhoneSheetContent({ onClose, onSaved, reason, continueLabel }: Omit<PhoneSheetProps, 'open'> & { continueLabel: string }) {
  const share = usePhoneShare(onSaved)
  return (
    <div className="flex flex-col gap-5 pt-2">
      <PhoneShareBody share={share} intro={reason} />
      <PhoneSharePrimary share={share} savedLabel={continueLabel} onSavedClick={onClose} />
    </div>
  )
}
