/**
 * Thin, typed wrapper around the Telegram Mini App bridge (window.Telegram.WebApp).
 * The bridge script is loaded in index.html. Everything here degrades to a
 * no-op outside Telegram so the dev bypass keeps working in a plain browser.
 */

export interface TelegramThemeParams {
  bg_color?: string
  text_color?: string
  hint_color?: string
  link_color?: string
  button_color?: string
  button_text_color?: string
  secondary_bg_color?: string
}

export interface TelegramUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
  photo_url?: string
}

interface HapticFeedback {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void
  notificationOccurred(type: 'error' | 'success' | 'warning'): void
  selectionChanged(): void
}

interface BackButton {
  isVisible: boolean
  show(): void
  hide(): void
  onClick(cb: () => void): void
  offClick(cb: () => void): void
}

export interface TelegramWebApp {
  initData: string
  initDataUnsafe: { user?: TelegramUser; start_param?: string }
  version: string
  platform: string
  colorScheme: 'light' | 'dark'
  themeParams: TelegramThemeParams
  isExpanded: boolean
  viewportHeight: number
  viewportStableHeight: number
  ready(): void
  expand(): void
  close(): void
  setHeaderColor(color: string): void
  setBackgroundColor(color: string): void
  setBottomBarColor?(color: string): void
  enableClosingConfirmation(): void
  disableVerticalSwipes?(): void
  openLink(url: string): void
  openTelegramLink(url: string): void
  HapticFeedback?: HapticFeedback
  BackButton?: BackButton
  isVersionAtLeast?(version: string): boolean
  onEvent(event: string, cb: () => void): void
  offEvent(event: string, cb: () => void): void
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

export function getWebApp(): TelegramWebApp | null {
  return typeof window !== 'undefined' ? (window.Telegram?.WebApp ?? null) : null
}

/** True only when the page was opened by a Telegram client (initData present). */
export function isInsideTelegram(): boolean {
  const wa = getWebApp()
  return !!wa && typeof wa.initData === 'string' && wa.initData.length > 0
}

export function getTelegramUser(): TelegramUser | null {
  return getWebApp()?.initDataUnsafe?.user ?? null
}

const BRAND_BG = '#140c33'

/** Call once on boot. Safe to call outside Telegram. */
export function initTelegram(): void {
  const wa = getWebApp()
  if (!wa) return
  try {
    wa.ready()
    wa.expand()
    const atLeast = (v: string) => wa.isVersionAtLeast?.(v) ?? false
    if (atLeast('6.1')) {
      wa.setHeaderColor(BRAND_BG)
      wa.setBackgroundColor(BRAND_BG)
    }
    if (atLeast('7.10')) wa.setBottomBarColor?.(BRAND_BG)
    // Stops a vertical drag on the card deck from minimising the Mini App.
    if (atLeast('7.7')) wa.disableVerticalSwipes?.()
  } catch (error) {
    console.warn('[telegram] init failed', error)
  }
}

export function openExternal(url: string): void {
  const wa = getWebApp()
  if (wa && url.startsWith('https://t.me/')) wa.openTelegramLink(url)
  else if (wa) wa.openLink(url)
  else window.open(url, '_blank', 'noopener')
}
