/**
 * The admin session, in memory (never localStorage). A super admin's token is
 * also kept in Telegram's secure storage (phone Keychain / Keystore) so
 * closing and reopening the Mini App resumes it; the API then requires fresh
 * initData from the bound account (POST /auth/resume). Other roles, and
 * Telegram apps without secure storage, sign in again after closing. It starts from the one-time ticket on the bot's "Open admin"
 * button (?admin_ticket=...), exchanged together with this Mini App's signed
 * initData, so a ticket copied out of the chat is useless anywhere else.
 *
 * In a normal browser (desktop) the admin signs in with the same secrets plus
 * a code from the bot instead (webLoginStart / webLoginVerify below).
 *
 * Trusted devices (19 Oct): a full sign-in trusts the device it happened on
 * and hands back a device secret. Kept here, it lets the next sign-in skip the
 * full checks: in Telegram one tap (signInWithDevice), in a browser the admin
 * password alone (browserDeviceSignIn). Locking the admin does not forget it;
 * the API refusing it does.
 */
import { create } from 'zustand'
import type { AdminLoginResponse, AdminMe, AdminWebLoginChallenge } from '@raffwin/shared/admin-types'
import { isApiErrorCode, type ApiErrorBody } from '@raffwin/shared'
import { ApiError, errorMessage } from '@/api/errors'
import { env } from '@/services/env'
import { getWebApp } from '@/services/telegram'

/** The same three secrets as the bot sign-in (webLoginStartBody) */
type WebLoginStartBody = { master: string; username: string; password: string }

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
    forgetBrowser()
    set({ token: null, expiresAt: null, idleMinutes: null, me: null, kept: null, error })
  },
}))

/* Browser (desktop) sign-in --------------------------------------------------
 * Outside Telegram the admin signs in with the same three secrets plus a
 * 6-digit code the bot sends to their bound Telegram account. The token is
 * kept in sessionStorage (this tab only, gone when it closes) so a refresh
 * keeps the session; never localStorage.
 * -------------------------------------------------------------------------- */

const WEB_KEY = 'raffwin_admin_web_session'

function forgetBrowser(): void {
  try {
    sessionStorage.removeItem(WEB_KEY)
  } catch (error) {
    // Storage blocked: nothing was stored there either
    console.warn('[admin] could not remove the browser session', error)
  }
}

function keepBrowser(login: AdminLoginResponse): string {
  try {
    sessionStorage.setItem(WEB_KEY, JSON.stringify({ token: login.token, expiresAt: login.expiresAt, idleMinutes: login.idleMinutes }))
    return 'A refresh keeps you signed in; closing this tab locks the admin.'
  } catch (error) {
    console.warn('[admin] sessionStorage refused the browser session', error)
    return 'This browser blocks session storage, so a refresh locks the admin.'
  }
}

/** POST /auth/web/start: the three secrets; the bot sends a code to the admin's Telegram. */
export async function webLoginStart(body: WebLoginStartBody): Promise<AdminWebLoginChallenge> {
  return postOpen<AdminWebLoginChallenge>('/auth/web/start', body)
}

/** POST /auth/web/verify: the code from the bot. On success the admin is unlocked in this tab (and this browser trusted, if asked). */
export async function webLoginVerify(challengeId: string, code: string, rememberDevice: boolean): Promise<void> {
  const login = await postOpen<AdminLoginResponse>('/auth/web/verify', { challengeId, code, rememberDevice })
  const trusted = login.deviceToken ? keepBrowserDevice(login.deviceToken, login.admin.name) : null
  acceptBrowser(login, trusted)
}

function acceptBrowser(login: AdminLoginResponse, note: string | null): void {
  useAdminSession.getState().set({
    token: login.token,
    expiresAt: login.expiresAt,
    idleMinutes: login.idleMinutes,
    me: login.admin,
    error: null,
    kept: [keepBrowser(login), note].filter(Boolean).join(' '),
  })
}

/* Trusted browser ------------------------------------------------------------ */

const WEB_DEVICE_KEY = 'raffwin_admin_device_web'

export interface BrowserDevice {
  token: string
  /** The admin's name, to greet them on the short sign-in */
  name: string
}

/** The trusted-device secret this browser holds, if any. */
export function browserDevice(): BrowserDevice | null {
  try {
    const raw = localStorage.getItem(WEB_DEVICE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<BrowserDevice>
    return typeof v.token === 'string' && typeof v.name === 'string' ? { token: v.token, name: v.name } : null
  } catch (error) {
    console.warn('[admin] could not read the trusted browser', error)
    return null
  }
}

export function forgetBrowserDevice(): void {
  try {
    localStorage.removeItem(WEB_DEVICE_KEY)
  } catch (error) {
    console.warn('[admin] could not forget the trusted browser', error)
  }
}

function keepBrowserDevice(token: string, name: string): string {
  try {
    localStorage.setItem(WEB_DEVICE_KEY, JSON.stringify({ token, name }))
    return 'This browser is trusted: next time only your password is asked.'
  } catch (error) {
    console.warn('[admin] localStorage refused the trusted browser', error)
    return 'This browser blocks storage, so it cannot be trusted; the full sign-in stays.'
  }
}

/** POST /auth/device/browser: this trusted browser + the admin password. A refusal that ends the trust forgets it here too. */
export async function browserDeviceSignIn(password: string): Promise<void> {
  const device = browserDevice()
  if (!device) throw new ApiError('AUTH_INVALID', 'This browser is not trusted. Use the full sign-in.')
  try {
    const login = await postOpen<AdminLoginResponse>('/auth/device/browser', { deviceToken: device.token, password })
    acceptBrowser(login, null)
  } catch (error) {
    // "Wrong password, N tries left" keeps the trust; anything else from the API means it is gone
    if (error instanceof ApiError && error.code === 'AUTH_INVALID' && !/tries? left/.test(error.message)) forgetBrowserDevice()
    throw error
  }
}

/** Unauthenticated POST (sign-in steps): errors are thrown for the form, the session is not touched. */
async function postOpen<T>(path: string, body: unknown): Promise<T> {
  if (!env.apiUrl) throw new ApiError('NOT_READY', 'This build runs without the Raffle Win API (demo), so the admin cannot sign in here.')
  let res: Response
  try {
    res = await fetch(`${env.apiUrl}/admin/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch (error) {
    console.warn('[admin] network error', path, error)
    throw new ApiError('SERVER_ERROR', 'Could not reach Raffle Win. Check the connection and try again.')
  }
  return parse<T>(res)
}

/**
 * Browser tab refreshed: a stored session carries on if the API still accepts
 * it (GET /me). Never rejects; returns true when the admin is unlocked.
 */
export async function resumeBrowser(): Promise<boolean> {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(WEB_KEY)
  } catch (error) {
    console.warn('[admin] could not read the browser session', error)
    return false
  }
  if (!raw) return false
  let stored: { token?: unknown; expiresAt?: unknown; idleMinutes?: unknown }
  try {
    stored = JSON.parse(raw) as typeof stored
  } catch (error) {
    console.warn('[admin] browser session unreadable; removing it', error)
    forgetBrowser()
    return false
  }
  if (typeof stored.token !== 'string' || typeof stored.expiresAt !== 'number' || stored.expiresAt <= Date.now()) {
    forgetBrowser()
    return false
  }
  const idleMinutes = typeof stored.idleMinutes === 'number' ? stored.idleMinutes : null
  useAdminSession.getState().set({ token: stored.token, expiresAt: stored.expiresAt, idleMinutes, error: null })
  try {
    const me = await adminCall<AdminMe>('GET', '/me')
    useAdminSession.getState().set({ me, kept: 'A refresh keeps you signed in; closing this tab locks the admin.' })
    return true
  } catch (error) {
    // A 401 already cleared the session with its reason; anything else is shown on the sign-in form
    if (!(error instanceof ApiError && error.code === 'AUTH_INVALID')) {
      console.warn('[admin] could not resume the browser session', error)
      useAdminSession.getState().set({ token: null, me: null, error: errorMessage(error) })
    }
    return false
  }
}

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
  if (login.admin.atRisk) return 'Your account is marked at risk, so closing the app locks the admin.'
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
  const notes = [await keep(login)]
  if (login.deviceToken) notes.push(await keepDevice(login.deviceToken))
  useAdminSession.getState().set({ kept: notes.join(' ') })
}

/* Trusted Telegram device ------------------------------------------------------
 * The secret goes to Telegram's secure storage (Keychain / Keystore) where the
 * app has it, otherwise to its device storage (desktop apps). Either way it
 * only works together with fresh initData from the admin's bound account.
 * -------------------------------------------------------------------------- */

const DEVICE_KEY = 'raffwin_admin_device'

function deviceStores() {
  const app = getWebApp()
  if (!app?.isVersionAtLeast?.('9.0')) return []
  return [app.SecureStorage, app.DeviceStorage].filter((s): s is NonNullable<typeof s> => !!s)
}

async function keepDevice(token: string): Promise<string> {
  for (const store of deviceStores()) {
    const r = await call<boolean>((done) => store.setItem(DEVICE_KEY, token, done))
    if (!r.error) return 'This device is now trusted: next time one tap opens the admin.'
    console.warn('[admin] a Telegram storage refused the trusted device', r.error)
  }
  return 'This Telegram app cannot store a trusted device, so the full sign-in stays. Update Telegram to fix that.'
}

async function readDevice(): Promise<string | null> {
  for (const store of deviceStores()) {
    const r = await call<string | null>((done) => store.getItem(DEVICE_KEY, done))
    if (r.error) {
      console.warn('[admin] could not read the trusted device', r.error)
      continue
    }
    if (r.value) return r.value
  }
  return null
}

async function forgetDevice(): Promise<void> {
  for (const store of deviceStores()) {
    const r = await call<boolean>((done) => store.removeItem(DEVICE_KEY, done))
    if (r.error) console.warn('[admin] could not forget the trusted device', r.error)
  }
}

/** Whether this Telegram app holds a trusted-device secret. */
export async function hasTrustedDevice(): Promise<boolean> {
  return (await readDevice()) !== null
}

/**
 * One tap: the trusted-device secret + this launch's initData. Resolves true
 * when the admin is unlocked, false when this device holds no secret. A refusal
 * throws with the API's reason, and a refused secret is forgotten here.
 */
export async function signInWithDevice(): Promise<boolean> {
  const deviceToken = await readDevice()
  const initData = getWebApp()?.initData
  if (!deviceToken || !initData || !env.apiUrl) return false
  try {
    const res = await fetch(`${env.apiUrl}/admin/v1/auth/device/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken, initData }),
    })
    await accept(await parse<AdminLoginResponse>(res))
    return true
  } catch (error) {
    if (error instanceof ApiError && error.code === 'AUTH_INVALID') await forgetDevice()
    throw error
  }
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
      // A full sign-in trusts this device (Settings > My devices takes that back)
      body: JSON.stringify({ ticket, initData, rememberDevice: true, platform: getWebApp()?.platform }),
    })
    await accept(await parse<AdminLoginResponse>(res))
  } catch (error) {
    useAdminSession.getState().clear(error instanceof Error ? error.message : 'Could not unlock the admin.')
  }
  return true
}

/** An authenticated admin request; a 401 ends the session with the reason shown. */
export async function adminCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  return send<T>(method, path, body !== undefined ? { type: 'application/json', data: JSON.stringify(body) } : undefined)
}

/** Sends a file as the raw request body (raffle photos: POST /media). */
export async function adminUpload<T>(path: string, file: Blob): Promise<T> {
  return send<T>('POST', path, { type: file.type, data: file })
}

/** POST JSON, get a file back (POST /media/fetch returns the image from a link). */
export async function adminFetchBlob(path: string, body: unknown): Promise<Blob> {
  return send<Blob>('POST', path, { type: 'application/json', data: JSON.stringify(body) }, true)
}

async function send<T>(method: string, path: string, body?: { type: string; data: BodyInit }, asBlob = false): Promise<T> {
  const { token } = useAdminSession.getState()
  if (!token) throw new ApiError('AUTH_INVALID', getWebApp()?.initData ? 'The admin is locked. Sign in from the bot again.' : 'The admin is locked. Sign in again.')
  let res: Response
  try {
    res = await fetch(`${env.apiUrl}/admin/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': body.type } : {}) },
      body: body?.data,
    })
  } catch (error) {
    console.warn('[admin] network error', path, error)
    throw new ApiError('SERVER_ERROR', 'Could not reach Raffle Win. Check the connection and try again.')
  }
  try {
    if (asBlob && res.ok) return (await res.blob()) as T
    return await parse<T>(res)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'AUTH_INVALID') useAdminSession.getState().clear(error.message)
    throw error
  }
}
