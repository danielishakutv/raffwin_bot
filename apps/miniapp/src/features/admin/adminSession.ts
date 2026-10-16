/**
 * The admin session, in memory only (never localStorage): closing the Mini
 * App ends it. It starts from the one-time ticket on the bot's "Open admin"
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
  me: AdminMe | null
  /** Why the last unlock failed, shown on the admin screen */
  error: string | null
  set: (s: Partial<Omit<AdminSessionState, 'set' | 'clear'>>) => void
  clear: (error?: string | null) => void
}

export const useAdminSession = create<AdminSessionState>((set) => ({
  token: null,
  expiresAt: null,
  me: null,
  error: null,
  set: (s) => set(s),
  clear: (error = null) => set({ token: null, expiresAt: null, me: null, error }),
}))

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
    const login = await parse<AdminLoginResponse>(res)
    useAdminSession.getState().set({ token: login.token, expiresAt: login.expiresAt, me: login.admin, error: null })
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
