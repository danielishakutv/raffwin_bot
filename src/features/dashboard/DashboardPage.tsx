import { motion } from 'framer-motion'
import { ChevronRight, Flame, Sparkles, Ticket, Trophy, Volume2, VolumeX, Wallet } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { staggerContainer, popIn } from '@/components/motion'
import { AnimatedNumber } from '@/components/ui/AnimatedNumber'
import { Avatar } from '@/components/ui/Avatar'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { cn } from '@/components/ui/cn'
import { Countdown } from '@/components/ui/Countdown'
import { PrizeArt } from '@/components/ui/PrizeArt'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { RateChip } from '@/components/ui/RateChip'
import { Sparkline } from '@/components/ui/Sparkline'
import { useNow } from '@/hooks/useNow'
import { useRate } from '@/hooks/useRate'
import { getRaffleStatus, isEnterable, isUrgent } from '@/data/raffleStatus'
import { formatNaira } from '@/services/format'
import { haptics } from '@/services/haptics'
import { raffsToNaira } from '@/services/rates'
import { sound } from '@/services/sound'
import { useAppStore, useMyWins } from '@/store/useAppStore'

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

/** Home: balance, simple analytics, next draw, and the fund CTA. */
export function DashboardPage() {
  const navigate = useNavigate()
  const profile = useAppStore((s) => s.profile)
  const balance = useAppStore((s) => s.balance)
  const raffles = useAppStore((s) => s.raffles)
  const entries = useAppStore((s) => s.entries)
  const transactions = useAppStore((s) => s.transactions)
  const wins = useMyWins()
  const muted = useAppStore((s) => s.settings.muted)
  const setMuted = useAppStore((s) => s.setMuted)
  const { quote } = useRate()
  const now = useNow(30000)

  const stats = useMemo(() => {
    const totalEntries = entries.reduce((sum, e) => sum + e.qty, 0)
    const active = raffles.filter((r) => isEnterable(r, now)).length
    const monthStart = new Date(now)
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)
    const spentThisMonth = transactions
      .filter((t) => t.type === 'entry' && t.status === 'completed' && new Date(t.createdAt) >= monthStart)
      .reduce((sum, t) => sum + Math.abs(t.raffs), 0)
    // Entries per day, last 7 days, for the sparkline
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - (6 - i))
      return d.getTime()
    })
    const perDay = days.map((start) =>
      entries
        .filter((e) => {
          const t = new Date(e.createdAt).getTime()
          return t >= start && t < start + 86400000
        })
        .reduce((sum, e) => sum + e.qty, 0),
    )
    const nextDraw = raffles
      .filter((r) => isEnterable(r, now))
      .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())[0]
    const closingSoon = raffles
      .filter((r) => isEnterable(r, now))
      .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())
      .slice(0, 3)
    return { totalEntries, active, spentThisMonth, perDay, nextDraw, closingSoon }
  }, [entries, raffles, transactions, now])

  if (!profile) return null
  const hour = new Date(now).getHours()
  const balanceNaira = quote ? raffsToNaira(balance, quote) : null

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex flex-col gap-4">
      {/* Header */}
      <motion.header variants={popIn} className="flex items-center gap-3">
        <Link to="/profile" aria-label="My profile" onClick={() => sound.play('click')}>
          <Avatar name={profile.fullName} seed={profile.username} image={profile.verification.selfieImage} size={46} />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-mist">{greeting(hour)}</p>
          <h1 className="truncate text-[20px] font-bold">@{profile.username}</h1>
        </div>
        <button
          type="button"
          aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
          aria-pressed={muted}
          onClick={() => {
            setMuted(!muted)
            if (muted) sound.play('pop')
            haptics.select()
          }}
          className="tap flex items-center justify-center rounded-full glass text-cloud"
        >
          {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
        </button>
      </motion.header>

      {/* Balance hero */}
      <motion.section variants={popIn} className="relative overflow-hidden rounded-card bg-brand p-5 shadow-glow">
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/15 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-12 left-10 h-36 w-36 rounded-full bg-sun/25 blur-2xl" />
        <div className="relative flex items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-white/80">My Raffs</p>
            <div className="mt-1 flex items-center gap-2">
              <RaffsCoin size={30} />
              <AnimatedNumber value={balance} className="text-[40px] font-extrabold leading-none text-white" />
            </div>
            <p className="mt-2 h-5 text-[13px] font-semibold text-white/80">
              {balanceNaira !== null ? `about ${formatNaira(balanceNaira)} at the current rate` : 'Refreshing rate'}
            </p>
          </div>
          <RateChip className="shrink-0 border-white/30 bg-white/15 text-white" />
        </div>
        <div className="relative mt-5 flex gap-2">
          <BouncyButton variant="sun" size="md" icon={<Wallet size={18} />} onClick={() => navigate('/wallet')} className="flex-1">
            Fund my account
          </BouncyButton>
          <BouncyButton
            variant="outline"
            size="md"
            sfx="click"
            icon={<Ticket size={18} />}
            onClick={() => navigate('/raffles')}
            className="flex-1 border-white/40"
          >
            Enter a raffle
          </BouncyButton>
        </div>
      </motion.section>

      {/* Analytics */}
      <div className="grid grid-cols-2 gap-3">
        <StatTile
          label="Entries made"
          value={stats.totalEntries}
          icon={<Ticket size={16} />}
          extra={<Sparkline values={stats.perDay} label="Entries per day, last 7 days" />}
        />
        <StatTile label="Active raffles" value={stats.active} icon={<Flame size={16} />} tone="magenta" />
        <StatTile label="Raffles won" value={wins.length} icon={<Trophy size={16} />} tone="sun" />
        <StatTile label="Raffs spent this month" value={stats.spentThisMonth} icon={<RaffsCoin size={16} />} tone="mint" />
      </div>

      {/* Next draw */}
      {stats.nextDraw ? (
        <motion.section variants={popIn} className="surface rounded-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-semibold text-mist">Next draw</p>
            {isUrgent(stats.nextDraw, now) && (
              <span className="flex items-center gap-1 text-[12px] font-bold text-magenta-2">
                <Sparkles size={14} /> Under an hour
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="h-16 w-16 shrink-0 rounded-2xl bg-white/5 p-1">
              <PrizeArt kind={stats.nextDraw.kind} hue={stats.nextDraw.hue} className="h-full w-full" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[16px] font-bold">{stats.nextDraw.prizeName}</h3>
              <p className="text-[12px] text-mist">Market value {formatNaira(stats.nextDraw.marketPriceNaira)}</p>
            </div>
          </div>
          <Countdown target={stats.nextDraw.deadline} variant="segments" className="mt-4" />
          <BouncyButton
            block
            className="mt-4"
            pulse={isUrgent(stats.nextDraw, now)}
            onClick={() => navigate(`/raffles/${stats.nextDraw!.id}`)}
          >
            Enter this raffle
          </BouncyButton>
        </motion.section>
      ) : null}

      {/* Closing soon list */}
      {stats.closingSoon.length > 0 && (
        <motion.section variants={popIn}>
          <div className="flex items-center justify-between px-1">
            <h2 className="text-[17px] font-bold">Closing soon</h2>
            <Link to="/raffles" className="flex items-center text-[13px] font-semibold text-mist" onClick={() => sound.play('click')}>
              All raffles <ChevronRight size={16} />
            </Link>
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {stats.closingSoon.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  sound.play('click')
                  haptics.select()
                  navigate(`/raffles/${r.id}`)
                }}
                className="tap surface flex items-center gap-3 rounded-2xl p-3 text-left active:scale-[0.98] transition-transform"
              >
                <div className="h-12 w-12 shrink-0 rounded-xl bg-white/5">
                  <PrizeArt kind={r.kind} hue={r.hue} className="h-full w-full" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-bold">{r.prizeName}</p>
                  <p className="text-[12px] text-mist">
                    {r.entriesCount} of {r.entriesTarget} entries
                  </p>
                </div>
                <Countdown target={r.deadline} className={cn('text-[13px]', getRaffleStatus(r, now) === 'closing_soon' && 'text-magenta-2')} />
              </button>
            ))}
          </div>
        </motion.section>
      )}
    </motion.div>
  )
}

function StatTile({
  label,
  value,
  icon,
  extra,
  tone = 'grape',
}: {
  label: string
  value: number
  icon: React.ReactNode
  extra?: React.ReactNode
  tone?: 'grape' | 'magenta' | 'sun' | 'mint'
}) {
  const tones = {
    grape: 'bg-grape/30 text-grape-2',
    magenta: 'bg-magenta/20 text-magenta-2',
    sun: 'bg-sun/15 text-sun',
    mint: 'bg-mint/15 text-mint',
  }
  return (
    <motion.div variants={popIn} className="surface flex flex-col rounded-card p-4">
      <div className="flex items-center justify-between">
        <span className={cn('flex h-8 w-8 items-center justify-center rounded-xl', tones[tone])}>{icon}</span>
        {extra}
      </div>
      <AnimatedNumber value={value} className="mt-3 text-[28px] font-extrabold leading-none" />
      <p className="mt-1 text-[12px] font-semibold text-mist">{label}</p>
    </motion.div>
  )
}
