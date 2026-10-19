/**
 * The live draw, on every open app at once. The server draws at the deadline;
 * within a few seconds each app's live poll brings the winners, and this plays
 * the show over whatever screen is open: a countdown, then for each place
 * from the last up to 1st, names and ticket numbers roll and land on the
 * winner, then the winners board with celebrations ("You won!" for a winner).
 * The result is already decided when the show starts; the show only reveals it.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { PartyPopper, Radio, Ticket, Trophy, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/components/ui/cn'
import { PrizeVisual } from '@/components/ui/PrizeVisual'
import { medalClass, prizeLabel, winnerName } from '@/data/prizes'
import type { Raffle, WinnerSlot } from '@/data/types'
import { burst, celebrate } from '@/services/confetti'
import { formatInt } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'
import { useDrawShow } from './drawShow'

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
/** Names the ticker rolls through when a raffle has few named entrants */
const FILLER = ['@ada_obi', '@tunde_k', '@chidi', '@amaka', '@bayo', '@zainab', '@emeka', '@funmi']

/** Mounted once in the app shell: offers new draws to the show and plays the one on screen. */
export function LiveDrawShow() {
  const raffles = useAppStore((s) => s.raffles)
  const booted = useAppStore((s) => s.booted)
  const playing = useDrawShow((s) => s.playing)
  const raffle = playing ? raffles.find((r) => r.id === playing && r.drawnAt) : undefined

  useEffect(() => {
    if (booted) useDrawShow.getState().offer(raffles, Date.now())
  }, [raffles, booted])

  // A show for a raffle that is no longer listed has nothing to show
  useEffect(() => {
    if (playing && booted && !raffle) useDrawShow.getState().finish()
  }, [playing, booted, raffle])

  return <AnimatePresence>{raffle && <Show key={raffle.id} raffle={raffle} onDone={() => useDrawShow.getState().finish()} />}</AnimatePresence>
}

type Phase = 'countdown' | 'rolling' | 'board'

function Show({ raffle, onDone }: { raffle: Raffle; onDone: () => void }) {
  const navigate = useNavigate()
  const me = useAppStore((s) => s.profile?.username ?? null)
  const total = raffle.winners.length
  const byPlace = useMemo(() => [...raffle.winners].sort((a, b) => a.position - b.position), [raffle.winners])
  const sold = Math.max(1, raffle.entriesCount)
  const mine = byPlace.filter((w) => !!me && w.username === me)
  const pool = useMemo(() => {
    const names = [...raffle.entrants.map((u) => `@${u}`), ...byPlace.map(winnerName)]
    const unique = [...new Set(names)]
    return unique.length >= 4 ? unique : [...unique, ...FILLER]
  }, [raffle.entrants, byPlace])

  const [phase, setPhase] = useState<Phase>(() => (reducedMotion() ? 'board' : 'countdown'))
  const [count, setCount] = useState(3)
  const [current, setCurrent] = useState<WinnerSlot | null>(null)
  const [ticker, setTicker] = useState<{ name: string; ticket: number } | null>(null)
  const [landed, setLanded] = useState<number[]>([])
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const finale = () => {
      setPhase('board')
      celebrate()
      if (mine.length) {
        sound.play('chime')
        haptics.notify('success')
      }
    }
    const run = async () => {
      if (reducedMotion()) {
        finale()
        return
      }
      for (const c of [3, 2, 1]) {
        if (!alive.current) return
        setCount(c)
        sound.play('tick')
        haptics.select()
        await wait(850)
      }
      if (!alive.current) return
      setPhase('rolling')
      // Last place first, so 1st is the climax
      for (const slot of [...byPlace].reverse()) {
        if (!alive.current) return
        setCurrent(slot)
        sound.play('drumroll')
        const rollMs = slot.position === 1 ? 3000 : Math.max(1100, Math.min(2000, 9000 / total))
        const started = Date.now()
        let i = 0
        while (Date.now() - started < rollMs) {
          if (!alive.current) return
          i += 1
          setTicker({ name: pool[(i * 7 + slot.position * 3) % pool.length] ?? '@player', ticket: 1 + ((i * 7919 + slot.position * 104729) % sold) })
          // Slows down towards the landing, like a wheel
          const progress = (Date.now() - started) / rollMs
          await wait(55 + Math.round(progress * progress * 160))
        }
        if (!alive.current) return
        setTicker(null)
        setLanded((prev) => [...prev, slot.position])
        const isMine = !!me && slot.username === me
        sound.play(slot.position === 1 ? 'fanfare' : 'land')
        haptics.impact(slot.position === 1 ? 'heavy' : 'medium')
        if (isMine) haptics.notify('success')
        burst({ x: 0.5, y: 0.45 })
        await wait(slot.position === 1 ? 1100 : 750)
      }
      if (alive.current) finale()
    }
    void run()
    return () => {
      alive.current = false
    }
    // The show runs once per mount; its inputs are fixed for that raffle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = () => {
    alive.current = false
    onDone()
  }

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={`Live draw: ${raffle.prizeName}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-[60] overflow-y-auto overflow-x-hidden bg-ink text-cloud"
    >
      {/* Stage lights: the raffle's colour, slowly turning rays */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(120% 70% at 50% 0%, hsl(${raffle.hue} 85% 45% / 0.55) 0%, transparent 60%)` }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[22%] h-[160vmax] w-[160vmax] -translate-x-1/2 -translate-y-1/2 opacity-[0.12]"
        style={{ background: `repeating-conic-gradient(from 0deg, hsl(${(raffle.hue + 40) % 360} 90% 70%) 0deg 6deg, transparent 6deg 24deg)` }}
        animate={{ rotate: 360 }}
        transition={{ duration: 40, repeat: Infinity, ease: 'linear' }}
      />

      <div className="relative mx-auto flex min-h-dvh w-full max-w-[520px] flex-col px-5 pb-8" style={{ paddingTop: 'calc(var(--safe-top) + 16px)' }}>
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-coral px-3 py-1 text-[12px] font-extrabold tracking-wide text-white">
            <motion.span className="h-2 w-2 rounded-full bg-white" animate={{ opacity: [1, 0.2, 1] }} transition={{ duration: 1.1, repeat: Infinity }} />
            <Radio size={13} /> LIVE DRAW
          </span>
          <button type="button" onClick={close} className="tap inline-flex h-9 items-center gap-1 rounded-full bg-white/10 px-3 text-[13px] font-semibold" aria-label={phase === 'board' ? 'Close' : 'Skip the show'}>
            {phase === 'board' ? <X size={15} /> : null}
            {phase === 'board' ? 'Close' : 'Skip'}
          </button>
        </div>

        <div className="mt-5 flex flex-col items-center text-center">
          <motion.div animate={{ y: [0, -8, 0] }} transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}>
            <PrizeVisual kind={raffle.kind} hue={raffle.hue} imageUrl={raffle.imageUrl} className="h-32 w-32 drop-shadow-[0_22px_30px_rgba(0,0,0,0.5)]" rounded="rounded-3xl ring-1 ring-white/20" />
          </motion.div>
          <h2 className="mt-4 font-display text-[24px] font-extrabold leading-tight">{raffle.prizeName}</h2>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-mist">
            <Ticket size={14} /> {formatInt(sold)} tickets in the draw · {total === 1 ? '1 prize' : `${total} prizes`}
          </p>
        </div>

        <div className="mt-6 flex flex-1 flex-col">
          {phase === 'countdown' && (
            <div className="flex flex-1 flex-col items-center justify-center py-6">
              <p className="text-[14px] font-semibold text-mist">The draw starts in</p>
              <AnimatePresence mode="popLayout">
                <motion.p
                  key={count}
                  initial={{ scale: 2.2, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.4, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 18 }}
                  className="nums font-display text-[96px] font-extrabold leading-none text-sun"
                >
                  {count}
                </motion.p>
              </AnimatePresence>
            </div>
          )}

          {phase === 'rolling' && current && (
            <div className="rounded-card border border-white/15 bg-white/5 p-5 text-center backdrop-blur">
              <p className="text-[12.5px] font-bold uppercase tracking-wider text-mist">
                Drawing {total === 1 ? 'the winner' : prizeLabel(current.position, total)}
              </p>
              <p className="mt-0.5 truncate text-[14px] font-semibold">{current.prizeItem}</p>
              <div className="mt-4 h-[74px] overflow-hidden">
                <AnimatePresence mode="popLayout" initial={false}>
                  {ticker ? (
                    <motion.div key={`${ticker.name}-${ticker.ticket}`} initial={{ y: 26, opacity: 0.3 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -26, opacity: 0 }} transition={{ duration: 0.06 }}>
                      <p className="truncate font-display text-[30px] font-extrabold leading-tight text-magenta-2">{ticker.name}</p>
                      <p className="nums text-[14px] font-bold text-mist">ticket #{ticker.ticket}</p>
                    </motion.div>
                  ) : (
                    <motion.div key="landed" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 520, damping: 14 }}>
                      <p className={cn('truncate font-display text-[30px] font-extrabold leading-tight', current.username === me && me ? 'text-sun' : 'text-white')}>
                        {winnerName(current)} {current.username === me && me ? '(you!)' : ''}
                      </p>
                      <p className="nums text-[14px] font-bold text-mist">ticket #{current.ticket ?? '?'}</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )}

          {phase === 'board' && mine.length > 0 && (
            <motion.div
              initial={{ scale: 0.6, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 16 }}
              className="mb-4 flex items-center gap-3 rounded-2xl bg-sunny p-4 text-ink shadow-glow-sun"
            >
              <PartyPopper size={28} />
              <div>
                <p className="font-display text-xl font-extrabold leading-tight">You won!</p>
                <p className="text-[13px] font-semibold opacity-80">{mine.map((w) => w.prizeItem).join(' and ')}. The bot has messaged you with what happens next.</p>
              </div>
            </motion.div>
          )}

          {(phase === 'board' || landed.length > 0) && (
            <section className={cn(phase === 'rolling' && 'mt-4')}>
              {phase === 'board' && (
                <h3 className="mb-2 flex items-center gap-2 font-display text-[18px] font-extrabold">
                  <Trophy size={18} className="text-sun" /> {total === 1 ? 'The winner' : 'The winners'}
                </h3>
              )}
              <ol className="flex flex-col gap-2">
                {byPlace
                  .filter((w) => phase === 'board' || landed.includes(w.position))
                  .map((w) => {
                    const isMine = !!me && w.username === me
                    return (
                      <motion.li
                        key={w.position}
                        layout
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={cn('flex items-center gap-3 rounded-2xl border p-3', isMine ? 'border-sun/60 bg-sun/15' : 'border-white/10 bg-white/5')}
                      >
                        <span className={cn('flex h-9 min-w-9 shrink-0 items-center justify-center rounded-xl px-1.5 font-display text-[13px] font-extrabold', medalClass(w.position))}>
                          {prizeLabel(w.position, total)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className={cn('truncate font-display text-[16px] font-extrabold', isMine && 'text-sun')}>
                            {winnerName(w)} {isMine && '(you)'}
                          </p>
                          <p className="truncate text-[12.5px] text-mist">{w.prizeItem}</p>
                        </div>
                        <span className="nums shrink-0 text-[12px] font-bold text-haze">#{w.ticket ?? '?'}</span>
                      </motion.li>
                    )
                  })}
              </ol>
            </section>
          )}

          {phase === 'board' && (
            <div className="mt-auto pt-6">
              <p className="mb-3 text-center text-[11.5px] leading-snug text-haze">
                Drawn by the server at the deadline from a seed fixed before the draw. The raffle's details show the seed, so anyone can check it.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="tap h-12 rounded-field bg-white/10 font-display text-[15px] font-bold"
                  onClick={() => {
                    close()
                    navigate(`/raffles/${raffle.id}`)
                  }}
                >
                  See the raffle
                </button>
                <button type="button" className="tap h-12 rounded-field bg-brand font-display text-[15px] font-bold text-white shadow-glow" onClick={close}>
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}
