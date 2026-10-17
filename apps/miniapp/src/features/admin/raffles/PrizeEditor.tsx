/**
 * The prize list. One prize by default ("Prize"); adding more turns them into
 * places, named in order: 1st, 2nd, 3rd ... nth. Places can be moved and,
 * where allowed, removed; numbering always follows the order on screen.
 */
import { ArrowDown, ArrowUp, Gift, Plus, Trash2 } from 'lucide-react'
import { MAX_PRIZES, ordinal, prizeLabel } from '@raffwin/shared'
import { cn } from '@/components/ui/cn'
import { digits, fmt } from '../hooks'
import { Badge, Button, Field, IconButton, Segmented, TextInput } from '../ui'
import { newPrize, type PrizeDraft, type Problems } from './draft'

interface PrizeEditorProps {
  prizes: PrizeDraft[]
  onChange: (prizes: PrizeDraft[]) => void
  /** The raffle's own name: the first prize uses it when left empty */
  raffleName: string
  /** Places that cannot be removed (an open raffle with entries keeps what it promised) */
  locked: number
  problems: Problems
}

export function PrizeEditor({ prizes, onChange, raffleName, locked, problems }: PrizeEditorProps) {
  const total = prizes.length
  const update = (i: number, patch: Partial<PrizeDraft>) => onChange(prizes.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const move = (i: number, by: -1 | 1) => {
    const next = [...prizes]
    const [item] = next.splice(i, 1)
    if (item) next.splice(i + by, 0, item)
    onChange(next)
  }
  const remove = (i: number) => onChange(prizes.filter((_, j) => j !== i))
  const add = () => onChange([...prizes, newPrize()])

  return (
    <div className="grid gap-3">
      <p className="text-[12.5px] leading-snug text-neutral-600">
        {total === 1
          ? 'One prize, one winner. Players see it as "Prize". Add more to make places: 1st, 2nd, 3rd and so on.'
          : `${total} places, drawn in order. One ticket wins one prize. Move a prize up or down to change its place.`}
      </p>

      <ol className="grid gap-2.5">
        {prizes.map((p, i) => {
          const label = prizeLabel(i + 1, total)
          const err = (k: string) => problems[`prizes.${i}.${k}`]
          return (
            <li key={p.key} className={cn('admin-in rounded-xl border bg-white transition-colors', err('prizeItem') || err('raffsValue') ? 'border-black' : 'border-black/15')}>
              <div className="flex flex-wrap items-center gap-2 border-b border-black/10 px-3 py-2">
                <span
                  className={cn(
                    'inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[12px] font-extrabold',
                    i === 0 ? 'bg-black text-white' : 'border border-black text-black',
                  )}
                >
                  {total === 1 ? <Gift size={14} /> : label}
                </span>
                <span className="text-[13px] font-bold">{total === 1 ? 'Prize' : `${label} prize`}</span>
                {i < locked && <Badge tone="muted">promised</Badge>}
                <span className="ml-auto flex items-center">
                  {total > 1 && (
                    <>
                      <IconButton label={`Move ${label} up`} icon={<ArrowUp size={15} />} disabled={i === 0} onClick={() => move(i, -1)} />
                      <IconButton label={`Move ${label} down`} icon={<ArrowDown size={15} />} disabled={i === total - 1} onClick={() => move(i, 1)} />
                    </>
                  )}
                  <IconButton
                    label={i < locked ? 'Players were promised this place; it cannot be removed' : `Remove ${label} prize`}
                    icon={<Trash2 size={15} />}
                    disabled={total === 1 || i < locked}
                    onClick={() => remove(i)}
                  />
                </span>
              </div>

              <div className="grid gap-3 p-3 sm:grid-cols-2">
                <Field label="What they win" error={err('prizeItem')} className="sm:col-span-2">
                  <TextInput
                    value={p.prizeItem}
                    maxLength={120}
                    placeholder={i === 0 && raffleName.trim() ? raffleName.trim() : i === 0 ? 'e.g. Samsung Galaxy A15' : 'e.g. 2,000 Raffs credit or ₦20,000 airtime'}
                    invalid={!!err('prizeItem')}
                    onChange={(e) => update(i, { prizeItem: e.target.value })}
                  />
                </Field>
                <Field label="Prize type">
                  <Segmented
                    size="sm"
                    value={p.prizeType}
                    onChange={(v) => update(i, { prizeType: v })}
                    options={[
                      { value: 'physical', label: 'Item' },
                      { value: 'raffs_credit', label: 'Raffs credit' },
                    ]}
                  />
                </Field>
                {p.prizeType === 'raffs_credit' ? (
                  <Field label="Raffs paid to the winner" error={err('raffsValue')} hint="Credited to their balance at the draw.">
                    <TextInput inputMode="numeric" value={p.raffsValue} placeholder="e.g. 2000" invalid={!!err('raffsValue')} onChange={(e) => update(i, { raffsValue: digits(e.target.value) })} />
                  </Field>
                ) : (
                  <Field label="What it costs you (₦)" error={err('costNaira')} hint="Private, for the Finance tab. Players never see it.">
                    <TextInput inputMode="numeric" value={p.costNaira} placeholder="optional" onChange={(e) => update(i, { costNaira: digits(e.target.value) })} />
                  </Field>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {problems.prizes && <p className="text-[12px] font-semibold">⚠ {problems.prizes}</p>}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button icon={<Plus size={15} />} disabled={total >= MAX_PRIZES} onClick={add}>
          Add {ordinal(total + 1)} prize
        </Button>
        <span className="text-[11.5px] text-neutral-500">
          {total >= MAX_PRIZES ? `At most ${MAX_PRIZES} prizes.` : total === 1 ? 'The current prize becomes 1st.' : `Up to ${fmt(MAX_PRIZES)} places.`}
        </span>
      </div>
    </div>
  )
}
