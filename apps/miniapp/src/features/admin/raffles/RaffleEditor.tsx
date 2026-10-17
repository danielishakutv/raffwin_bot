/**
 * Create or edit a raffle. Sections run in the order an admin thinks: what
 * it is, how it looks, how it sells, what it gives away, the small print.
 * Wide screens keep the player preview beside the form; phones switch
 * between Edit and Preview, with Save always in reach at the bottom.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, Eye, PencilLine } from 'lucide-react'
import { RAFFLE_KINDS } from '@raffwin/shared/admin-schemas'
import type { AdminRaffle } from '@raffwin/shared/admin-types'
import { cn } from '@/components/ui/cn'
import { adminCall } from '../adminSession'
import { digits, fmt, relative, useAction } from '../hooks'
import { askConfirm } from '../ask'
import { Badge, Button, Card, Err, Field, Notice, Segmented, Select, TextArea, TextInput } from '../ui'
import { CATEGORY_SUGGESTIONS, draftFromRaffle, emptyDraft, HUES, KIND_LABEL, previewRaffle, toLocalInput, validate, type PrizeKind, type RaffleDraft } from './draft'
import { ImagePicker } from './ImagePicker'
import { PrizeEditor } from './PrizeEditor'
import { RafflePreview } from './RafflePreview'
import { StatusBadge } from './StatusBadge'

interface RaffleEditorProps {
  raffle: AdminRaffle | null
  superAdmin: boolean
  onClose: () => void
  onSaved: (r: AdminRaffle, wasNew: boolean) => void
}

export function RaffleEditor({ raffle, superAdmin, onClose, onSaved }: RaffleEditorProps) {
  const [draft, setDraft] = useState<RaffleDraft>(() => (raffle ? draftFromRaffle(raffle) : emptyDraft()))
  const [pristine] = useState(() => JSON.stringify(raffle ? draftFromRaffle(raffle) : emptyDraft()))
  const [view, setView] = useState<'edit' | 'preview'>('edit')
  const [tried, setTried] = useState(false)
  const action = useAction()
  const set = <K extends keyof RaffleDraft>(k: K, v: RaffleDraft[K]) => setDraft((d) => ({ ...d, [k]: v }))

  const { body, problems } = useMemo(() => validate(draft), [draft])
  const preview = useMemo(() => previewRaffle(draft, raffle), [draft, raffle])
  const shown = tried ? problems : {}
  const problemCount = Object.keys(problems).length
  const dirty = JSON.stringify(draft).replace(/"key":"p\d+",?/g, '') !== pristine.replace(/"key":"p\d+",?/g, '')
  const isOpen = raffle?.status === 'open'
  const sold = raffle?.entriesCount ?? 0
  const locked = isOpen && sold > 0 ? (raffle?.prizes.length ?? 0) : 0

  const price = Number(draft.entryPriceRaffs) || 0
  const target = Number(draft.entriesTarget) || 0
  const deadline = new Date(draft.deadline)

  const save = () => {
    setTried(true)
    if (problemCount > 0) {
      setView('edit')
      // Bring the first problem into view once the error styles have rendered
      window.setTimeout(() => {
        const first = document.querySelector<HTMLElement>('[aria-invalid="true"]')
        first?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        first?.focus({ preventScroll: true })
      }, 50)
      return
    }
    void action
      .run(() => (raffle ? adminCall<AdminRaffle>('PUT', `/raffles/${raffle.id}`, body) : adminCall<AdminRaffle>('POST', '/raffles', body)))
      .then((r) => r && onSaved(r, !raffle))
  }

  const close = async () => {
    if (dirty && !(await askConfirm('Leave without saving? Your changes will be lost.', 'Leave', true))) return
    onClose()
  }

  const quickDeadline = (days: number) => {
    const d = new Date(Date.now() + days * 86_400_000)
    d.setHours(20, 0, 0, 0)
    set('deadline', toLocalInput(d))
  }

  return (
    <div className="admin-in pb-24 lg:pb-6">
      {/* Title bar */}
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={15} />} onClick={() => void close()}>
          Raffles
        </Button>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate text-[18px] font-extrabold tracking-tight">{raffle ? draft.prizeName || raffle.prizeName : 'New raffle'}</h2>
          {raffle ? <StatusBadge status={raffle.status} /> : <Badge tone="dashed">new draft</Badge>}
          {dirty && <Badge tone="muted">unsaved</Badge>}
        </div>
        <div className="hidden gap-2 lg:flex">
          <Button variant="ghost" onClick={() => void close()}>
            Cancel
          </Button>
          <Button variant="solid" busy={action.busy} onClick={save}>
            {raffle ? 'Save changes' : 'Save draft'}
          </Button>
        </div>
      </div>

      {isOpen && (
        <Notice className="mb-4">
          This raffle is live. {sold > 0 ? `${fmt(sold)} entries are sold, so entries on sale cannot go below that and prizes can be added but not removed.` : 'Nobody has entered yet.'} A new entry price applies to new entries only.
          {!superAdmin && ' Only a super admin can save changes to a live raffle.'}
        </Notice>
      )}
      <Err message={action.error} className="mb-4" />
      {tried && problemCount > 0 && (
        <Notice tone="error" className="mb-4">
          {problemCount === 1 ? 'One thing needs fixing' : `${problemCount} things need fixing`} before saving: {Object.values(problems).slice(0, 3).join('; ')}
          {problemCount > 3 ? '...' : '.'}
        </Notice>
      )}

      {/* Phone: switch between the form and the preview */}
      <Segmented
        className="mb-4 lg:hidden"
        value={view}
        onChange={setView}
        options={[
          { value: 'edit', label: <><PencilLine size={14} /> Edit</> },
          { value: 'preview', label: <><Eye size={14} /> Preview</> },
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className={cn('grid min-w-0 content-start gap-4', view === 'preview' && 'hidden lg:grid')}>
          <Step n={1} title="The prize" subtitle="Its name is the raffle's title on the card.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Prize name" error={shown.prizeName} className="sm:col-span-2" aside={`${draft.prizeName.length}/80`}>
                <TextInput value={draft.prizeName} maxLength={80} placeholder="e.g. Samsung Galaxy A15" invalid={!!shown.prizeName} onChange={(e) => set('prizeName', e.target.value)} />
              </Field>
              <Field label="Model or short detail" hint="One line under the name." error={shown.model}>
                <TextInput value={draft.model} maxLength={80} placeholder="e.g. 8GB RAM, 256GB, 5G" onChange={(e) => set('model', e.target.value)} />
              </Field>
              <Field label="Category" error={shown.category} hint="Shown as a tag on the card.">
                <TextInput value={draft.category} maxLength={40} list="raffle-categories" invalid={!!shown.category} onChange={(e) => set('category', e.target.value)} />
                <datalist id="raffle-categories">
                  {CATEGORY_SUGGESTIONS.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
              <Field label="Market value (₦)" error={shown.marketPriceNaira} hint="What it sells for in shops; shown to players.">
                <TextInput inputMode="numeric" value={draft.marketPriceNaira} placeholder="e.g. 185000" invalid={!!shown.marketPriceNaira} onChange={(e) => set('marketPriceNaira', digits(e.target.value))} />
              </Field>
            </div>
          </Step>

          <Step n={2} title="Photo and colour" subtitle="Upload a photo or import one from a link. Without one, the card shows a drawn illustration.">
            <ImagePicker value={draft.imageUrl} onChange={(v) => set('imageUrl', v)} kind={draft.kind} hue={draft.hue} />
            <div className="mt-4 grid gap-3 border-t border-black/10 pt-4 sm:grid-cols-2">
              <Field label="Card colour">
                <div className="flex flex-wrap gap-1.5">
                  {HUES.map((h) => (
                    <button
                      key={h}
                      type="button"
                      aria-label={`Colour ${h}`}
                      aria-pressed={draft.hue === h}
                      onClick={() => set('hue', h)}
                      className={cn('h-8 w-8 rounded-full transition-transform duration-150 hover:scale-110', draft.hue === h ? 'ring-2 ring-black ring-offset-2' : 'ring-1 ring-black/10')}
                      style={{ backgroundImage: `linear-gradient(150deg, hsl(${h} 80% 48%), hsl(${(h + 45) % 360} 85% 42%))` }}
                    />
                  ))}
                </div>
                <input type="range" min={0} max={360} value={draft.hue} onChange={(e) => set('hue', Number(e.target.value))} className="mt-2 w-full accent-black" aria-label="Fine-tune colour" />
              </Field>
              <Field label="Illustration" hint={draft.imageUrl ? 'Used only if the photo cannot load.' : 'Shown on the card while there is no photo.'}>
                <Select value={draft.kind} onChange={(e) => set('kind', e.target.value as PrizeKind)}>
                  {RAFFLE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Step>

          <Step n={3} title="Entries and draw" subtitle="The price of one entry is fixed in Raffs.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Entry price (Raffs)" error={shown.entryPriceRaffs}>
                <TextInput inputMode="numeric" value={draft.entryPriceRaffs} placeholder="e.g. 50" invalid={!!shown.entryPriceRaffs} onChange={(e) => set('entryPriceRaffs', digits(e.target.value))} />
              </Field>
              <Field label="Entries on sale" error={shown.entriesTarget} hint={isOpen && sold ? `At least ${fmt(sold)} (already sold).` : 'The raffle closes early when they sell out.'}>
                <TextInput inputMode="numeric" value={draft.entriesTarget} placeholder="e.g. 500" invalid={!!shown.entriesTarget} onChange={(e) => set('entriesTarget', digits(e.target.value))} />
              </Field>
              <div className="rounded-lg bg-neutral-50 px-3 py-2.5 text-[12.5px] sm:col-span-2">
                <span className="text-neutral-600">Full pool if every entry sells: </span>
                <span className="font-bold">{price && target ? `${fmt(price * target)} Raffs` : '-'}</span>
              </div>
              <Field
                label="Draw date and time"
                error={shown.deadline}
                className="sm:col-span-2"
                hint={Number.isNaN(deadline.getTime()) ? 'Entries close and the draw happens at this moment.' : `${relative(deadline.toISOString())}. Entries close and the draw happens at this moment. Publishing needs it at least an hour away.`}
              >
                <TextInput type="datetime-local" value={draft.deadline} invalid={!!shown.deadline} onChange={(e) => set('deadline', e.target.value)} />
              </Field>
              <div className="flex flex-wrap gap-1.5 sm:col-span-2">
                {[1, 3, 7, 14, 30].map((d) => (
                  <Button key={d} size="sm" variant="outline" onClick={() => quickDeadline(d)}>
                    {d === 1 ? 'Tomorrow' : `${d} days`}, 8 pm
                  </Button>
                ))}
              </div>
            </div>
          </Step>

          <Step n={4} title="Prizes" subtitle={draft.prizes.length === 1 ? 'One by default. Add more for 2nd, 3rd and further places.' : `${draft.prizes.length} places, named in order.`}>
            <PrizeEditor prizes={draft.prizes} onChange={(p) => set('prizes', p)} raffleName={draft.prizeName} locked={locked} problems={shown} />
          </Step>

          <Step n={5} title="Description and rules" subtitle="Shown when a player opens the raffle.">
            <div className="grid gap-3">
              <Field label="Description" aside={`${draft.description.length}/2000`} error={shown.description}>
                <TextArea rows={4} maxLength={2000} value={draft.description} placeholder="Condition, warranty, colour, what is in the box..." onChange={(e) => set('description', e.target.value)} />
              </Field>
              <Field label="Extra rules" hint="One per line, up to 20. The standard rules are always shown too." error={shown.rules ?? Object.entries(shown).find(([k]) => k.startsWith('rules.'))?.[1]}>
                <TextArea rows={3} value={draft.rules} placeholder={'e.g. Colour may vary\nCollect within 14 days of the draw'} onChange={(e) => set('rules', e.target.value)} />
              </Field>
            </div>
          </Step>
        </div>

        <aside className={cn('min-w-0', view === 'edit' && 'hidden lg:block')}>
          <div className="lg:sticky lg:top-4">
            <RafflePreview raffle={preview} />
          </div>
        </aside>
      </div>

      {/* Phone: Save stays in reach */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-black/15 bg-white/95 px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-[12px] text-neutral-600">
            {tried && problemCount ? `${problemCount} to fix` : dirty ? 'Unsaved changes' : raffle ? 'No changes yet' : 'Hidden until published'}
          </p>
          <Button variant="ghost" onClick={() => void close()}>
            Cancel
          </Button>
          <Button variant="solid" busy={action.busy} onClick={save}>
            {raffle ? 'Save' : 'Save draft'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Step({ n, title, subtitle, children }: { n: number; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-black text-[11px] font-bold text-white">{n}</span>
          {title}
        </span>
      }
      subtitle={subtitle}
    >
      {children}
    </Card>
  )
}
