import { AnimatePresence, motion } from 'framer-motion'
import { PartyPopper, Trophy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/api/errors'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { cn } from '@/components/ui/cn'
import { Spinner } from '@/components/ui/Spinner'
import type { Raffle, WinnerSlot } from '@/data/types'
import { medalClass, prizeLabel } from '@/data/prizes'
import { celebrate } from '@/services/confetti'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'

type Phase = 'idle' | 'loading' | 'rolling' | 'done' | 'error'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Winner reveal for a raffle whose deadline has passed. Names roll with a
 * drumroll, then land one at a time from the last place up to 1st.
 */
export function DrawReveal({ raffle, onRevealed }: { raffle: Raffle; onRevealed?: (youWon: boolean) => void }) {
  const drawRaffle = useAppStore((s) => s.drawRaffle)
  const me = useAppStore((s) => s.profile?.username ?? null)
  const [phase, setPhase] = useState<Phase>(raffle.drawnAt ? 'done' : 'idle')
  const [winners, setWinners] = useState<WinnerSlot[]>(raffle.drawnAt ? raffle.winners : [])
  const places = raffle.winners.map((w) => w.position).sort((a, b) => a - b)
  const [landed, setLanded] = useState<Set<number>>(() => new Set(raffle.drawnAt ? places : []))
  const [rolling, setRolling] = useState<{ position: number; name: string } | null>(null)
  const [youWon, setYouWon] = useState(() => !!raffle.drawnAt && raffle.winners.some((w) => w.username === me))
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const start = async () => {
    setPhase('loading')
    setError(null)
    try {
      const res = await drawRaffle(raffle.id)
      if (!alive.current) return
      setWinners(res.raffle.winners)
      setPhase('rolling')
      const pool = raffle.entrants.length ? raffle.entrants : ['ada_obi', 'tunde_k', 'chidi']
      // Long lists roll faster so the whole reveal stays around ten seconds
      const rollMs = Math.max(500, Math.min(1700, 9000 / places.length))
      for (const position of [...places].reverse()) {
        sound.play('drumroll')
        haptics.impact('light')
        const started = Date.now()
        let tick = 0
        while (Date.now() - started < rollMs) {
          if (!alive.current) return
          setRolling({ position, name: pool[(tick * 7 + position) % pool.length] })
          tick += 1
          await wait(tick % 3 === 0 ? 85 : 60)
        }
        const slot = res.raffle.winners.find((w) => w.position === position)
        setRolling(null)
        setLanded((prev) => new Set([...prev, position]))
        sound.play(position === 1 ? 'fanfare' : 'land')
        haptics.impact(position === 1 ? 'heavy' : 'medium')
        if (slot?.username === me) haptics.notify('success')
        await wait(position === 1 ? 300 : Math.min(650, rollMs / 2))
      }
      if (!alive.current) return
      setYouWon(res.youWon)
      setPhase('done')
      celebrate()
      if (res.youWon) sound.play('chime')
      onRevealed?.(res.youWon)
    } catch (err) {
      if (!alive.current) return
      setError(errorMessage(err))
      setPhase('error')
      sound.play('error')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <AnimatePresence>
        {phase === 'done' && youWon && (
          <motion.div
            initial={{ scale: 0.6, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 16 }}
            className="flex items-center gap-3 rounded-2xl bg-sunny p-4 text-ink shadow-glow-sun"
          >
            <PartyPopper size={26} />
            <div>
              <p className="font-display text-lg font-extrabold leading-tight">You won!</p>
              <p className="text-[13px] font-semibold opacity-80">Check My wins for your prize details.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ol className="flex flex-col gap-2">
        {places.map((position) => {
          const slot = (winners.length ? winners : raffle.winners).find((w) => w.position === position)
          const isLanded = landed.has(position)
          const isRolling = rolling?.position === position
          const mine = isLanded && slot?.username === me
          return (
            <motion.li
              key={position}
              animate={isLanded && phase !== 'done' ? { scale: [1, 1.04, 1] } : undefined}
              className={cn(
                'flex items-center gap-3 rounded-2xl p-3',
                mine ? 'bg-sun/15 border border-sun/50' : 'bg-white/5 border border-white/5',
                isRolling && 'border-magenta/50',
              )}
            >
              <span className={cn('flex h-9 min-w-9 shrink-0 items-center justify-center rounded-xl px-1.5 font-display text-[13px] font-extrabold', medalClass(position))}>
                {prizeLabel(position, places.length)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="h-6 overflow-hidden">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {isLanded ? (
                      <motion.p
                        key="winner"
                        initial={{ y: 18, opacity: 0, scale: 0.8 }}
                        animate={{ y: 0, opacity: 1, scale: 1 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 18 }}
                        className={cn('truncate font-display text-[16px] font-extrabold', mine && 'text-sun')}
                      >
                        @{slot?.username ?? 'TBD'} {mine && '(you)'}
                      </motion.p>
                    ) : isRolling ? (
                      <motion.p
                        key={rolling.name}
                        initial={{ y: 10, opacity: 0.4 }}
                        animate={{ y: 0, opacity: 1 }}
                        transition={{ duration: 0.05 }}
                        className="truncate font-display text-[16px] font-extrabold text-magenta-2"
                      >
                        @{rolling.name}
                      </motion.p>
                    ) : (
                      <p key="tbd" className="font-display text-[16px] font-extrabold text-haze">
                        {phase === 'rolling' ? '. . .' : '@TBD'}
                      </p>
                    )}
                  </AnimatePresence>
                </div>
                <p className="truncate text-[12px] text-mist">{slot?.prizeItem}</p>
              </div>
              {mine && <Trophy size={18} className="text-sun" />}
            </motion.li>
          )
        })}
      </ol>

      {phase === 'idle' && (
        <BouncyButton variant="sun" size="lg" block pulse onClick={() => void start()} icon={<Trophy size={18} />}>
          Reveal the winners
        </BouncyButton>
      )}
      {phase === 'loading' && (
        <div className="flex items-center justify-center gap-2 py-3 text-[13px] font-semibold text-mist">
          <Spinner className="h-4 w-4" /> Shuffling the entries
        </div>
      )}
      {phase === 'rolling' && (
        <p className="text-center text-[13px] font-semibold text-magenta-2">Drawing now</p>
      )}
      {phase === 'error' && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-medium text-coral">{error}</p>
          <BouncyButton variant="secondary" onClick={() => void start()}>
            Try again
          </BouncyButton>
        </div>
      )}
    </div>
  )
}
