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
  /** Bot API 6.9+. Asks the user to share their own phone number with the bot. */
  requestContact?(callback: (shared: boolean, result?: RequestContactResult) => void): void
  SecureStorage?: SecureStorage
  /** Bot API 9.0+: per-bot storage on the device, also in desktop apps (same calls as SecureStorage, not encrypted) */
  DeviceStorage?: SecureStorage
  onEvent(event: string, cb: () => void): void
  offEvent(event: string, cb: () => void): void
}

/**
 * Bot API 9.0+: per-bot storage in the phone's Keychain / Keystore. Clients
 * without it (older apps, some desktops) report an error in the callback.
 */
export interface SecureStorage {
  setItem(key: string, value: string, callback?: (error: string | null, stored?: boolean) => void): void
  getItem(key: string, callback: (error: string | null, value?: string | null, canRestore?: boolean) => void): void
  removeItem(key: string, callback?: (error: string | null, removed?: boolean) => void): void
}

interface RequestContactResult {
  status: 'sent' | 'cancelled'
  /** Signed query string (contact, auth_date, hash): what the API verifies */
  response?: string
  /** The same data, parsed but unverified: display only */
  responseUnsafe?: { contact?: { phone_number?: string; user_id?: number } }
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

export type ContactShare =
  | { status: 'shared'; proof: string; phone: string }
  | { status: 'cancelled' }
  /** The Telegram app is too old for requestContact, or we are outside Telegram */
  | { status: 'unsupported' }
  /** Telegram said "sent" but returned no signed response */
  | { status: 'no_proof' }

/** Asks Telegram for the user's own verified number. Never rejects. */
export function requestContact(): Promise<ContactShare> {
  const wa = getWebApp()
  if (!wa?.requestContact || !(wa.isVersionAtLeast?.('6.9') ?? false)) {
    return Promise.resolve({ status: 'unsupported' })
  }
  return new Promise((resolve) => {
    try {
      wa.requestContact?.((shared, result) => {
        if (!shared || result?.status !== 'sent') return resolve({ status: 'cancelled' })
        if (!result.response) return resolve({ status: 'no_proof' })
        resolve({ status: 'shared', proof: result.response, phone: result.responseUnsafe?.contact?.phone_number ?? '' })
      })
    } catch (error) {
      console.warn('[telegram] requestContact failed', error)
      resolve({ status: 'unsupported' })
    }
  })
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
