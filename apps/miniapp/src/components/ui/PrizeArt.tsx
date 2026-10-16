import { useId } from 'react'
import type { PrizeKind } from '@/data/types'

interface PrizeArtProps {
  kind: PrizeKind
  hue: number
  className?: string
}

const INK = '#1a1140'
const INK2 = '#2a1f5e'

/**
 * Generated prize illustrations (no image files). Each is a few SVG shapes on
 * a gradient keyed to the raffle's hue, so every card has its own colour.
 */
export function PrizeArt({ kind, hue, className }: PrizeArtProps) {
  const uid = useId().replace(/:/g, '')
  const gradId = `pa-${uid}`
  const c1 = `hsl(${hue} 92% 64%)`
  const c2 = `hsl(${(hue + 45) % 360} 92% 56%)`

  return (
    <svg viewBox="0 0 200 200" className={className} role="img" aria-label={kind}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={c1} />
          <stop offset="1" stopColor={c2} />
        </linearGradient>
      </defs>
      <circle cx="100" cy="104" r="78" fill={`url(#${gradId})`} opacity="0.18" />
      {kind === 'phone' && (
        <g>
          <rect x="62" y="28" width="76" height="144" rx="16" fill={INK} />
          <rect x="68" y="36" width="64" height="128" rx="10" fill={`url(#${gradId})`} />
          <rect x="88" y="40" width="24" height="6" rx="3" fill={INK} />
          <path d="M68 46 L132 36 L132 70 L68 118 Z" fill="white" opacity="0.14" />
          <rect x="86" y="156" width="28" height="3" rx="1.5" fill="white" opacity="0.7" />
          <circle cx="118" cy="56" r="7" fill={INK} opacity="0.9" />
          <circle cx="118" cy="56" r="3" fill="white" opacity="0.5" />
        </g>
      )}
      {kind === 'laptop' && (
        <g>
          <rect x="40" y="44" width="120" height="80" rx="8" fill={INK} />
          <rect x="46" y="50" width="108" height="66" rx="4" fill={`url(#${gradId})`} />
          <path d="M46 50 L154 50 L154 64 L46 104 Z" fill="white" opacity="0.14" />
          <path d="M24 128 h152 l-8 16 H32 z" fill={INK2} />
          <rect x="84" y="131" width="32" height="5" rx="2.5" fill="white" opacity="0.35" />
          <circle cx="100" cy="47" r="2" fill="white" opacity="0.5" />
        </g>
      )}
      {kind === 'tv' && (
        <g>
          <rect x="22" y="42" width="156" height="96" rx="8" fill={INK} />
          <rect x="28" y="48" width="144" height="84" rx="4" fill={`url(#${gradId})`} />
          <path d="M28 48 L172 48 L172 62 L28 110 Z" fill="white" opacity="0.14" />
          <rect x="86" y="140" width="28" height="12" fill={INK2} />
          <rect x="56" y="152" width="88" height="7" rx="3.5" fill={INK2} />
          <circle cx="100" cy="135" r="2" fill="#35f0b4" />
        </g>
      )}
      {kind === 'earbuds' && (
        <g>
          <rect x="48" y="84" width="104" height="80" rx="24" fill={`url(#${gradId})`} />
          <rect x="48" y="84" width="104" height="34" rx="17" fill="white" opacity="0.16" />
          <rect x="76" y="40" width="20" height="62" rx="10" fill={INK} />
          <rect x="104" y="40" width="20" height="62" rx="10" fill={INK} />
          <circle cx="86" cy="48" r="13" fill={INK2} />
          <circle cx="114" cy="48" r="13" fill={INK2} />
          <circle cx="82" cy="44" r="4" fill="white" opacity="0.35" />
          <circle cx="110" cy="44" r="4" fill="white" opacity="0.35" />
          <circle cx="100" cy="142" r="4" fill="#35f0b4" />
        </g>
      )}
      {kind === 'powerbank' && (
        <g>
          <rect x="56" y="30" width="88" height="140" rx="22" fill={`url(#${gradId})`} />
          <path d="M56 52 L144 30 L144 60 L56 100 Z" fill="white" opacity="0.14" />
          <rect x="66" y="44" width="68" height="30" rx="8" fill={INK} />
          <circle cx="80" cy="59" r="4" fill="#35f0b4" />
          <circle cx="93" cy="59" r="4" fill="#35f0b4" />
          <circle cx="106" cy="59" r="4" fill="#35f0b4" />
          <circle cx="119" cy="59" r="4" fill="#ffffff" opacity="0.3" />
          <path d="M106 86 L88 118 H101 L95 146 L116 110 H103 L110 86 Z" fill="#ffd43b" />
          <rect x="74" y="30" width="12" height="7" fill={INK} />
          <rect x="114" y="30" width="12" height="7" fill={INK} />
        </g>
      )}
      {kind === 'voucher' && (
        <g>
          <path
            d="M30 56 H170 V82 a12 12 0 0 0 0 24 V144 H30 V106 a12 12 0 0 0 0 -24 Z"
            fill={`url(#${gradId})`}
          />
          <path d="M30 56 H170 V70 L30 108 Z" fill="white" opacity="0.14" />
          <line x1="64" y1="66" x2="64" y2="134" stroke={INK} strokeWidth="2" strokeDasharray="5 5" opacity="0.5" />
          <text
            x="118"
            y="116"
            textAnchor="middle"
            fontSize="46"
            fontWeight="800"
            fontFamily="Bricolage Grotesque, Manrope, sans-serif"
            fill={INK}
          >
            ₦
          </text>
          <circle cx="47" cy="100" r="6" fill={INK} opacity="0.75" />
        </g>
      )}
      {kind === 'console' && (
        <g>
          <rect x="70" y="26" width="60" height="148" rx="12" fill="#f7f4ff" />
          <rect x="93" y="26" width="14" height="148" fill={INK} />
          <rect x="100" y="40" width="4" height="120" fill={`url(#${gradId})`} />
          <rect x="30" y="122" width="62" height="38" rx="16" fill={`url(#${gradId})`} />
          <circle cx="48" cy="141" r="6" fill={INK} />
          <circle cx="76" cy="141" r="6" fill={INK} />
          <rect x="58" y="136" width="8" height="10" rx="2" fill={INK} opacity="0.6" />
          <circle cx="146" cy="60" r="10" fill={c1} opacity="0.9" />
          <circle cx="156" cy="88" r="6" fill={c2} opacity="0.9" />
        </g>
      )}
    </svg>
  )
}
