/**
 * Data hooks and formatting shared by the admin tabs. Every call goes through
 * adminCall; errors are kept and shown, never swallowed.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Page } from '@raffwin/shared'
import { errorMessage } from '@/api/errors'
import { adminCall } from './adminSession'

/** Runs an admin call, keeping loading and error state. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError(errorMessage(e))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, run, clearError: useCallback(() => setError(null), []) }
}

/** Loads a path; with everyMs it also reloads on a timer while the screen is visible, so figures stay live. */
export function useLoad<T>(path: string | null, everyMs?: number) {
  const [data, setData] = useState<T | null>(null)
  const { busy, error, run } = useAction()
  const reload = useCallback(() => {
    if (path) void run(() => adminCall<T>('GET', path)).then((d) => d !== undefined && setData(d))
  }, [path, run])
  useEffect(reload, [reload])
  useEffect(() => {
    if (!everyMs) return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload()
    }, everyMs)
    return () => window.clearInterval(id)
  }, [everyMs, reload])
  return { data, busy, error, reload }
}

/** Cursor-paged lists (security events, audit log). */
export function usePaged<T>(path: string) {
  const [items, setItems] = useState<T[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const action = useAction()
  const { run } = action
  const load = useCallback(
    (after?: string) =>
      void run(() => adminCall<Page<T>>('GET', `${path}${path.includes('?') ? '&' : '?'}limit=50${after ? `&cursor=${encodeURIComponent(after)}` : ''}`)).then(
        (p) => {
          setLoaded(true)
          if (!p) return
          setItems((cur) => (after ? [...cur, ...p.items] : p.items))
          setCursor(p.nextCursor)
        },
      ),
    [path, run],
  )
  useEffect(() => load(), [load])
  return { items, cursor, loaded, more: () => cursor && load(cursor), error: action.error, busy: action.busy }
}

export const fmt = (n: number) => n.toLocaleString('en-NG')
export const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`
export const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'
export const day = (iso: string) => new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })

/** "in 2 d 4 h", "5 h 10 min ago" */
export function relative(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now
  const abs = Math.abs(ms)
  const d = Math.floor(abs / 86_400_000)
  const h = Math.floor((abs % 86_400_000) / 3_600_000)
  const m = Math.floor((abs % 3_600_000) / 60_000)
  const text = d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${Math.max(1, m)} min`
  return ms >= 0 ? `in ${text}` : `${text} ago`
}

/** Digits only, for number inputs that must accept what people paste ("1,500") */
export const digits = (v: string) => v.replace(/[^0-9]/g, '')
