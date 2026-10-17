import { AnimatePresence, motion } from 'framer-motion'
import { Check, Flame, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { errorMessage, isApiError } from '@/api/errors'
import { popIn } from '@/components/motion'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { cn } from '@/components/ui/cn'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { toast } from '@/components/ui/toastStore'
import type { StreakState } from '@/data/types'
import { burst } from '@/services/confetti'
import { formatInt } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'
import { rewardForDay, stripDays } from './streak'

/**
 * Daily streak (feature daily_streak): claim a small Raffs bonus once a Lagos
 * day; consecutive days grow it. Motivational, never punishing: missing a day
 * only starts the count again at day 1, and every Raff already claimed stays.
 * Renders nothing when the feature is off (it can switch off while open).
 */
export function StreakCard() {
  const on = useAppStore((s) => s.features.daily_streak)
  const streak = useAppStore((s) => s.streak)
  const loadStreak = useAppStore((s) => s.loadStreak)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [offForMe, setOffForMe] = useState(false)

  // The local "off" only bridges the gap until the live poll agrees; once the store says off too, forget it,
  // so the card comes back by itself when the feature is switched on again
  useEffect(() => {
    if (on) return
    setOffForMe(false)
    setLoadError(null)
  }, [on])

  useEffect(() => {
    if (!on || streak || loadError || offForMe) return
    loadStreak().catch((error: unknown) => {
      // Switched off between the live poll and this request: hide quietly, the next poll agrees
      if (isApiError(error, 'FEATURE_OFF')) setOffForMe(true)
      else {
        console.warn('[streak] could not load', error)
        setLoadError(errorMessage(error, 'Could not load your streak.'))
      }
    })
  }, [on, streak, loadError, offForMe, loadStreak])

  if (!on || offForMe) return null

  if (!streak) {
    return (
      <motion.section variants={popIn} className="surface flex flex-col gap-3 rounded-card p-4" aria-busy={!loadError}>
        <Header best={null} />
        {loadError ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] text-coral">{loadError}</p>
            <BouncyButton size="sm" variant="secondary" sfx="click" icon={<RotateCcw size={16} />} onClick={() => setLoadError(null)}>
              Retry
            </BouncyButton>
          </div>
        ) : (
          <div className="h-[104px] animate-pulse rounded-2xl bg-white/5" />
        )}
      </motion.section>
    )
  }

  return <StreakBody streak={streak} onFeatureOff={() => setOffForMe(true)} />
}

function Header({ best }: { best: number | null }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="flex items-center gap-2 text-[15px] font-bold">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-sun/15 text-sun">
          <Flame size={18} />
        </span>
        Daily streak
      </p>
      {best !== null && best > 0 && <span className="text-[12px] font-semibold text-haze">Best: {best} {best === 1 ? 'day' : 'days'}</span>}
    </div>
  )
}

function StreakBody({ streak, onFeatureOff }: { streak: StreakState; onFeatureOff: () => void }) {
  const claimStreak = useAppStore((s) => s.claimStreak)
  const loadStreak = useAppStore((s) => s.loadStreak)
  const [claiming, setClaiming] = useState(false)
  const [revealed, setRevealed] = useState<number | null>(null)
  const cardRef = useRef<HTMLElement>(null)

  // Today's day number in the streak: the day just claimed, or the one a claim would make
  const today = streak.claimedToday ? streak.current : streak.current + 1
  const todayReward = streak.claimedToday ? rewardForDay(streak.rewards, today) : streak.nextReward
  const tomorrowReward = streak.claimedToday ? streak.nextReward : rewardForDay(streak.rewards, today + 1)

  const claim = async () => {
    setClaiming(true)
    try {
      const res = await claimStreak()
      setRevealed(res.raffs)
      sound.play('coin')
      haptics.notify('success')
      const box = cardRef.current?.getBoundingClientRect()
      burst(box ? { x: (box.left + box.width / 2) / window.innerWidth, y: (box.top + box.height / 2) / window.innerHeight } : undefined)
      window.setTimeout(() => setRevealed(null), 2200)
    } catch (error) {
      sound.play('error')
      haptics.notify('error')
      if (isApiError(error, 'FEATURE_OFF')) {
        toast.info(errorMessage(error))
        onFeatureOff()
      } else if (isApiError(error, 'ALREADY_CLAIMED')) {
        // Claimed from another device: show the real state
        toast.info(errorMessage(error))
        loadStreak().catch((e: unknown) => console.warn('[streak] reload after ALREADY_CLAIMED failed', e))
      } else {
        toast.error(errorMessage(error))
      }
    } finally {
      setClaiming(false)
    }
  }

  return (
    <motion.section ref={cardRef} variants={popIn} className="surface relative flex flex-col gap-4 overflow-hidden rounded-card p-4">
      <Header best={streak.best} />

      <div>
        <p className="font-display text-[24px] font-extrabold leading-tight">
          {streak.current === 0 ? 'Start a streak today' : `${formatInt(streak.current)}-day streak`}
        </p>
        <p className="mt-1 text-[13px] text-mist">
          {streak.claimedToday
            ? `Claimed today. Come back tomorrow for +${formatInt(tomorrowReward)} ${tomorrowReward === 1 ? 'Raff' : 'Raffs'}.`
            : `Claim +${formatInt(todayReward)} ${todayReward === 1 ? 'Raff' : 'Raffs'} for day ${formatInt(today)}. Each day in a row pays a little more.`}
        </p>
      </div>

      <ol className="grid grid-cols-7 gap-1.5" aria-label="Streak days and their rewards">
        {stripDays(today).map((day) => {
          const done = day < today || (day === today && streak.claimedToday)
          const isToday = day === today
          const reward = rewardForDay(streak.rewards, day)
          return (
            <li
              key={day}
              aria-label={`Day ${day}: ${reward} ${reward === 1 ? 'Raff' : 'Raffs'}${done ? ', claimed' : isToday ? ', today' : ''}`}
              className={cn(
                'flex flex-col items-center gap-1 rounded-xl py-2 text-center',
                done ? 'bg-sun/20 text-sun' : isToday ? 'bg-brand/25 text-cloud ring-2 ring-magenta-2/70' : 'bg-white/5 text-haze',
              )}
            >
              <span className="text-[10px] font-bold uppercase">Day {day}</span>
              <span className="flex h-6 items-center justify-center">
                {done ? <Check size={16} strokeWidth={3} /> : <RaffsCoin size={16} />}
              </span>
              <span className="nums text-[12px] font-extrabold">+{reward}</span>
            </li>
          )
        })}
      </ol>

      {streak.claimedToday ? (
        <BouncyButton block variant="secondary" disabled icon={<Check size={18} />}>
          Claimed for today
        </BouncyButton>
      ) : (
        <BouncyButton block variant="sun" pulse loading={claiming} sfx={null} icon={<RaffsCoin size={18} />} onClick={() => void claim()}>
          {`Claim +${formatInt(todayReward)} ${todayReward === 1 ? 'Raff' : 'Raffs'}`}
        </BouncyButton>
      )}
      <p className="text-[12px] text-haze">Miss a day and the count starts again at day 1. Raffs you have claimed always stay yours.</p>

      <AnimatePresence>
        {revealed !== null && (
          <motion.div
            key="reveal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-2/85 backdrop-blur-sm"
            role="status"
          >
            <motion.div
              initial={{ scale: 0.2, rotateY: 0 }}
              animate={{ scale: 1, rotateY: 720 }}
              transition={{ type: 'spring', stiffness: 160, damping: 14 }}
            >
              <RaffsCoin size={64} />
            </motion.div>
            <motion.p
              initial={{ y: 12, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.35, type: 'spring', stiffness: 400, damping: 18 }}
              className="font-display text-[30px] font-extrabold text-sun"
            >
              +{formatInt(revealed)} {revealed === 1 ? 'Raff' : 'Raffs'}
            </motion.p>
            <p className="text-[13px] font-semibold text-mist">Added to your balance</p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  )
}
