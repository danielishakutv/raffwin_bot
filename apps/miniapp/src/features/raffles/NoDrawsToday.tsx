import { Ticket } from 'lucide-react'
import { cn } from '@/components/ui/cn'
import { useAppStore } from '@/store/useAppStore'

/** One a day (the same all day, so it does not change between tabs), in turn */
const QUIPS = [
  'The raffle drum is on a short tea break. It will be spinning again soon.',
  'Our prize elves are busy wrapping something shiny. Check back a little later.',
  'Even lucky streaks take a rest day. Keep your Raffs warm for the next one.',
  'The ticket machine is reloading. Pop back in a little while.',
  'Your luck does not expire. It is just waiting for the next draw, like you.',
  'Hold on small: fresh prizes are on their way to the stage.',
  'The stage lights are off while we set up the next show. Front-row seats are free.',
  'Good things come to those who check back. The next prize is a good thing.',
]

function quipForToday(now = new Date()): string {
  const day = Math.floor((now.getTime() - now.getTimezoneOffset() * 60_000) / 86_400_000)
  return QUIPS[day % QUIPS.length] ?? QUIPS[0]
}

/** Shown when no raffle is open to enter: a sleepy ticket and a reason to come back. */
export function NoDrawsToday({ className }: { className?: string }) {
  const alerts = useAppStore((s) => s.features.new_raffle_alerts)
  return (
    <section className={cn('surface flex flex-col items-center gap-2 rounded-card px-6 py-8 text-center', className)}>
      <div aria-hidden className="relative mb-1 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5">
        <Ticket size={30} className="-rotate-12 text-magenta-2" />
        {/* Snoozing: two Zs drift up, CSS only */}
        <span className="absolute -right-1 top-0 animate-doze font-display text-[13px] font-extrabold text-sun">z</span>
        <span className="absolute -right-3 -top-2 animate-doze font-display text-[17px] font-extrabold text-sun [animation-delay:1.3s]">Z</span>
      </div>
      <h3 className="text-[19px] font-bold">No draws today</h3>
      <p className="max-w-[30ch] text-[14px] text-mist">{quipForToday()}</p>
      <p className="mt-1 max-w-[32ch] text-[12.5px] text-haze">
        {alerts ? 'We will message you on Telegram the moment the next raffle opens.' : 'Check back later today for the next raffle.'}
      </p>
    </section>
  )
}
