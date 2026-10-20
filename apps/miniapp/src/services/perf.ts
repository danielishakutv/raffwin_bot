/**
 * Lite motion: phones and modest devices get the same screens with the
 * costliest effects left out (backdrop blurs, giant rotating layers, heavy
 * confetti, drifting background orbs). Decided once at start-up; a laptop with
 * a mouse keeps every effect.
 */
function detect(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }
  const touch = window.matchMedia('(pointer: coarse)').matches
  const fewCores = (nav.hardwareConcurrency ?? 8) <= 4
  const littleMemory = (nav.deviceMemory ?? 8) <= 4
  return touch || fewCores || littleMemory || nav.connection?.saveData === true
}

export const liteMotion = detect()

/** Lets CSS follow the same decision: html[data-lite] */
export function markLiteMotion(): void {
  if (liteMotion) document.documentElement.dataset.lite = ''
}
