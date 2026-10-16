import { AnimatePresence, motion } from 'framer-motion'
import { Hand } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Chip } from '@/components/ui/Chip'
import { RateChip } from '@/components/ui/RateChip'
import { useBackButton } from '@/hooks/useBackButton'
import { useNow } from '@/hooks/useNow'
import { isEnterable, sortRafflesForDeck } from '@/data/raffleStatus'
import type { Raffle } from '@/data/types'
import { useAppStore } from '@/store/useAppStore'
import { RaffleDeck } from './RaffleDeck'
import { RaffleDetailSheet } from './RaffleDetailSheet'

/** The main feature: the swipe deck, with the detail sheet driven by /raffles/:id. */
export function RafflesPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const raffles = useAppStore((s) => s.raffles)
  const swipeHintSeen = useAppStore((s) => s.settings.swipeHintSeen)
  const markSwipeHintSeen = useAppStore((s) => s.markSwipeHintSeen)
  const now = useNow(60000)
  const [index, setIndex] = useState(0)
  const [enterNow, setEnterNow] = useState(false)

  // Order only changes when a status flips, so re-sort at most once a minute.
  const sorted = useMemo(() => sortRafflesForDeck(raffles, now), [raffles, now])
  const live = useMemo(() => raffles.filter((r) => isEnterable(r, now)).length, [raffles, now])
  const openRaffle = id ? (sorted.find((r) => r.id === id) ?? null) : null

  // Deep link (/raffles/:id) jumps the deck to that card
  useEffect(() => {
    if (!id) return
    const i = sorted.findIndex((r) => r.id === id)
    if (i >= 0 && i !== index) setIndex(i)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sorted])

  const close = useCallback(() => {
    setEnterNow(false)
    navigate('/raffles', { replace: true })
  }, [navigate])

  useBackButton(!!openRaffle, close)

  const onIndexChange = (next: number) => {
    setIndex(next)
    if (!swipeHintSeen) markSwipeHintSeen()
  }

  const openDetail = (raffle: Raffle, enter: boolean) => {
    setEnterNow(enter)
    navigate(`/raffles/${raffle.id}`)
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-bold">Raffles</h1>
          <p className="text-[13px] text-mist">Swipe to browse. Tap a card for the details.</p>
        </div>
        <Chip tone="mint">{live} live</Chip>
      </header>
      <div className="flex items-center justify-between">
        <RateChip />
        <AnimatePresence>
          {!swipeHintSeen && sorted.length > 1 && (
            <motion.div
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: [0, -8, 0] }}
              exit={{ opacity: 0 }}
              transition={{ x: { duration: 1.4, repeat: Infinity, ease: 'easeInOut' } }}
              className="flex items-center gap-1.5 text-[12px] font-semibold text-mist"
            >
              <Hand size={14} /> Swipe
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {sorted.length > 0 && (
        <RaffleDeck
          raffles={sorted}
          index={Math.min(index, sorted.length - 1)}
          onIndexChange={onIndexChange}
          onOpen={(r) => openDetail(r, false)}
          onEnter={(r) => openDetail(r, true)}
        />
      )}

      <RaffleDetailSheet raffle={openRaffle} onClose={close} enterImmediately={enterNow} onEnterHandled={() => setEnterNow(false)} />
    </div>
  )
}
