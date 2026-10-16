import { motion } from 'framer-motion'
import { Clock, Trophy, Users } from 'lucide-react'
import { Chip } from '@/components/ui/Chip'
import { cn } from '@/components/ui/cn'
import { Countdown } from '@/components/ui/Countdown'
import { PrizeArt } from '@/components/ui/PrizeArt'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { Spinner } from '@/components/ui/Spinner'
import { useNow } from '@/hooks/useNow'
import { useRate } from '@/hooks/useRate'
import { getRaffleStatus, isUrgent, STATUS_LABEL } from '@/data/raffleStatus'
import type { Raffle } from '@/data/types'
import { formatDate, formatInt, formatNaira, formatRaffs } from '@/services/format'
import { raffsToNaira } from '@/services/rates'

interface RaffleCardProps {
  raffle: Raffle
  onOpen: () => void
  onEnter: () => void
}

/** The ticket. Top: prize on its own gradient. Stub: pool, price, countdown, CTA. */
export function RaffleCard({ raffle, onOpen, onEnter }: RaffleCardProps) {
  const now = useNow(1000)
  const { quote } = useRate()
  const status = getRaffleStatus(raffle, now)
  const urgent = isUrgent(raffle, now)
  const progress = raffle.entriesCount / raffle.entriesTarget
  // Fixed price in Raffs; the quote only gives the "about ₦" hint
  const cost = raffle.entryPriceRaffs
  const costNaira = quote ? raffsToNaira(cost, quote) : null
  const live = status === 'open' || status === 'closing_soon'

  const statusTone = { open: 'mint', closing_soon: 'magenta', drawing: 'sun', drawn: 'neutral' } as const

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className="flex h-full w-full cursor-pointer select-none flex-col overflow-hidden rounded-card shadow-float [filter:drop-shadow(0_24px_30px_rgba(0,0,0,0.35))]"
      aria-label={`${raffle.prizeName}, ${STATUS_LABEL[status]}`}
    >
      {/* Prize panel */}
      <div
        className="relative overflow-hidden px-5 pb-4 pt-4"
        style={{
          backgroundImage: `linear-gradient(150deg, hsl(${raffle.hue} 80% 48%) 0%, hsl(${(raffle.hue + 45) % 360} 85% 42%) 100%)`,
        }}
      >
        <div className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-white/20 blur-2xl" />
        <div className="pointer-events-none absolute -left-10 bottom-0 h-32 w-32 rounded-full bg-ink/30 blur-2xl" />
        <div className="relative flex items-center justify-between">
          <Chip tone={statusTone[status]} className="bg-ink/40 backdrop-blur" icon={status === 'drawing' ? <Spinner className="h-3 w-3" /> : undefined}>
            {STATUS_LABEL[status]}
          </Chip>
          <span className="rounded-pill bg-white/20 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur">
            {raffle.category}
          </span>
        </div>
        <motion.div
          animate={live ? { y: [0, -6, 0] } : undefined}
          transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
          className="relative mx-auto mt-2 h-40 w-40 [transform:translateZ(30px)]"
        >
          <PrizeArt kind={raffle.kind} hue={raffle.hue} className="h-full w-full drop-shadow-[0_18px_24px_rgba(0,0,0,0.35)]" />
        </motion.div>
        {status === 'drawn' && (
          <div className="pointer-events-none absolute right-4 top-14 rotate-[-14deg] rounded-lg border-[3px] border-sun px-3 py-1 font-display text-xl font-extrabold tracking-wider text-sun opacity-90">
            DRAWN
          </div>
        )}
        <div className="relative mt-1">
          <h3 className="font-display text-[22px] font-extrabold leading-tight text-white">{raffle.prizeName}</h3>
          <p className="mt-0.5 truncate text-[12px] font-semibold text-white/80">{raffle.model}</p>
          <p className="mt-2 text-[13px] font-bold text-white">
            Market value <span className="nums">{formatNaira(raffle.marketPriceNaira)}</span>
          </p>
        </div>
      </div>

      {/* Perforated seam with notches */}
      <div className="relative bg-ink-2">
        <div className="mx-4 perforation opacity-40" />
        <span className="absolute -left-3 top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-ink" />
        <span className="absolute -right-3 top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-ink" />
      </div>

      {/* Stub */}
      <div className="flex flex-1 flex-col bg-ink-2 px-5 pb-5 pt-4">
        {status === 'drawn' ? (
          <div className="flex flex-col gap-2">
            <p className="text-[12px] font-semibold text-mist">Drawn {raffle.drawnAt ? formatDate(raffle.drawnAt) : ''}</p>
            {raffle.winners.map((w) => (
              <div key={w.position} className="flex items-center gap-2 text-[13px]">
                <Trophy size={14} className={['text-sun', 'text-mist', 'text-[#d9a066]'][w.position - 1]} />
                <span className="w-7 font-bold text-mist">{['1st', '2nd', '3rd'][w.position - 1]}</span>
                <span className="truncate font-bold">@{w.username ?? 'TBD'}</span>
                <span className="ml-auto truncate text-haze">{w.prizeItem}</span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="flex items-end justify-between gap-2">
              <div>
                <p className="text-[12px] font-semibold text-mist">Entry pool</p>
                <p className="nums text-[18px] font-extrabold">{formatRaffs(raffle.entriesTarget * raffle.entryPriceRaffs)}</p>
              </div>
              <p className="flex items-center gap-1 text-[12px] font-semibold text-mist">
                <Users size={14} />
                <span className="nums text-cloud">{formatInt(raffle.entriesCount)}</span> / {formatInt(raffle.entriesTarget)} entries
              </p>
            </div>
            <ProgressBar value={progress} className="mt-2" tone={urgent ? 'sun' : 'brand'} height={8} />
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-white/5 p-3">
                <p className="text-[11px] font-semibold text-mist">Entry cost</p>
                <p className="mt-1 flex items-center gap-1.5 text-[16px] font-extrabold">
                  <RaffsCoin size={16} />
                  <span className="nums">{formatInt(cost)}</span>
                  {costNaira !== null && (
                    <span className="text-[11px] font-semibold text-haze">(about {formatNaira(costNaira)})</span>
                  )}
                </p>
              </div>
              <div className={cn('rounded-2xl p-3', urgent ? 'bg-magenta/15' : 'bg-white/5')}>
                <p className="flex items-center gap-1 text-[11px] font-semibold text-mist">
                  <Clock size={12} /> {status === 'drawing' ? 'Draw' : 'Draw in'}
                </p>
                <Countdown target={raffle.deadline} className="mt-1 text-[16px]" />
              </div>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-[12px] font-semibold text-mist">
              <Trophy size={13} className="text-sun" /> 3 winners: {raffle.winners.map((w) => w.prizeItem).join(', ')}
            </p>
          </>
        )}

        <div className="mt-auto pt-4">
          <motion.button
            type="button"
            whileTap={{ scale: 0.94 }}
            transition={{ type: 'spring', stiffness: 520, damping: 15 }}
            onClick={(e) => {
              e.stopPropagation()
              onEnter()
            }}
            className={cn(
              'tap flex h-12 w-full items-center justify-center gap-2 rounded-field font-display text-[15px] font-bold',
              live ? 'bg-brand text-white shadow-glow' : status === 'drawing' ? 'bg-sunny text-ink shadow-glow-sun' : 'glass text-cloud',
              live && 'animate-pulse-glow',
            )}
          >
            {live ? 'Enter raffle' : status === 'drawing' ? 'Reveal the winners' : 'See the results'}
          </motion.button>
        </div>
      </div>
    </div>
  )
}
