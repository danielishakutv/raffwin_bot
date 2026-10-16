import { motion } from 'framer-motion'
import { ArrowDownLeft, ArrowUpRight, Gift, Receipt, Ticket, Trophy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { staggerContainer, popIn } from '@/components/motion'
import { cn } from '@/components/ui/cn'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { useBackButton } from '@/hooks/useBackButton'
import type { Transaction, TransactionType } from '@/data/types'
import { formatDateTime, formatInt, formatNaira } from '@/services/format'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'

type Filter = 'all' | 'in' | 'out'

const icons: Record<TransactionType, React.ElementType> = {
  purchase: ArrowDownLeft,
  entry: Ticket,
  bonus: Gift,
  prize: Trophy,
  refund: ArrowDownLeft,
}

export function HistoryPage() {
  const navigate = useNavigate()
  const transactions = useAppStore((s) => s.transactions)
  const [filter, setFilter] = useState<Filter>('all')
  useBackButton(true, () => navigate('/profile'))

  const list = useMemo(
    () => transactions.filter((t) => (filter === 'all' ? true : filter === 'in' ? t.raffs > 0 : t.raffs < 0 || t.status === 'failed')),
    [transactions, filter],
  )

  return (
    <div className="flex flex-col gap-3">
      <PageHeader title="Transaction history" subtitle="Raffs in and out of my account" back="/profile" />
      <div className="flex gap-2">
        {(['all', 'in', 'out'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => {
              sound.play('click')
              setFilter(f)
            }}
            className={cn('tap h-9 min-w-[64px] rounded-pill px-4 text-[13px] font-bold capitalize', filter === f ? 'bg-brand text-white' : 'bg-white/8 text-mist')}
          >
            {f === 'all' ? 'All' : f === 'in' ? 'Raffs in' : 'Raffs out'}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <EmptyState icon={<Receipt size={26} />} title="Nothing here yet" body="Purchases, entries, bonuses and prizes will show up here." />
      ) : (
        <motion.ul key={filter} variants={staggerContainer} initial="hidden" animate="show" className="flex flex-col gap-2">
          {list.map((t) => (
            <TransactionRow key={t.id} t={t} />
          ))}
        </motion.ul>
      )}
    </div>
  )
}

function TransactionRow({ t }: { t: Transaction }) {
  const Icon = t.status === 'failed' ? ArrowUpRight : icons[t.type]
  const positive = t.raffs > 0
  return (
    <motion.li variants={popIn} className="surface flex items-center gap-3 rounded-2xl p-3">
      <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', t.status === 'failed' ? 'bg-coral/15 text-coral' : positive ? 'bg-mint/15 text-mint' : 'bg-magenta/15 text-magenta-2')}>
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-bold">{t.note}</p>
        <p className="text-[12px] text-mist">
          {formatDateTime(t.createdAt)}
          {t.naira !== null ? ` · ${formatNaira(t.naira)}` : ''}
        </p>
      </div>
      <span className={cn('nums shrink-0 text-[15px] font-extrabold', t.status === 'failed' ? 'text-coral' : positive ? 'text-mint' : 'text-cloud')}>
        {t.status === 'failed' ? 'Failed' : `${positive ? '+' : ''}${formatInt(t.raffs)}`}
      </span>
    </motion.li>
  )
}
