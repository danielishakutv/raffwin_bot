import { motion } from 'framer-motion'
import { ChevronRight, Trophy } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { staggerContainer, popIn } from '@/components/motion'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { cn } from '@/components/ui/cn'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { PrizeVisual } from '@/components/ui/PrizeVisual'
import { medalClass, prizeLabel } from '@/data/prizes'
import { useBackButton } from '@/hooks/useBackButton'
import { formatDateTime } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { useAppStore, useMyWins } from '@/store/useAppStore'

export function WinsPage() {
  const navigate = useNavigate()
  const wins = useMyWins()
  const profile = useAppStore((s) => s.profile)
  useBackButton(true, () => navigate('/profile'))

  const needsDetails = profile && !profile.kycComplete

  return (
    <div className="flex flex-col gap-3">
      <PageHeader title="My wins" subtitle={wins.length ? `${wins.length} ${wins.length === 1 ? 'prize' : 'prizes'} so far` : 'Your trophies will live here'} back="/profile" />
      {wins.length > 0 && needsDetails && (
        <button type="button" onClick={() => { sound.play('click'); navigate('/kyc') }} className="tap flex items-center gap-3 rounded-2xl border border-sun/40 bg-sun/10 p-3 text-left text-[13px]">
          <Trophy size={18} className="shrink-0 text-sun" />
          <span className="flex-1">Add your name, phone and nearest motor park so your prizes can be delivered.</span>
          <ChevronRight size={16} className="text-sun" />
        </button>
      )}
      {wins.length === 0 ? (
        <EmptyState
          icon={<Trophy size={26} />}
          title="No wins yet"
          body="Every entry is a ticket in the draw. The next one could be yours."
          action={<BouncyButton onClick={() => navigate('/raffles')}>See live raffles</BouncyButton>}
        />
      ) : (
        <motion.ul variants={staggerContainer} initial="hidden" animate="show" className="flex flex-col gap-2">
          {wins.map(({ raffle, slot }) => (
            <motion.li key={raffle.id} variants={popIn}>
              <button
                type="button"
                onClick={() => {
                  sound.play('click')
                  haptics.select()
                  navigate(`/raffles/${raffle.id}`)
                }}
                className="tap surface flex w-full items-center gap-3 rounded-2xl p-3 text-left"
              >
                <div className="relative h-16 w-16 shrink-0 rounded-xl bg-white/5">
                  <PrizeVisual kind={raffle.kind} hue={raffle.hue} imageUrl={raffle.imageUrl} rounded="rounded-xl" className="h-full w-full" />
                  <span className={cn('absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-lg font-display text-[11px] font-extrabold', medalClass(slot.position))}>
                    {prizeLabel(slot.position, raffle.winners.length)}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-bold">{slot.prizeItem}</p>
                  <p className="text-[12px] text-mist">{raffle.prizeName} raffle</p>
                  <p className="text-[12px] text-haze">Drawn {raffle.drawnAt ? formatDateTime(raffle.drawnAt) : ''}</p>
                </div>
                <ChevronRight size={18} className="text-haze" />
              </button>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </div>
  )
}
