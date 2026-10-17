/**
 * What players will see, from the form as it stands: the real raffle card,
 * then the prize list and description as the detail sheet shows them.
 */
import { useEffect, useState } from 'react'
import { Trophy } from 'lucide-react'
import { cn } from '@/components/ui/cn'
import { medalClass, prizeLabel, winnersLabel } from '@/data/prizes'
import type { Raffle } from '@/data/types'
import { RaffleCard } from '@/features/raffles/RaffleCard'
import { imageSrc } from '@/services/media'
import { Notice, Segmented } from '../ui'

type View = 'card' | 'details'

export function RafflePreview({ raffle }: { raffle: Raffle }) {
  const [view, setView] = useState<View>('card')
  const [photoFailed, setPhotoFailed] = useState(false)
  // Probe the photo the way a player's phone would load it
  useEffect(() => {
    setPhotoFailed(false)
    const src = imageSrc(raffle.imageUrl)
    if (!src) return
    const img = new Image()
    img.onerror = () => {
      console.warn('[admin] preview photo did not load', src)
      setPhotoFailed(true)
    }
    img.src = src
    return () => {
      img.onerror = null
    }
  }, [raffle.imageUrl])
  const total = raffle.winners.length

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-neutral-600">Player view</p>
        <Segmented<View>
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'card', label: 'Card' },
            { value: 'details', label: 'Details' },
          ]}
        />
      </div>

      {photoFailed && raffle.imageUrl && (
        <Notice tone="error" onClose={() => setPhotoFailed(false)}>
          The photo did not load, so players would see the illustration. Upload it again.
        </Notice>
      )}

      {/* The app's own dark surface, so colours read exactly as on a phone */}
      <div className="rounded-[28px] bg-ink p-3 font-body text-cloud shadow-[0_20px_50px_-20px_rgba(0,0,0,0.6)] ring-1 ring-black/20 sm:p-4">
        <div className="mx-auto w-full max-w-[360px]">
          {view === 'card' ? (
            <div key="card" className="admin-in pointer-events-none">
              <RaffleCard raffle={raffle} onOpen={() => {}} onEnter={() => {}} />
            </div>
          ) : (
            <div key="details" className="admin-in flex flex-col gap-4 py-1">
              <div>
                <p className="font-display text-[20px] font-extrabold leading-tight">{raffle.prizeName}</p>
                {raffle.model && <p className="mt-0.5 text-[12.5px] text-mist">{raffle.model}</p>}
              </div>
              <section>
                <h4 className="flex items-center gap-2 text-[14px] font-bold">
                  <Trophy size={15} className="text-sun" /> {total === 1 ? 'The prize' : winnersLabel(total)}
                </h4>
                <ol className="mt-2 flex flex-col gap-2">
                  {raffle.winners.map((w) => (
                    <li key={w.position} className="flex items-center gap-3 rounded-2xl bg-white/5 p-3">
                      <span className={cn('flex h-9 min-w-9 shrink-0 items-center justify-center rounded-xl px-1.5 font-display text-[13px] font-extrabold', medalClass(w.position))}>
                        {prizeLabel(w.position, total)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-[14px] font-bold">{w.prizeItem}</p>
                        <p className="text-[11.5px] text-mist">Winner: TBD at the draw</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
              {raffle.description ? (
                <p className="whitespace-pre-line text-[13px] leading-6 text-mist">{raffle.description}</p>
              ) : (
                <p className="text-[12.5px] italic text-haze">No description yet.</p>
              )}
              {raffle.rules.length > 0 && (
                <section>
                  <h4 className="text-[13px] font-bold">Raffle rules</h4>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12.5px] text-mist">
                    {raffle.rules.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
      <p className="text-[11.5px] leading-snug text-neutral-500">Updates as you type. Entry counts and the countdown are live once published.</p>
    </div>
  )
}
