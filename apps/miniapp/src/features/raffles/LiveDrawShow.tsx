/**
 * The live draw, on every open app at once. The server draws at the deadline;
 * within a few seconds each app's live poll brings the winners, and this plays
 * the show over whatever screen is open: a countdown, then for each place
 * from the last up to 1st, names and ticket numbers roll and land on the
 * winner, then the winners board with celebrations ("You won!" for a winner).
 * The result is already decided when the show starts; the show only reveals it.
 *
 * Built to stay smooth on phones: every loop is a CSS animation on transform or
 * opacity (played off the main thread), the rolling names are written straight
 * into the page instead of re-rendering the show 10-18 times a second, and the
 * app underneath stops painting while the show covers it.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { PartyPopper, Radio, Ticket, Trophy, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/components/ui/cn'
import { PrizeVisual } from '@/components/ui/PrizeVisual'
import { medalClass, prizeLabel, winnerName } from '@/data/prizes'
import type { Raffle, WinnerSlot } from '@/data/types'
import { burst, celebrate } from '@/services/confetti'
import { formatInt } from '@/services/format'
import { haptics } from '@/services/haptics'
import { liteMotion } from '@/services/perf'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'
import { useDrawShow } from './drawShow'

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
/** Names the ticker rolls through when a raffle has few named entrants */
const FILLER = ['@ada_obi', '@tunde_k', '@chidi', '@amaka', '@bayo', '@zainab', '@emeka', '@funmi']

/** Shows covering the app; one fading in while another fades out must not uncover it */
const covering = new Set<string>()

/** html[data-draw-show] hides the app under the show (globals.css), so the phone paints only the show */
function coverApp(showId: string, on: boolean): void {
  if (on) covering.add(showId)
  else covering.delete(showId)
  if (covering.size) document.documentElement.dataset.drawShow = ''
  else delete document.documentElement.dataset.drawShow
}

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

  // Outside #root, so covering the app does not cover the show
  return createPortal(
    <AnimatePresence>{raffle && <Show key={raffle.id} raffle={raffle} onDone={() => useDrawShow.getState().finish()} />}</AnimatePresence>,
    document.body,
  )
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
  /** The current place has landed on its winner */
  const [revealed, setRevealed] = useState(false)
  const [landed, setLanded] = useState<number[]>([])
  const alive = useRef(true)
  const reelRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLParagraphElement>(null)
  const ticketRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    alive.current = true
    // This run's own switch: a remount (React's dev double-mount) must not leave two loops playing
    let mounted = true
    const on = () => mounted && alive.current
    /** One click of the reel: new text, slid in by the compositor. No React render. */
    const spin = (name: string, ticket: number, gap: number) => {
      const reel = reelRef.current
      if (!reel || !nameRef.current || !ticketRef.current) return
      nameRef.current.textContent = name
      ticketRef.current.textContent = `ticket #${ticket}`
      reel.animate?.(
        [
          { transform: 'translate3d(0, 40%, 0)', opacity: 0.35 },
          { transform: 'translate3d(0, 0, 0)', opacity: 1 },
        ],
        { duration: Math.min(140, gap), easing: 'ease-out' },
      )
    }
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
        if (!on()) return
        setCount(c)
        sound.play('tick')
        haptics.select()
        await wait(850)
      }
      if (!on()) return
      setPhase('rolling')
      // Last place first, so 1st is the climax
      for (const slot of [...byPlace].reverse()) {
        if (!on()) return
        setCurrent(slot)
        setRevealed(false)
        sound.play('drumroll')
        await nextFrame()
        const rollMs = slot.position === 1 ? 3000 : Math.max(1100, Math.min(2000, 9000 / total))
        const started = Date.now()
        let i = 0
        while (Date.now() - started < rollMs) {
          if (!on()) return
          i += 1
          // Slows down towards the landing, like a wheel
          const progress = (Date.now() - started) / rollMs
          const gap = 55 + Math.round(progress * progress * 160)
          spin(pool[(i * 7 + slot.position * 3) % pool.length] ?? '@player', 1 + ((i * 7919 + slot.position * 104729) % sold), gap)
          await wait(gap)
        }
        if (!on()) return
        setRevealed(true)
        setLanded((prev) => [...prev, slot.position])
        const isMine = !!me && slot.username === me
        sound.play(slot.position === 1 ? 'fanfare' : 'land')
        haptics.impact(slot.position === 1 ? 'heavy' : 'medium')
        if (isMine) haptics.notify('success')
        burst({ x: 0.5, y: 0.45 })
        await wait(slot.position === 1 ? 1100 : 750)
      }
      if (on()) finale()
    }
    void run()
    return () => {
      mounted = false
      coverApp(raffle.id, false)
    }
    // The show runs once per mount; its inputs are fixed for that raffle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = () => {
    alive.current = false
    // Uncover first, so the app is already there as the show fades out
    coverApp(raffle.id, false)
    onDone()
  }

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={`Live draw: ${raffle.prizeName}`}
      variants={{ hidden: { opacity: 0 }, shown: { opacity: 1 } }}
      initial="hidden"
      animate="shown"
      exit="hidden"
      transition={{ duration: 0.25 }}
      onAnimationComplete={(definition) => {
        if (definition === 'shown' && alive.current) coverApp(raffle.id, true)
      }}
      className="fixed inset-0 z-[60] overflow-y-auto overflow-x-hidden bg-ink text-cloud"
    >
      {/* Stage lights: the raffle's colour, and rays that turn slowly (still on phones: a turning
          layer this size is the single costliest thing a phone could be asked to draw here) */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(120% 70% at 50% 0%, hsl(${raffle.hue} 85% 45% / 0.55) 0%, transparent 60%)` }}
      />
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-1/2 top-[22%] -translate-x-1/2 -translate-y-1/2 opacity-[0.12]',
          liteMotion ? 'h-[120vmax] w-[120vmax]' : 'h-[160vmax] w-[160vmax] animate-rays will-change-transform',
        )}
        style={{ background: `repeating-conic-gradient(from 0deg, hsl(${(raffle.hue + 40) % 360} 90% 70%) 0deg 6deg, transparent 6deg 24deg)` }}
      />

      <div className="relative mx-auto flex min-h-dvh w-full max-w-[520px] flex-col px-5 pb-8" style={{ paddingTop: 'calc(var(--safe-top) + 16px)' }}>
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-coral px-3 py-1 text-[12px] font-extrabold tracking-wide text-white">
            <span className="h-2 w-2 animate-blink rounded-full bg-white" />
            <Radio size={13} /> LIVE DRAW
          </span>
          <button type="button" onClick={close} className="tap inline-flex h-9 items-center gap-1 rounded-full bg-white/10 px-3 text-[13px] font-semibold" aria-label={phase === 'board' ? 'Close' : 'Skip the show'}>
            {phase === 'board' ? <X size={15} /> : null}
            {phase === 'board' ? 'Close' : 'Skip'}
          </button>
        </div>

        <div className="mt-5 flex flex-col items-center text-center">
          <div className="animate-bob will-change-transform">
            <PrizeVisual kind={raffle.kind} hue={raffle.hue} imageUrl={raffle.imageUrl} className="h-32 w-32 drop-shadow-[0_22px_30px_rgba(0,0,0,0.5)]" rounded="rounded-3xl ring-1 ring-white/20" />
          </div>
          <h2 className="mt-4 font-display text-[24px] font-extrabold leading-tight">{raffle.prizeName}</h2>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-mist">
            <Ticket size={14} /> {formatInt(sold)} tickets in the draw · {total === 1 ? '1 prize' : `${total} prizes`}
          </p>
        </div>

        <div className="mt-6 flex flex-1 flex-col">
          {phase === 'countdown' && (
            <div className="flex flex-1 flex-col items-center justify-center py-6">
              <p className="text-[14px] font-semibold text-mist">The draw starts in</p>
              <p key={count} className="nums animate-count-pop font-display text-[96px] font-extrabold leading-none text-sun">
                {count}
              </p>
            </div>
          )}

          {phase === 'rolling' && current && (
            <div className="rounded-card border border-white/15 bg-white/[0.07] p-5 text-center">
              <p className="text-[12.5px] font-bold uppercase tracking-wider text-mist">
                Drawing {total === 1 ? 'the winner' : prizeLabel(current.position, total)}
              </p>
              <p className="mt-0.5 truncate text-[14px] font-semibold">{current.prizeItem}</p>
              <div className="mt-4 h-[74px] overflow-hidden">
                {revealed ? (
                  <div key={`landed-${current.position}`} className="animate-pop-in">
                    <p className={cn('truncate font-display text-[30px] font-extrabold leading-tight', current.username === me && me ? 'text-sun' : 'text-white')}>
                      {winnerName(current)} {current.username === me && me ? '(you!)' : ''}
                    </p>
                    <p className="nums text-[14px] font-bold text-mist">ticket #{current.ticket ?? '?'}</p>
                  </div>
                ) : (
                  // Filled by spin() above; React never writes these two lines
                  <div key={`reel-${current.position}`} ref={reelRef} className="will-change-transform">
                    <p ref={nameRef} className="truncate font-display text-[30px] font-extrabold leading-tight text-magenta-2" />
                    <p ref={ticketRef} className="nums text-[14px] font-bold text-mist" />
                  </div>
                )}
              </div>
            </div>
          )}

          {phase === 'board' && mine.length > 0 && (
            <div className="mb-4 flex animate-pop-in items-center gap-3 rounded-2xl bg-sunny p-4 text-ink shadow-glow-sun">
              <PartyPopper size={28} />
              <div>
                <p className="font-display text-xl font-extrabold leading-tight">You won!</p>
                <p className="text-[13px] font-semibold opacity-80">{mine.map((w) => w.prizeItem).join(' and ')}. The bot has messaged you with what happens next.</p>
              </div>
            </div>
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
                      <li
                        key={w.position}
                        className={cn('flex animate-rise-in items-center gap-3 rounded-2xl border p-3', isMine ? 'border-sun/60 bg-sun/15' : 'border-white/10 bg-white/5')}
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
                      </li>
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
