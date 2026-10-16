/**
 * The admin session, in memory (never localStorage). A super admin's token is
 * also kept in Telegram's secure storage (phone Keychain / Keystore) so
 * closing and reopening the Mini App resumes it; the API then requires fresh
 * initData from the bound account (POST /auth/resume). Other roles, and
 * Telegram apps without secure storage, sign in again after closing. It starts from the one-time ticket on the bot's "Open admin"
 * button (?admin_ticket=...), exchanged together with this Mini App's signed
 * initData, so a ticket copied out of the chat is useless anywhere else.
 */
import { create } from 'zustand'
import type { AdminLoginResponse, AdminMe } from '@raffwin/shared/admin-types'
import { isApiErrorCode, type ApiErrorBody } from '@raffwin/shared'
import { ApiError } from '@/api/errors'
import { env } from '@/services/env'
import { getWebApp } from '@/services/telegram'

interface AdminSessionState {
  token: string | null
  expiresAt: number | null
  idleMinutes: number | null
  me: AdminMe | null
  /** Whether this session survives closing the Mini App, and if not, why */
  kept: string | null
  /** Why the last unlock failed, shown on the admin screen */
  error: string | null
  set: (s: Partial<Omit<AdminSessionState, 'set' | 'clear'>>) => void
  clear: (error?: string | null) => void
}

export const useAdminSession = create<AdminSessionState>((set) => ({
  token: null,
  expiresAt: null,
  idleMinutes: null,
  me: null,
  kept: null,
  error: null,
  set: (s) => set(s),
  clear: (error = null) => {
    void forgetStored()
    set({ token: null, expiresAt: null, idleMinutes: null, me: null, kept: null, error })
  },
}))

const STORE_KEY = 'raffwin_admin_session'
const STORE_TIMEOUT_MS = 3000

function secureStorage() {
  const app = getWebApp()
  return app?.isVersionAtLeast?.('9.0') ? (app.SecureStorage ?? null) : null
}

/** Wraps one callback-style call; a client that never calls back counts as an error, not a hang. */
function call<T>(run: (done: (error: string | null, value?: T) => void) => void): Promise<{ error: string | null; value: T | null }> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve({ error: 'NO_RESPONSE', value: null }), STORE_TIMEOUT_MS)
    try {
      run((error, value) => {
        window.clearTimeout(timer)
        resolve({ error, value: value ?? null })
      })
    } catch (error) {
      window.clearTimeout(timer)
      resolve({ error: error instanceof Error ? error.message : String(error), value: null })
    }
  })
}

/** Returns what to tell the admin about keeping the session after the Mini App closes. */
async function keep(login: AdminLoginResponse): Promise<string> {
  if (login.admin.role !== 'super_admin') return 'Closing the app locks the admin.'
  const store = secureStorage()
  if (!store) return 'This Telegram app has no secure storage, so closing it locks the admin. Update Telegram to stay signed in.'
  const r = await call<boolean>((done) => store.setItem(STORE_KEY, JSON.stringify({ token: login.token, expiresAt: login.expiresAt }), done))
  if (r.error) {
    console.warn('[admin] secure storage refused the session', r.error)
    return `Could not keep the session on this phone (${r.error}), so closing the app locks the admin.`
  }
  return 'Stays unlocked on this phone after closing the app.'
}

async function forgetStored(): Promise<void> {
  const store = secureStorage()
  if (!store) return
  const r = await call<boolean>((done) => store.removeItem(STORE_KEY, done))
  if (r.error) console.warn('[admin] could not remove the stored session', r.error)
}

async function accept(login: AdminLoginResponse): Promise<void> {
  useAdminSession.getState().set({ token: login.token, expiresAt: login.expiresAt, idleMinutes: login.idleMinutes, me: login.admin, error: null, kept: null })
  useAdminSession.getState().set({ kept: await keep(login) })
}

/**
 * Mini App reopened: a stored super admin session resumes if the API accepts
 * it with this launch's initData. Returns true when it did.
 */
export async function resumeStored(): Promise<boolean> {
  const store = secureStorage()
  const initData = getWebApp()?.initData
  if (!store || !initData) return false
  const r = await call<string | null>((done) => store.getItem(STORE_KEY, done))
  if (r.error) {
    console.warn('[admin] could not read the stored session', r.error)
    return false
  }
  if (!r.value) return false
  let stored: { token?: unknown; expiresAt?: unknown }
  try {
    stored = JSON.parse(r.value) as typeof stored
  } catch (error) {
    console.warn('[admin] stored session unreadable; removing it', error)
    await forgetStored()
    return false
  }
  if (typeof stored.token !== 'string' || typeof stored.expiresAt !== 'number' || stored.expiresAt <= Date.now()) {
    await forgetStored()
    return false
  }
  try {
    const res = await fetch(`${env.apiUrl}/admin/v1/auth/resume`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stored.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ initData }),
    })
    await accept(await parse<AdminLoginResponse>(res))
    return true
  } catch (error) {
    if (error instanceof ApiError && error.code === 'AUTH_INVALID') {
      // Ended on the server (idle, expired, locked elsewhere): say so on the admin screen
      useAdminSession.getState().clear(error.message)
    } else {
      // Network trouble: keep the stored token for the next open
      console.warn('[admin] could not resume the stored session', error)
    }
    return false
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T
  const body = (await res.json().catch(() => null)) as unknown
  if (res.ok) return body as T
  const err = (body as Partial<ApiErrorBody> | null)?.error
  if (err && isApiErrorCode(err.code)) throw new ApiError(err.code, err.message, { fields: err.fields, requestId: err.requestId })
  throw new ApiError('SERVER_ERROR', `The admin API had a problem (HTTP ${res.status}).`)
}

/** Takes ?admin_ticket= off the address at once (it must not linger), then exchanges it. */
export async function unlockFromUrl(): Promise<boolean> {
  const url = new URL(window.location.href)
  const ticket = url.searchParams.get('admin_ticket')
  if (!ticket) return false
  url.searchParams.delete('admin_ticket')
  window.history.replaceState(null, '', url.toString())

  const initData = getWebApp()?.initData
  if (!initData) {
    useAdminSession.getState().clear('Open the admin button from the bot inside Telegram.')
    return true
  }
  try {
    const res = await fetch(`${env.apiUrl}/admin/v1/auth/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, initData }),
    })
    await accept(await parse<AdminLoginResponse>(res))
  } catch (error) {
    useAdminSession.getState().clear(error instanceof Error ? error.message : 'Could not unlock the admin.')
  }
  return true
}

/** An authenticated admin request; a 401 ends the session with the reason shown. */
export async function adminCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { token } = useAdminSession.getState()
  if (!token) throw new ApiError('AUTH_INVALID', 'The admin is locked. Sign in from the bot again.')
  let res: Response
  try {
    res = await fetch(`${env.apiUrl}/admin/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (error) {
    console.warn('[admin] network error', path, error)
    throw new ApiError('SERVER_ERROR', 'Could not reach Raffle Win. Check the connection and try again.')
  }
  try {
    return await parse<T>(res)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'AUTH_INVALID') useAdminSession.getState().clear(error.message)
    throw error
  }
}
