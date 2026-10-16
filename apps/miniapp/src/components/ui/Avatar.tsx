import { cn } from './cn'
import { hueFromString, initials } from '@/services/format'

interface AvatarProps {
  name: string
  seed?: string
  image?: string | null
  size?: number
  className?: string
}

/** Initials badge on a per-user gradient, or the uploaded selfie when present. */
export function Avatar({ name, seed, image, size = 48, className }: AvatarProps) {
  const hue = hueFromString(seed ?? name)
  return (
    <div
      className={cn('relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-display font-bold text-white shadow-card', className)}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 85% 58%), hsl(${(hue + 60) % 360} 90% 55%))`,
      }}
      aria-label={name}
    >
      {image ? <img src={image} alt="" className="h-full w-full object-cover" /> : initials(name)}
    </div>
  )
}
