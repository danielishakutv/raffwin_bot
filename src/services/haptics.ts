import { getWebApp } from './telegram'

/**
 * Haptic feedback. Uses Telegram's HapticFeedback when available and falls
 * back to the Vibration API in a plain browser (where supported).
 */
function vibrate(pattern: number | number[]) {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(pattern)
  } catch {
    /* vibration unsupported - nothing to do */
  }
}

export const haptics = {
  impact(style: 'light' | 'medium' | 'heavy' = 'light') {
    const h = getWebApp()?.HapticFeedback
    if (h) h.impactOccurred(style)
    else vibrate(style === 'heavy' ? 24 : style === 'medium' ? 14 : 8)
  },
  notify(type: 'success' | 'error' | 'warning') {
    const h = getWebApp()?.HapticFeedback
    if (h) h.notificationOccurred(type)
    else vibrate(type === 'success' ? [12, 40, 18] : type === 'error' ? [30, 40, 30] : 20)
  },
  select() {
    const h = getWebApp()?.HapticFeedback
    if (h) h.selectionChanged()
    else vibrate(5)
  },
}
