/**
 * Tiny single-series bar sparkline for stat tiles. One hue, thin rounded
 * marks anchored to the baseline, no axes: it hints at the trend, the number
 * beside it carries the value.
 */
export function Sparkline({
  values,
  color = 'var(--color-grape-2)',
  width = 72,
  height = 28,
  label,
}: {
  values: number[]
  color?: string
  width?: number
  height?: number
  label?: string
}) {
  const max = Math.max(1, ...values)
  const gap = 3
  const barW = (width - gap * (values.length - 1)) / values.length
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? 'trend'}>
      {values.map((v, i) => {
        const h = Math.max(3, (v / max) * height)
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={height - h}
            width={barW}
            height={h}
            rx={Math.min(3, barW / 2)}
            fill={color}
            opacity={i === values.length - 1 ? 1 : 0.55}
          />
        )
      })}
    </svg>
  )
}
