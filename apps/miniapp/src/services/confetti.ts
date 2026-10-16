import confetti from 'canvas-confetti'

const BRAND = ['#6b2cf5', '#f2358d', '#2f6bff', '#ffd43b', '#35f0b4', '#ffffff']

function reduced(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** A quick burst from a point (defaults to lower-middle of the screen). */
export function burst(origin: { x: number; y: number } = { x: 0.5, y: 0.7 }): void {
  if (reduced()) return
  void confetti({
    particleCount: 90,
    spread: 70,
    startVelocity: 38,
    gravity: 1.1,
    ticks: 180,
    scalar: 1,
    origin,
    colors: BRAND,
    zIndex: 9999,
  })
}

/** Bigger two-sided celebration for wins and successful purchases. */
export function celebrate(): void {
  if (reduced()) return
  const end = Date.now() + 1200
  const frame = () => {
    void confetti({ particleCount: 6, angle: 60, spread: 60, origin: { x: 0, y: 0.75 }, colors: BRAND, zIndex: 9999 })
    void confetti({ particleCount: 6, angle: 120, spread: 60, origin: { x: 1, y: 0.75 }, colors: BRAND, zIndex: 9999 })
    if (Date.now() < end) requestAnimationFrame(frame)
  }
  frame()
  window.setTimeout(() => burst({ x: 0.5, y: 0.45 }), 300)
}
