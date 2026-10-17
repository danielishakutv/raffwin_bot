import { Clock, ShieldCheck, Ticket, Trophy, Users } from 'lucide-react'
import { useState } from 'react'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Chip } from '@/components/ui/Chip'
import { cn } from '@/components/ui/cn'
import { Countdown } from '@/components/ui/Countdown'
import { PrizeVisual } from '@/components/ui/PrizeVisual'
import { medalClass, prizeLabel, winnersLabel } from '@/data/prizes'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { Sheet } from '@/components/ui/Sheet'
import { Spinner } from '@/components/ui/Spinner'
import { useNow } from '@/hooks/useNow'
import { useRate } from '@/hooks/useRate'
import { getRaffleStatus, STATUS_LABEL } from '@/data/raffleStatus'
import type { Raffle } from '@/data/types'
import { formatDateTime, formatInt, formatNaira, formatRaffs, formatRelative } from '@/services/format'
import { raffsToNaira } from '@/services/rates'
import { useAppStore } from '@/store/useAppStore'
import { DrawReveal } from './DrawReveal'
import { EnterRaffleSheet } from './EnterRaffleSheet'

interface RaffleDetailSheetProps {
  raffle: Raffle | null
  onClose: () => void
  /** Open the enter flow immediately (from the card's Enter button) */
  enterImmediately?: boolean
  onEnterHandled?: () => void
}

/** Full prize details, winner slots, rules, my entries and the Enter CTA. */
export function RaffleDetailSheet({ raffle, onClose, enterImmediately = false, onEnterHandled }: RaffleDetailSheetProps) {
  const [entering, setEntering] = useState(false)
  const now = useNow(1000)
  const { quote } = useRate()
  const entries = useAppStore((s) => s.entries)

  const open = !!raffle
  const status = raffle ? getRaffleStatus(raffle, now) : 'open'
  const live = status === 'open' || status === 'closing_soon'
  const myEntries = raffle ? entries.filter((e) => e.raffleId === raffle.id) : []
  const myTickets = myEntries.reduce((sum, e) => sum + e.qty, 0)
  const cost = raffle ? raffle.entryPriceRaffs : null
  const costNaira = raffle && quote ? raffsToNaira(raffle.entryPriceRaffs, quote) : null
  const showEnter = open && (entering || (enterImmediately && live))

  const closeEnter = () => {
    setEntering(false)
    onEnterHandled?.()
  }

  return (
    <>
      <Sheet open={open} onClose={onClose} title={raffle?.prizeName}>
        {raffle && (
          <div className="flex flex-col gap-5 pb-20">
            <div
              className="relative overflow-hidden rounded-card p-4"
              style={{
                backgroundImage: `linear-gradient(150deg, hsl(${raffle.hue} 80% 48%) 0%, hsl(${(raffle.hue + 45) % 360} 85% 42%) 100%)`,
              }}
            >
              <div className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-white/20 blur-2xl" />
              <div className="relative flex items-center gap-4">
                <PrizeVisual
                  kind={raffle.kind}
                  hue={raffle.hue}
                  imageUrl={raffle.imageUrl}
                  rounded="rounded-2xl ring-1 ring-white/25"
                  className="h-32 w-32 shrink-0 drop-shadow-[0_18px_24px_rgba(0,0,0,0.35)]"
                />
                <div className="min-w-0">
                  <Chip tone="neutral" className="bg-ink/40 text-white backdrop-blur" icon={status === 'drawing' ? <Spinner className="h-3 w-3" /> : undefined}>
                    {STATUS_LABEL[status]}
                  </Chip>
                  <p className="mt-2 text-[13px] font-semibold text-white/85">{raffle.model}</p>
                  <p className="mt-1 text-[14px] font-bold text-white">
                    Market value <span className="nums">{formatNaira(raffle.marketPriceNaira)}</span>
                  </p>
                </div>
              </div>
            </div>

            <p className="text-[14px] leading-6 text-mist">{raffle.description}</p>

            <section className="rounded-card bg-white/5 p-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-mist">
                <Clock size={14} /> {status === 'drawn' ? 'Drawn' : status === 'drawing' ? 'Draw' : 'Draw in'}
              </div>
              {status === 'drawn' && raffle.drawnAt ? (
                <p className="mt-1 text-[15px] font-bold">{formatDateTime(raffle.drawnAt)}</p>
              ) : (
                <Countdown target={raffle.deadline} variant="segments" className="mt-2" />
              )}
              <p className="mt-2 text-[12px] text-haze">Deadline: {formatDateTime(raffle.deadline)}. The draw happens at that exact moment.</p>
            </section>

            <section className="rounded-card bg-white/5 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-mist">
                  <Users size={14} /> Entry pool
                </div>
                <p className="text-[13px] font-semibold text-mist">
                  <span className="nums text-cloud">{formatInt(raffle.entriesCount)}</span> / {formatInt(raffle.entriesTarget)}
                </p>
              </div>
              <ProgressBar value={raffle.entriesCount / raffle.entriesTarget} className="mt-2" height={8} />
              <div className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
                <div>
                  <p className="text-mist">Pool target</p>
                  <p className="nums font-bold">{formatRaffs(raffle.entriesTarget * raffle.entryPriceRaffs)}</p>
                </div>
                <div>
                  <p className="text-mist">Entry price</p>
                  <p className="flex items-center gap-1 font-bold">
                    <RaffsCoin size={14} /> <span className="nums">{formatInt(cost ?? 0)}</span>
                    {costNaira !== null && <span className="text-haze">(about {formatNaira(costNaira)})</span>}
                  </p>
                </div>
              </div>
            </section>

            <section>
              <h4 className="flex items-center gap-2 text-[15px] font-bold">
                <Trophy size={16} className="text-sun" /> {raffle.winners.length === 1 ? 'The prize' : winnersLabel(raffle.winners.length)}
              </h4>
              <div className="mt-2">
                {status === 'drawing' || status === 'drawn' ? (
                  <DrawReveal key={raffle.id} raffle={raffle} />
                ) : (
                  <ol className="flex flex-col gap-2">
                    {raffle.winners.map((w) => (
                      <li key={w.position} className="flex items-center gap-3 rounded-2xl bg-white/5 p-3">
                        <span className={cn('flex h-9 min-w-9 shrink-0 items-center justify-center rounded-xl px-1.5 font-display text-[13px] font-extrabold', medalClass(w.position))}>
                          {prizeLabel(w.position, raffle.winners.length)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[15px] font-bold">{w.prizeItem}</p>
                          <p className="text-[12px] text-mist">Winner: {w.username ? `@${w.username}` : 'TBD at the draw'}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </section>

            <section>
              <h4 className="flex items-center gap-2 text-[15px] font-bold">
                <Ticket size={16} className="text-mint" /> My entries in this raffle
              </h4>
              {myEntries.length === 0 ? (
                <p className="mt-2 rounded-2xl bg-white/5 p-3 text-[13px] text-mist">
                  {live ? 'None yet. Your first ticket is one tap away.' : 'You did not enter this one.'}
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {myEntries.map((e) => (
                    <li key={e.id} className="flex items-center justify-between rounded-2xl bg-white/5 p-3 text-[13px]">
                      <span className="font-bold">
                        {e.qty} {e.qty === 1 ? 'ticket' : 'tickets'}
                      </span>
                      <span className="text-mist">{formatRelative(e.createdAt, now)}</span>
                      <span className="flex items-center gap-1 font-bold">
                        <RaffsCoin size={13} /> <span className="nums">{formatInt(e.raffsSpent)}</span>
                      </span>
                    </li>
                  ))}
                  <li className="px-1 text-[12px] text-haze">
                    {myTickets} {myTickets === 1 ? 'ticket' : 'tickets'} in total
                  </li>
                </ul>
              )}
            </section>

            <section>
              <h4 className="flex items-center gap-2 text-[15px] font-bold">
                <ShieldCheck size={16} className="text-electric-2" /> Rules for this draw
              </h4>
              <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-5 text-mist">
                {raffle.rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </section>
          </div>
        )}
        {raffle && live && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-2 via-ink-2/95 to-transparent px-5 pb-5 pt-8" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
            <BouncyButton size="lg" block pulse className="pointer-events-auto" onClick={() => setEntering(true)} icon={<Ticket size={18} />}>
              {cost !== null ? `Enter for ${formatInt(cost)} Raffs` : 'Enter raffle'}
            </BouncyButton>
          </div>
        )}
      </Sheet>
      <EnterRaffleSheet raffle={raffle} open={showEnter} onClose={closeEnter} />
    </>
  )
}
