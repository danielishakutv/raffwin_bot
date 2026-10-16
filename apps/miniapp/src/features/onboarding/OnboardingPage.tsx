import { AnimatePresence, motion } from 'framer-motion'
import { Check, Coins, Ticket, Trophy } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorMessage } from '@/api/errors'
import { staggerContainer, popIn } from '@/components/motion'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Chip } from '@/components/ui/Chip'
import { cn } from '@/components/ui/cn'
import { LogoMark } from '@/components/ui/Logo'
import { MakerFooter } from '@/components/ui/MakerFooter'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { toast } from '@/components/ui/toastStore'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'
import { RULES_SECTIONS } from './rules'

const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? 80 : -80, opacity: 0 }),
  center: { x: 0, opacity: 1, transition: { type: 'spring' as const, stiffness: 320, damping: 30 } },
  exit: (dir: number) => ({ x: dir > 0 ? -80 : 80, opacity: 0, transition: { duration: 0.18 } }),
}

/** One-time welcome: hero, how it works, rules with an agree gate. Swipe or tap. */
export function OnboardingPage() {
  const navigate = useNavigate()
  const profile = useAppStore((s) => s.profile)
  const completeOnboarding = useAppStore((s) => s.completeOnboarding)
  const [step, setStep] = useState(0)
  const [agreed, setAgreed] = useState(false)
  const [saving, setSaving] = useState(false)
  const dir = useRef(1)
  const last = 2

  const go = (delta: number) => {
    const next = Math.max(0, Math.min(last, step + delta))
    if (next === step) return
    dir.current = delta
    sound.play('whoosh')
    haptics.select()
    setStep(next)
  }

  const finish = async () => {
    if (!agreed) return
    setSaving(true)
    try {
      await completeOnboarding()
      sound.play('chime')
      haptics.notify('success')
      navigate('/home', { replace: true })
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative mx-auto flex min-h-dvh w-full max-w-[520px] flex-col px-5 safe-top">
      <div className="flex items-center justify-between pt-5">
        <div className="flex items-center gap-2">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              animate={{ width: i === step ? 28 : 8, opacity: i <= step ? 1 : 0.4 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              className={cn('h-2 rounded-pill', i === step ? 'bg-brand' : 'bg-white')}
            />
          ))}
        </div>
        <span className="text-[13px] font-semibold text-mist">Step {step + 1} of 3</span>
      </div>

      <div className="relative flex flex-1 flex-col overflow-hidden">
        <AnimatePresence custom={dir.current} mode="wait" initial={false}>
          <motion.div
            key={step}
            custom={dir.current}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.25}
            onDragEnd={(_, info) => {
              if (info.offset.x < -70 || info.velocity.x < -500) go(1)
              else if (info.offset.x > 70 || info.velocity.x > 500) go(-1)
            }}
            className="flex flex-1 flex-col pt-6"
          >
            {step === 0 && <WelcomeSlide name={profile?.fullName.split(' ')[0] ?? 'there'} />}
            {step === 1 && <HowItWorksSlide />}
            {step === 2 && <RulesSlide agreed={agreed} onAgree={setAgreed} />}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-3 pb-6 pt-4 safe-bottom">
        {step > 0 && (
          <BouncyButton variant="secondary" size="lg" sfx="click" onClick={() => go(-1)}>
            Back
          </BouncyButton>
        )}
        {step < last ? (
          <BouncyButton size="lg" block onClick={() => go(1)}>
            {step === 0 ? 'Show me how it works' : 'Read the rules'}
          </BouncyButton>
        ) : (
          <BouncyButton size="lg" block pulse={agreed} disabled={!agreed} loading={saving} onClick={() => void finish()}>
            Agree and continue
          </BouncyButton>
        )}
      </div>
      {/* Authorship lives on the one screen before a player enters (there is no sign-in page) */}
      {step === 0 && <MakerFooter />}
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Slides
 * -------------------------------------------------------------------------- */

function WelcomeSlide({ name }: { name: string }) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="relative mx-auto mt-4 h-64 w-64">
        {/* Hero built from shapes: stacked tickets + bouncing coins */}
        <motion.div
          initial={{ rotate: -14, y: 30, opacity: 0 }}
          animate={{ rotate: -10, y: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 18, delay: 0.1 }}
          className="absolute left-6 top-14 h-32 w-52 rounded-2xl bg-sky opacity-80 shadow-float"
        />
        <motion.div
          initial={{ rotate: 8, y: 30, opacity: 0 }}
          animate={{ rotate: 5, y: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 18, delay: 0.2 }}
          className="absolute left-8 top-20 h-32 w-52 rounded-2xl bg-brand shadow-float"
        >
          <div className="absolute inset-x-5 top-[62%] perforation opacity-70" />
          <span className="absolute -left-3 top-[62%] h-6 w-6 -translate-y-1/2 rounded-full bg-ink" />
          <span className="absolute -right-3 top-[62%] h-6 w-6 -translate-y-1/2 rounded-full bg-ink" />
          <div className="absolute left-5 top-5 font-display text-lg font-extrabold text-white">Raffle Win</div>
          <div className="absolute left-5 top-11 text-[11px] font-semibold text-white/70">Entry ticket</div>
          <div className="absolute bottom-3 left-5 nums text-[11px] font-bold text-white/80">No. 000412</div>
        </motion.div>
        {[
          { x: 196, y: 26, d: 0.4, s: 34 },
          { x: 10, y: 180, d: 0.55, s: 28 },
          { x: 178, y: 170, d: 0.7, s: 24 },
        ].map((c, i) => (
          <motion.div
            key={i}
            initial={{ scale: 0, y: -20 }}
            animate={{ scale: 1, y: [0, -10, 0] }}
            transition={{
              scale: { type: 'spring', stiffness: 400, damping: 14, delay: c.d },
              y: { duration: 2.4 + i * 0.4, repeat: Infinity, ease: 'easeInOut', delay: c.d },
            }}
            className="absolute"
            style={{ left: c.x, top: c.y }}
          >
            <RaffsCoin size={c.s} />
          </motion.div>
        ))}
        <motion.div
          initial={{ scale: 0, rotate: -20 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 14, delay: 0.85 }}
          className="absolute right-2 top-[118px]"
        >
          <LogoMark size={56} className="drop-shadow-[0_14px_30px_rgba(242,53,141,0.5)]" />
        </motion.div>
      </div>
      <h1 className="mt-6 text-[32px] font-bold leading-tight">
        Welcome to Raffle Win, <span className="text-brand">{name}</span>
      </h1>
      <p className="mt-3 max-w-[34ch] text-[15px] leading-6 text-mist">
        Buy Raffs with Naira, enter the raffles you like, and watch the draw happen live. Every raffle has three
        winners.
      </p>
    </div>
  )
}

const steps = [
  {
    icon: Coins,
    tone: 'bg-sunny text-ink',
    title: 'Buy Raffs with Naira',
    body: 'Raffs are the in-app currency. The Naira rate is shown on every screen and is locked for one hour at a time.',
  },
  {
    icon: Ticket,
    tone: 'bg-brand text-white',
    title: 'Enter the raffles you like',
    body: 'Each raffle shows the prize, its market value, the entry price and a live countdown to the draw.',
  },
  {
    icon: Trophy,
    tone: 'bg-lagoon text-ink',
    title: 'One draw, three winners',
    body: '1st place takes the main prize. 2nd and 3rd place win the extras listed on the raffle.',
  },
]

function HowItWorksSlide() {
  return (
    <div className="flex flex-1 flex-col">
      <h1 className="text-[30px] font-bold leading-tight">How it works</h1>
      <p className="mt-2 text-[15px] text-mist">Three steps, start to finish.</p>
      <motion.ol variants={staggerContainer} initial="hidden" animate="show" className="mt-6 flex flex-col gap-3">
        {steps.map((s, i) => (
          <motion.li key={s.title} variants={popIn} className="surface flex items-start gap-4 rounded-card p-4">
            <span className={cn('flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl', s.tone)}>
              <s.icon size={22} />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="nums text-[12px] font-bold text-haze">{i + 1}</span>
                <h3 className="text-[16px] font-bold">{s.title}</h3>
              </div>
              <p className="mt-1 text-[13px] leading-5 text-mist">{s.body}</p>
            </div>
          </motion.li>
        ))}
      </motion.ol>
    </div>
  )
}

function RulesSlide({ agreed, onAgree }: { agreed: boolean; onAgree: (next: boolean) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[30px] font-bold leading-tight">Rules and regulations</h1>
      </div>
      <Chip tone="sun" className="mt-3 self-start">
        Demo terms. Final terms to be provided.
      </Chip>
      <div className="surface mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-card p-4" style={{ maxHeight: '46dvh' }}>
        {RULES_SECTIONS.map((section) => (
          <section key={section.title} className="mb-4 last:mb-0">
            <h3 className="text-[15px] font-bold">{section.title}</h3>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-5 text-mist">
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <button
        type="button"
        role="checkbox"
        aria-checked={agreed}
        onClick={() => {
          sound.play(agreed ? 'click' : 'pop')
          haptics.select()
          onAgree(!agreed)
        }}
        className="tap mt-4 flex items-center gap-3 rounded-2xl p-2 text-left"
      >
        <motion.span
          animate={agreed ? { scale: [1, 1.25, 1] } : { scale: 1 }}
          transition={{ duration: 0.3 }}
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-2 transition-colors',
            agreed ? 'border-mint bg-mint text-ink' : 'border-white/30 bg-transparent',
          )}
        >
          {agreed && <Check size={18} strokeWidth={3} />}
        </motion.span>
        <span className="text-[14px] font-semibold">I have read and agree to the Rules and Regulations</span>
      </button>
    </div>
  )
}
