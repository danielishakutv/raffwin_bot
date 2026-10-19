/**
 * The prize places of a raffle whose deadline has passed. The server draws;
 * this never does (except the demo build, which has no server).
 *
 *   drawing  the deadline passed and the result is a few seconds away; or,
 *            under the minimum entries, the raffle is about to be refunded
 *   drawn    the winners with their prizes and tickets, and "Watch the draw"
 *            to replay the live show (LiveDrawShow)
 */
import { motion } from 'framer-motion'
import { Clapperboard, PartyPopper, Trophy, Undo2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { minEntriesToDraw } from '@raffwin/shared'
import { usingRealApi } from '@/api'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { cn } from '@/components/ui/cn'
import { Spinner } from '@/components/ui/Spinner'
import { medalClass, prizeLabel, winnerName } from '@/data/prizes'
import type { Raffle } from '@/data/types'
import { formatInt } from '@/services/format'
import { useAppStore } from '@/store/useAppStore'
import { useDrawShow } from './drawShow'

export function DrawReveal({ raffle }: { raffle: Raffle }) {
  const me = useAppStore((s) => s.profile?.username ?? null)
  const drawRaffle = useAppStore((s) => s.drawRaffle)
  const play = useDrawShow((s) => s.play)
  const total = raffle.winners.length
  const need = minEntriesToDraw(total)
  const tooFew = raffle.entriesCount < need
  const places = [...raffle.winners].sort((a, b) => a.position - b.position)
  const mine = places.filter((w) => !!me && w.username === me)

  // Demo build only: no server to draw, so the app plays its part once
  const asked = useRef(false)
  useEffect(() => {
    if (usingRealApi || raffle.drawnAt || asked.current) return
    asked.current = true
    drawRaffle(raffle.id).then(
      () => play(raffle.id),
      (error: unknown) => console.warn('[draw] demo draw failed', error),
    )
  }, [raffle.id, raffle.drawnAt, drawRaffle, play])

  if (!raffle.drawnAt) {
    return tooFew ? (
      <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
        <Undo2 size={20} className="mt-0.5 shrink-0 text-sun" />
        <p className="text-[13.5px] leading-relaxed text-mist">
          Only {formatInt(raffle.entriesCount)} {raffle.entriesCount === 1 ? 'entry was' : 'entries were'} sold. A draw needs at least {need}, so this raffle is not drawn: every
          entry is refunded in full, in a few seconds.
        </p>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-sun/30 bg-sun/10 p-5 text-center">
        <motion.div animate={{ rotate: [0, -8, 8, 0] }} transition={{ duration: 0.9, repeat: Infinity }}>
          <Trophy size={26} className="text-sun" />
        </motion.div>
        <p className="flex items-center gap-2 font-display text-[16px] font-extrabold">
          <Spinner className="h-4 w-4" /> Drawing now
        </p>
        <p className="text-[13px] text-mist">Keep the app open: the live draw starts here in a few seconds.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {mine.length > 0 && (
        <div className="flex items-center gap-3 rounded-2xl bg-sunny p-4 text-ink shadow-glow-sun">
          <PartyPopper size={26} />
          <div>
            <p className="font-display text-lg font-extrabold leading-tight">You won!</p>
            <p className="text-[13px] font-semibold opacity-80">{mine.map((w) => w.prizeItem).join(' and ')}. Check the bot for what happens next.</p>
          </div>
        </div>
      )}
      <ol className="flex flex-col gap-2">
        {places.map((w) => {
          const isMine = !!me && w.username === me
          return (
            <li key={w.position} className={cn('flex items-center gap-3 rounded-2xl border p-3', isMine ? 'border-sun/50 bg-sun/15' : 'border-white/5 bg-white/5')}>
              <span className={cn('flex h-9 min-w-9 shrink-0 items-center justify-center rounded-xl px-1.5 font-display text-[13px] font-extrabold', medalClass(w.position))}>
                {prizeLabel(w.position, total)}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn('truncate font-display text-[16px] font-extrabold', isMine && 'text-sun')}>
                  {winnerName(w)} {isMine && '(you)'}
                </p>
                <p className="truncate text-[12px] text-mist">{w.prizeItem}</p>
              </div>
              {w.ticket !== null && <span className="nums shrink-0 text-[12px] font-bold text-haze">#{w.ticket}</span>}
              {isMine && <Trophy size={18} className="shrink-0 text-sun" />}
            </li>
          )
        })}
      </ol>
      <BouncyButton variant="secondary" block onClick={() => play(raffle.id)} icon={<Clapperboard size={17} />}>
        Watch the draw
      </BouncyButton>
    </div>
  )
}
