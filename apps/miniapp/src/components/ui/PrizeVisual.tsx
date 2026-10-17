import { useEffect, useState } from 'react'
import type { PrizeKind } from '@/data/types'
import { imageSrc } from '@/services/media'
import { cn } from './cn'
import { PrizeArt } from './PrizeArt'

interface PrizeVisualProps {
  kind: PrizeKind
  hue: number
  imageUrl?: string | null
  className?: string
  /** Rounded clip for the photo; the illustration has its own shape */
  rounded?: string
  /** Told when a photo fails to load (the illustration is shown instead) */
  onImageError?: (src: string) => void
}

/**
 * The raffle's photo when it has one, fading in once loaded; the drawn
 * illustration otherwise, and also while the photo loads or if it fails.
 */
export function PrizeVisual({ kind, hue, imageUrl, className, rounded = 'rounded-2xl', onImageError }: PrizeVisualProps) {
  const src = imageSrc(imageUrl)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => setState('loading'), [src])

  if (!src || state === 'failed') return <PrizeArt kind={kind} hue={hue} className={className} />
  return (
    <span className={cn('relative block', className)}>
      {state === 'loading' && <PrizeArt kind={kind} hue={hue} className="absolute inset-0 h-full w-full opacity-40" />}
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setState('ready')}
        onError={() => {
          console.warn('[prize] photo did not load; showing the illustration', src)
          setState('failed')
          onImageError?.(src)
        }}
        className={cn(
          'h-full w-full object-cover transition-[opacity,transform] duration-500 ease-out',
          rounded,
          state === 'ready' ? 'scale-100 opacity-100' : 'scale-[0.97] opacity-0',
        )}
      />
    </span>
  )
}
