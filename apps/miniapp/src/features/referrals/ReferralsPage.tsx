import { motion } from 'framer-motion'
import { Copy, Gift, Send, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as api from '@/api'
import { errorMessage } from '@/api/errors'
import { staggerContainer, popIn } from '@/components/motion'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { cn } from '@/components/ui/cn'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { RaffsCoin } from '@/components/ui/RaffsCoin'
import { Spinner } from '@/components/ui/Spinner'
import { toast } from '@/components/ui/toastStore'
import type { Page, ReferralEarning, ReferralSummary, ReferredPerson } from '@/data/types'
import { useBackButton } from '@/hooks/useBackButton'
import { formatDate, formatDateTime, formatInt } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { openExternal } from '@/services/telegram'

type Tab = 'people' | 'earnings'

/** Loads a cursor-paginated list with an explicit "load more"; errors stay visible, never swallowed. */
function usePaged<T>(load: (cursor?: string) => Promise<Page<T>>) {
  const [items, setItems] = useState<T[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  const fetchPage = useCallback(
    async (after?: string) => {
      setState('loading')
      try {
        const page = await load(after)
        setItems((cur) => (after ? [...cur, ...page.items] : page.items))
        setCursor(page.nextCursor)
        setState('ready')
      } catch (err) {
        setError(errorMessage(err))
        setState('error')
      }
    },
    [load],
  )

  useEffect(() => {
    void fetchPage()
  }, [fetchPage])

  return { items, cursor, state, error, more: () => cursor && void fetchPage(cursor), retry: () => void fetchPage() }
}

/**
 * Referral tracker: your link, totals, the people you brought in and a
 * statement of every 10% you earned. Earnings are Raffs only.
 */
export function ReferralsPage() {
  const navigate = useNavigate()
  useBackButton(true, () => navigate('/profile'))
  const [summary, setSummary] = useState<ReferralSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('people')
  const people = usePaged<ReferredPerson>(api.getReferredPeople)
  const earnings = usePaged<ReferralEarning>(api.getReferralEarnings)

  useEffect(() => {
    api.getReferralSummary().then(setSummary, (err: unknown) => setSummaryError(errorMessage(err)))
  }, [])

  const copy = async () => {
    if (!summary) return
    try {
      await navigator.clipboard.writeText(summary.link)
      toast.success('Link copied')
      haptics.notify('success')
    } catch (err) {
      // Some Telegram webviews block the clipboard; say so and show the link to copy by hand
      console.warn('[referrals] clipboard blocked', err)
      toast.error('Copying is blocked here. Press and hold the link to copy it.')
    }
  }

  const share = () => {
    if (!summary) return
    sound.play('click')
    const text = 'Join me on Raffle Win: enter raffles for phones, laptops and more, right inside Telegram.'
    openExternal(`https://t.me/share/url?url=${encodeURIComponent(summary.link)}&text=${encodeURIComponent(text)}`)
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex flex-col gap-4">
      <PageHeader title="Invite friends" subtitle="Earn 10% of every entry they make, in Raffs" back="/profile" />

      <motion.section variants={popIn} className="surface rounded-card p-4">
        {summaryError ? (
          <p className="text-[13px] text-coral">{summaryError}</p>
        ) : !summary ? (
          <div className="flex justify-center py-6">
            <Spinner className="h-6 w-6 text-mist" />
          </div>
        ) : (
          <>
            <p className="text-[12px] font-semibold text-mist">My invite link</p>
            <p className="mt-1 select-all break-all rounded-xl bg-white/5 px-3 py-2 font-mono text-[13px]">{summary.link}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <BouncyButton variant="secondary" icon={<Copy size={16} />} onClick={() => void copy()}>
                Copy
              </BouncyButton>
              <BouncyButton icon={<Send size={16} />} onClick={share}>
                Share
              </BouncyButton>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Stat label="People referred" value={formatInt(summary.peopleReferred)} />
              <Stat label="Entered this month" value={formatInt(summary.activeThisMonth)} />
              <Stat label="Earned all time" value={formatInt(summary.lifetimeRaffs)} coin />
              <Stat label="Earned this month" value={formatInt(summary.monthRaffs)} coin />
            </div>
          </>
        )}
      </motion.section>

      <motion.div variants={popIn} className="flex gap-2">
        {(['people', 'earnings'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              sound.play('click')
              setTab(t)
            }}
            className={cn('tap h-9 rounded-pill px-4 text-[13px] font-bold', tab === t ? 'bg-brand text-white' : 'bg-white/8 text-mist')}
          >
            {t === 'people' ? 'People' : 'Earnings'}
          </button>
        ))}
      </motion.div>

      {tab === 'people' ? (
        <List
          paged={people}
          empty={<EmptyState icon={<Users size={26} />} title="No one yet" body="Share your link. When a friend signs up through it, they show here." />}
          row={(p) => (
            <li key={p.username} className="surface flex items-center justify-between gap-3 rounded-2xl p-3">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-bold">@{p.username}</p>
                <p className="text-[12px] text-haze">
                  Joined {formatDate(p.joinedAt)} · {p.entries} {p.entries === 1 ? 'entry' : 'entries'}
                </p>
              </div>
              <Raffs value={p.raffsEarned} />
            </li>
          )}
        />
      ) : (
        <List
          paged={earnings}
          empty={<EmptyState icon={<Gift size={26} />} title="Nothing earned yet" body="Every time someone you invited enters a raffle, 10% of it lands here." />}
          row={(e) => (
            <li key={e.id} className="surface flex items-center justify-between gap-3 rounded-2xl p-3">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-bold">@{e.username} · {e.raffleName}</p>
                <p className="text-[12px] text-haze">
                  {formatDateTime(e.createdAt)} · their entry {formatInt(e.entryRaffs)} Raffs
                </p>
              </div>
              <Raffs value={e.earnedRaffs} plus />
            </li>
          )}
        />
      )}
    </motion.div>
  )
}

function List<T>({
  paged,
  row,
  empty,
}: {
  paged: ReturnType<typeof usePaged<T>>
  row: (item: T) => React.ReactNode
  empty: React.ReactNode
}) {
  if (paged.state === 'error') {
    return (
      <div className="surface flex flex-col items-start gap-2 rounded-2xl p-4">
        <p className="text-[13px] text-coral">{paged.error}</p>
        <BouncyButton variant="secondary" onClick={paged.retry}>
          Try again
        </BouncyButton>
      </div>
    )
  }
  if (paged.state === 'loading' && paged.items.length === 0) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="h-6 w-6 text-mist" />
      </div>
    )
  }
  if (paged.items.length === 0) return <>{empty}</>
  return (
    <>
      <ul className="flex flex-col gap-2">{paged.items.map(row)}</ul>
      {paged.cursor && (
        <BouncyButton variant="secondary" loading={paged.state === 'loading'} onClick={() => paged.more()}>
          Load more
        </BouncyButton>
      )}
    </>
  )
}

function Stat({ label, value, coin }: { label: string; value: string; coin?: boolean }) {
  return (
    <div className="rounded-2xl bg-white/5 p-3">
      <p className="text-[11px] font-semibold text-mist">{label}</p>
      <p className="mt-1 flex items-center gap-1.5 text-[18px] font-extrabold">
        {coin && <RaffsCoin size={16} />}
        <span className="nums">{value}</span>
      </p>
    </div>
  )
}

function Raffs({ value, plus }: { value: number; plus?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-[14px] font-extrabold text-mint">
      <RaffsCoin size={14} />
      <span className="nums">
        {plus ? '+' : ''}
        {formatInt(value)}
      </span>
    </span>
  )
}
