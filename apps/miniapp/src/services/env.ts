/**
 * Typed access to build-time environment variables.
 * Everything here is baked into the client bundle at build time, so it must
 * never contain secrets. See .env.example for the full list.
 */
export type AppEnv = 'development' | 'staging' | 'production'

function readAppEnv(): AppEnv {
  const raw = (import.meta.env.VITE_APP_ENV ?? 'development').toLowerCase()
  if (raw === 'production' || raw === 'staging') return raw
  return 'development'
}

const appEnv = readAppEnv()

export const env = {
  appEnv,
  isProduction: appEnv === 'production',
  isStaging: appEnv === 'staging',
  isDevelopment: appEnv === 'development',
  /** Bot that hosts the Mini App, without the @ */
  botUsername: (import.meta.env.VITE_BOT_USERNAME ?? 'raffwin_bot').replace(/^@/, ''),
  /**
   * Dev bypass for the Telegram gate. Hard-disabled for production builds so a
   * stray env var in a deployment can never open the app to plain browsers.
   */
  allowBrowser: import.meta.env.VITE_ALLOW_BROWSER === 'true' && appEnv !== 'production',
  version: import.meta.env.VITE_APP_VERSION ?? '0.0.0',
  basePath: import.meta.env.BASE_URL,
  /**
   * Base URL of the Raffle Win API: /api on the same host in deployed builds.
   * Empty means the in-browser mock API (the GitHub Pages demo).
   */
  apiUrl: (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, ''),
} as const

export const botLink = `https://t.me/${env.botUsername}`
