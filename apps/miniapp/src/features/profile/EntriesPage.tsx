import { motion } from 'framer-motion'
import { ChevronRight, Ticket } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { staggerContainer, popIn } from '@/components/motion'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Chip } from '@/components/ui/Chip'
import { Countdown } from '@/components/ui/Countdown'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { PrizeVisual } from '@/components/ui/PrizeVisual'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { useBackButton } from '@/hooks/useBackButton'
import { useNow } from '@/hooks/useNow'
import { getRaffleStatus, STATUS_LABEL } from '@/data/raffleStatus'
import { formatDateTime, formatInt } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'

export function EntriesPage() {
  const navigate = useNavigate()
  const entries = useAppStore((s) => s.entries)
  const raffles = useAppStore((s) => s.raffles)
  const now = useNow(1000)
  useBackButton(true, () => navigate('/profile'))

  const tone = { open: 'mint', closing_soon: 'magenta', drawing: 'sun', drawn: 'neutral' } as const

  return (
    <div className="flex flex-col gap-3">
      <PageHeader title="My entries" subtitle={`${formatInt(entries.reduce((s, e) => s + e.qty, 0))} tickets across ${new Set(entries.map((e) => e.raffleId)).size} raffles`} back="/profile" />
      {entries.length === 0 ? (
        <EmptyState
          icon={<Ticket size={26} />}
          title="No entries yet"
          body="Pick a raffle you like and grab your first ticket."
          action={<BouncyButton onClick={() => navigate('/raffles')}>Browse raffles</BouncyButton>}
        />
      ) : (
        <motion.ul variants={staggerContainer} initial="hidden" animate="show" className="flex flex-col gap-2">
          {entries.map((e) => {
            const raffle = raffles.find((r) => r.id === e.raffleId)
            if (!raffle) return null
            const status = getRaffleStatus(raffle, now)
            return (
              <motion.li key={e.id} variants={popIn}>
                <button
                  type="button"
                  onClick={() => {
                    sound.play('click')
                    haptics.select()
                    navigate(`/raffles/${raffle.id}`)
                  }}
                  className="tap surface flex w-full items-center gap-3 rounded-2xl p-3 text-left"
                >
                  <div className="h-14 w-14 shrink-0 rounded-xl bg-white/5">
                    <PrizeVisual kind={raffle.kind} hue={raffle.hue} imageUrl={raffle.imageUrl} rounded="rounded-xl" className="h-full w-full" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-[14px] font-bold">{raffle.prizeName}</p>
                      <Chip tone={tone[status]} className="h-6 text-[11px]">
                        {STATUS_LABEL[status]}
                      </Chip>
                    </div>
                    <p className="text-[12px] text-mist">
                      {e.qty} {e.qty === 1 ? 'ticket' : 'tickets'} · {formatDateTime(e.createdAt)}
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-[12px]">
                      <span className="flex items-center gap-1 font-bold">
                        <RaffsCoin size={12} /> <span className="nums">{formatInt(e.raffsSpent)}</span>
                      </span>
                      {status !== 'drawn' && (
                        <span className="text-mist">
                          Draw: <Countdown target={raffle.deadline} className="text-[12px]" />
                        </span>
                      )}
                    </p>
                  </div>
                  <ChevronRight size={18} className="text-haze" />
                </button>
              </motion.li>
            )
          })}
        </motion.ul>
      )}
    </div>
  )
}
