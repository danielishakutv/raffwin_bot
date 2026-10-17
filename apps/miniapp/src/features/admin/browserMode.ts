/**
 * Desktop admin: outside Telegram, the #/admin route opens the admin with its
 * own sign-in (master password, username, password, then a code from the bot)
 * instead of the Telegram gate. Every other route outside Telegram keeps the gate.
 *
 * Kept tiny on purpose: App.tsx imports it eagerly, the admin itself loads lazily.
 */
import { useSyncExternalStore } from 'react'
import { isInsideTelegram } from '@/services/telegram'

const isAdminHash = (hash: string) => hash === '#/admin' || hash.startsWith('#/admin/') || hash.startsWith('#/admin?')

/** True when this page is a plain browser tab on the admin route. */
export function isBrowserAdminRoute(): boolean {
  return !isInsideTelegram() && isAdminHash(window.location.hash)
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** Follows the address bar, so typing #/admin (or leaving it) switches modes without a reload. */
export function useBrowserAdminRoute(): boolean {
  return useSyncExternalStore(subscribe, isBrowserAdminRoute, () => false)
}

/** Where a computer opens the admin, shown on the Telegram locked screen. */
export function desktopAdminUrl(): string {
  return `${window.location.origin}${window.location.pathname}#/admin`
}
