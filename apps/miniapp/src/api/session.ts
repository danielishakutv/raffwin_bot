/**
 * Talks to the Raffle Win API with a session: the access token lives in
 * memory, the refresh token in localStorage so a reload inside Telegram does
 * not need fresh initData.
 *
 * On AUTH_EXPIRED the request is retried once after a refresh; if the refresh
 * fails the session is rebuilt from Telegram's initData. Refreshes are
 * single-flight: two parallel refreshes would look like token theft to the
 * server and revoke the session.
 */
import { isApiErrorCode, type ApiErrorBody } from '@raffwin/shared'
import { env } from '@/services/env'
import { getWebApp } from '@/services/telegram'
import { ApiError } from './errors'

interface Tokens {
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken: string
  refreshTokenExpiresAt: number
}

const STORE_KEY = 'raffwin.session.v1'
let access: { token: string; expiresAt: number } | null = null
let renewing: Promise<void> | null = null

function readRefresh(): { token: string; expiresAt: number } | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown }
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'number') return null
    return parsed.expiresAt > Date.now() ? { token: parsed.token, expiresAt: parsed.expiresAt } : null
  } catch (error) {
    console.warn('[session] stored session unreadable, starting a new one', error)
    return null
  }
}

function store(tokens: Tokens): void {
  access = { token: tokens.accessToken, expiresAt: tokens.accessTokenExpiresAt }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ token: tokens.refreshToken, expiresAt: tokens.refreshTokenExpiresAt }))
  } catch (error) {
    // Storage blocked: the session still works until the app is closed
    console.warn('[session] could not persist the refresh token', error)
  }
}

export function clearSession(): void {
  access = null
  try {
    localStorage.removeItem(STORE_KEY)
  } catch (error) {
    console.warn('[session] could not clear the stored session', error)
  }
}

async function send(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.token) headers.set('authorization', `Bearer ${init.token}`)
  try {
    return await fetch(`${env.apiUrl}${path}`, { ...init, headers })
  } catch (error) {
    console.warn('[api] network error', path, error)
    throw new ApiError('SERVER_ERROR', 'Could not reach Raffle Win. Check your connection and try again.')
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new ApiError('SERVER_ERROR', `Raffle Win sent an unreadable reply (HTTP ${res.status}).`)
  }
  if (res.ok) return body as T
  const err = (body as Partial<ApiErrorBody> | null)?.error
  if (err && isApiErrorCode(err.code)) {
    throw new ApiError(err.code, err.message, { fields: err.fields, requestId: err.requestId })
  }
  throw new ApiError('SERVER_ERROR', `Raffle Win had a problem (HTTP ${res.status}). Please try again.`)
}

async function loginWithInitData(): Promise<void> {
  const initData = getWebApp()?.initData
  if (!initData) {
    throw new ApiError('AUTH_INVALID', 'Open Raffle Win from the Telegram bot to sign in.')
  }
  store(await parse<Tokens>(await send('/v1/auth/telegram', { method: 'POST', body: JSON.stringify({ initData }) })))
}

async function refreshOrLogin(): Promise<void> {
  const refresh = readRefresh()
  if (refresh) {
    try {
      const res = await send('/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: refresh.token }) })
      store(await parse<Tokens>(res))
      return
    } catch (error) {
      if (!(error instanceof ApiError) || !['AUTH_INVALID', 'AUTH_EXPIRED'].includes(error.code)) throw error
      console.info('[session] refresh refused, signing in again with Telegram', error.code)
      clearSession()
    }
  }
  await loginWithInitData()
}

/** Makes sure a usable access token exists, renewing at most once at a time. */
async function ensureAccess(force = false): Promise<string> {
  if (!force && access && access.expiresAt - Date.now() > 15_000) return access.token
  if (!renewing) {
    renewing = refreshOrLogin().finally(() => {
      renewing = null
    })
  }
  await renewing
  if (!access) throw new ApiError('AUTH_INVALID', 'Could not sign in. Close Raffle Win and open it again.')
  return access.token
}

/** An authenticated JSON request. */
export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init = { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }
  const token = await ensureAccess()
  try {
    return await parse<T>(await send(path, { ...init, token }))
  } catch (error) {
    // Expired, or revoked server-side: renew once (refresh, else initData) and retry once
    if (!(error instanceof ApiError) || (error.code !== 'AUTH_EXPIRED' && error.code !== 'AUTH_INVALID')) throw error
    return parse<T>(await send(path, { ...init, token: await ensureAccess(true) }))
  }
}
