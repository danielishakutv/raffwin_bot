/**
 * The raffle editor's form state, and the two conversions around it: from a
 * saved raffle, and to the API body (validated with the server's own schema).
 */
import { prizeLabel } from '@raffwin/shared'
import { raffleBody, RAFFLE_KINDS } from '@raffwin/shared/admin-schemas'
import type { AdminRaffle } from '@raffwin/shared/admin-types'
import type { Raffle } from '@/data/types'

export type PrizeKind = (typeof RAFFLE_KINDS)[number]

export const KIND_LABEL: Record<PrizeKind, string> = {
  phone: 'Phone',
  laptop: 'Laptop',
  tv: 'TV',
  earbuds: 'Earbuds',
  powerbank: 'Power bank',
  voucher: 'Voucher',
  console: 'Game console',
}

export const CATEGORY_SUGGESTIONS = ['Phones', 'Laptops', 'TVs', 'Audio', 'Gaming', 'Accessories', 'Vouchers', 'Home']

/** Card colours to pick from; any hue 0-360 works */
export const HUES = [260, 225, 190, 160, 130, 45, 20, 345, 310, 285]

export interface PrizeDraft {
  /** Stable React key while places move up and down */
  key: string
  prizeItem: string
  prizeType: 'physical' | 'raffs_credit'
  raffsValue: string
  costNaira: string
}

export interface RaffleDraft {
  prizeName: string
  model: string
  category: string
  kind: PrizeKind
  hue: number
  imageUrl: string | null
  marketPriceNaira: string
  entryPriceRaffs: string
  entriesTarget: string
  /** datetime-local value, local time */
  deadline: string
  description: string
  /** One rule per line */
  rules: string
  prizes: PrizeDraft[]
}

let seq = 0
export const newPrize = (over: Partial<PrizeDraft> = {}): PrizeDraft => ({
  key: `p${(seq += 1)}`,
  prizeItem: '',
  prizeType: 'physical',
  raffsValue: '',
  costNaira: '',
  ...over,
})

/** datetime-local wants "YYYY-MM-DDTHH:mm" in local time */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function emptyDraft(now = Date.now()): RaffleDraft {
  // A week out, on the hour: a sensible draw time to edit from
  const d = new Date(now + 7 * 86_400_000)
  d.setMinutes(0, 0, 0)
  d.setHours(20)
  return {
    prizeName: '',
    model: '',
    category: 'Phones',
    kind: 'phone',
    hue: 260,
    imageUrl: null,
    marketPriceNaira: '',
    entryPriceRaffs: '',
    entriesTarget: '',
    deadline: toLocalInput(d),
    description: '',
    rules: '',
    prizes: [newPrize()],
  }
}

export function draftFromRaffle(r: AdminRaffle): RaffleDraft {
  return {
    prizeName: r.prizeName,
    model: r.model,
    category: r.category,
    kind: (RAFFLE_KINDS as readonly string[]).includes(r.kind) ? (r.kind as PrizeKind) : 'phone',
    hue: r.hue,
    imageUrl: r.imageUrl,
    marketPriceNaira: String(r.marketPriceNaira),
    entryPriceRaffs: String(r.entryPriceRaffs),
    entriesTarget: String(r.entriesTarget),
    deadline: toLocalInput(new Date(r.deadline)),
    description: r.description,
    rules: r.rules.join('\n'),
    prizes: [...r.prizes]
      .sort((a, b) => a.position - b.position)
      .map((p) =>
        newPrize({
          prizeItem: p.prizeItem,
          prizeType: p.prizeType,
          raffsValue: p.prizeType === 'raffs_credit' ? String(p.raffsValue) : '',
          costNaira: p.prizeType === 'physical' && p.costNaira ? String(p.costNaira) : '',
        }),
      ),
  }
}

const num = (v: string) => (v.trim() === '' ? Number.NaN : Number(v))

/** The first prize defaults to the raffle's own prize when left empty. */
export function prizeItemOf(d: RaffleDraft, index: number): string {
  const item = d.prizes[index]?.prizeItem.trim() ?? ''
  return item || (index === 0 ? d.prizeName.trim() : '')
}

export function bodyFromDraft(d: RaffleDraft) {
  const deadline = new Date(d.deadline)
  return {
    prizeName: d.prizeName,
    model: d.model,
    category: d.category,
    kind: d.kind,
    hue: d.hue,
    imageUrl: d.imageUrl,
    marketPriceNaira: num(d.marketPriceNaira),
    entryPriceRaffs: num(d.entryPriceRaffs),
    entriesTarget: num(d.entriesTarget),
    deadline: Number.isNaN(deadline.getTime()) ? '' : deadline.toISOString(),
    description: d.description,
    rules: d.rules
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    prizes: d.prizes.map((p, i) =>
      p.prizeType === 'raffs_credit'
        ? { position: i + 1, prizeItem: prizeItemOf(d, i), prizeType: 'raffs_credit' as const, raffsValue: num(p.raffsValue), costNaira: 0 }
        : { position: i + 1, prizeItem: prizeItemOf(d, i), prizeType: 'physical' as const, raffsValue: 0, costNaira: p.costNaira ? num(p.costNaira) : 0 },
    ),
  }
}

/** Field path ("prizes.1.raffsValue") -> message, in the server's words. */
export type Problems = Record<string, string>

const FRIENDLY: Record<string, string> = {
  prizeName: 'Give the raffle a name (2 to 80 letters)',
  category: 'Pick or type a category',
  marketPriceNaira: 'Enter the market price in Naira',
  entryPriceRaffs: 'Enter the price of one entry in Raffs',
  entriesTarget: 'Enter how many entries are on sale',
  deadline: 'Pick the draw date and time',
}

export function validate(d: RaffleDraft): { body: ReturnType<typeof bodyFromDraft>; problems: Problems } {
  const body = bodyFromDraft(d)
  const parsed = raffleBody.safeParse(body)
  const problems: Problems = {}
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.')
      if (problems[path]) continue
      const isTypeError = issue.code === 'invalid_type' || /expected number|NaN|Invalid ISO|datetime/i.test(issue.message)
      const prize = /^prizes\.(\d+)\./.exec(path)
      const which = prize ? (d.prizes.length === 1 ? 'the prize' : `the ${prizeLabel(Number(prize[1]) + 1, d.prizes.length)} prize`) : ''
      problems[path] =
        (isTypeError && FRIENDLY[path]) ||
        (path.endsWith('prizeItem') ? `Name ${which} (2 letters or more)` : path.endsWith('raffsValue') && isTypeError ? `Enter the Raffs for ${which}` : issue.message)
    }
  }
  return { body, problems }
}

/** What players will see, built from the form as it stands. */
export function previewRaffle(d: RaffleDraft, saved: AdminRaffle | null, now = Date.now()): Raffle {
  const deadline = new Date(d.deadline)
  const target = Math.max(1, Math.floor(num(d.entriesTarget)) || 100)
  return {
    id: saved?.id ?? 'preview',
    prizeName: d.prizeName.trim() || 'Prize name',
    model: d.model.trim(),
    category: d.category.trim() || 'Category',
    kind: d.kind,
    hue: d.hue,
    imageUrl: d.imageUrl,
    marketPriceNaira: num(d.marketPriceNaira) || 0,
    entryPriceRaffs: num(d.entryPriceRaffs) || 0,
    deadline: Number.isNaN(deadline.getTime()) ? new Date(now + 86_400_000).toISOString() : deadline.toISOString(),
    entriesCount: Math.min(saved?.entriesCount ?? 0, target),
    entriesTarget: target,
    description: d.description.trim(),
    rules: bodyFromDraft(d).rules,
    winners: d.prizes.map((_, i) => ({ position: i + 1, prizeItem: prizeItemOf(d, i) || `Prize ${i + 1}`, username: null })),
    drawnAt: null,
    seedCommitment: null,
    entrants: [],
  }
}
