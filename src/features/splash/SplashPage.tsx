import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { LogoMark } from '@/components/ui/Logo'
import { Orbs } from '@/components/ui/Orbs'
import { useAppStore } from '@/store/useAppStore'

const word = ['R', 'a', 'f', 'f', 'l', 'e', ' ', 'W', 'i', 'n']

/** Animated intro (about 1.8s), then routes by account state. */
export function SplashPage() {
  const navigate = useNavigate()
  const booted = useAppStore((s) => s.booted)
  const bootError = useAppStore((s) => s.bootError)
  const boot = useAppStore((s) => s.boot)
  const profile = useAppStore((s) => s.profile)
  const onboardingComplete = useAppStore((s) => s.onboardingComplete)
  const [minimumElapsed, setMinimumElapsed] = useState(false)

  useEffect(() => {
    const id = window.setTimeout(() => setMinimumElapsed(true), 1800)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    if (!minimumElapsed || !booted) return
    const next = !profile ? '/signup' : !onboardingComplete ? '/onboarding' : '/home'
    navigate(next, { replace: true })
  }, [minimumElapsed, booted, profile, onboardingComplete, navigate])

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 text-center">
      <Orbs />
      <motion.div
        initial={{ scale: 0.3, rotate: -30, opacity: 0 }}
        animate={{ scale: [0.3, 1.15, 1], rotate: [-30, 6, 0], opacity: 1 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], times: [0, 0.7, 1] }}
      >
        <LogoMark size={112} className="drop-shadow-[0_24px_50px_rgba(242,53,141,0.45)]" />
      </motion.div>
      <div className="mt-6 flex font-display text-[40px] font-extrabold tracking-tight" aria-label="Raffle Win">
        {word.map((ch, i) => (
          <motion.span
            key={i}
            initial={{ y: 30, opacity: 0, rotate: -8 }}
            animate={{ y: 0, opacity: 1, rotate: 0 }}
            transition={{ delay: 0.5 + i * 0.05, type: 'spring', stiffness: 400, damping: 18 }}
            className={i >= 7 ? 'text-sun' : 'text-cloud'}
          >
            {ch === ' ' ? ' ' : ch}
          </motion.span>
        ))}
      </div>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.1, duration: 0.4 }}
        className="mt-2 text-[15px] text-mist"
      >
        Enter raffles. Win real prizes.
      </motion.p>
      {bootError && (
        <div className="mt-8 flex flex-col items-center gap-3">
          <p className="text-[14px] text-coral">{bootError}</p>
          <BouncyButton variant="secondary" onClick={() => void boot()}>
            Try again
          </BouncyButton>
        </div>
      )}
      {!bootError && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.3 }}
          className="absolute bottom-16 h-1 w-24 overflow-hidden rounded-pill bg-white/10"
        >
          <span className="block h-full w-1/2 animate-shimmer rounded-pill bg-brand" />
        </motion.div>
      )}
    </div>
  )
}
