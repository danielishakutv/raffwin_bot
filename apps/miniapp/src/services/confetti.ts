import confetti from 'canvas-confetti'
import { liteMotion } from './perf'

const BRAND = ['#6b2cf5', '#f2358d', '#2f6bff', '#ffd43b', '#35f0b4', '#ffffff']

function reduced(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

let shooter: confetti.CreateTypes | null = null

/**
 * One full-screen canvas drawn by a Web Worker where the browser allows it,
 * so the particles never compete with the app (or the draw show) for the main
 * thread. canvas-confetti falls back to the main thread by itself elsewhere.
 */
function fire(options: confetti.Options): void {
  if (!shooter) {
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '9999' })
    document.body.appendChild(canvas)
    shooter = confetti.create(canvas, { resize: true, useWorker: true })
  }
  shooter(options)?.catch((error: unknown) => console.warn('[confetti] could not play', error))
}

/** A quick burst from a point (defaults to lower-middle of the screen). */
export function burst(origin: { x: number; y: number } = { x: 0.5, y: 0.7 }): void {
  if (reduced()) return
  fire({
    particleCount: liteMotion ? 45 : 90,
    spread: 70,
    startVelocity: 38,
    gravity: 1.1,
    ticks: liteMotion ? 140 : 180,
    scalar: 1,
    origin,
    colors: BRAND,
  })
}

/** Bigger two-sided celebration for wins and successful purchases. */
export function celebrate(): void {
  if (reduced()) return
  const end = Date.now() + 1200
  const sides = (count: number) => {
    fire({ particleCount: count, angle: 60, spread: 60, origin: { x: 0, y: 0.75 }, colors: BRAND })
    fire({ particleCount: count, angle: 120, spread: 60, origin: { x: 1, y: 0.75 }, colors: BRAND })
  }
  if (liteMotion) {
    // A dozen small volleys instead of one every frame
    const id = window.setInterval(() => {
      sides(5)
      if (Date.now() >= end) window.clearInterval(id)
    }, 100)
    sides(5)
  } else {
    const frame = () => {
      sides(6)
      if (Date.now() < end) requestAnimationFrame(frame)
    }
    frame()
  }
  window.setTimeout(() => burst({ x: 0.5, y: 0.45 }), 300)
}
