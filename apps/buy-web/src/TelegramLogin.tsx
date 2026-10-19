import { useEffect, useRef, useState } from 'react'

/**
 * "Log in with Telegram", without Telegram's widget script. That script turns
 * its data-onauth attribute into a function with eval(), which this site's
 * Content-Security-Policy forbids, so the button never appeared. This does
 * what the widget does underneath (https://core.telegram.org/widgets/login):
 *
 *   1. open https://oauth.telegram.org/auth?bot_id=... in a popup
 *   2. Telegram posts {event: 'auth_result', result: user | false} back from that popup
 *   3. if the popup was closed without a message, ask oauth.telegram.org/auth/get
 *   4. on phones that open a full tab instead, Telegram comes back to this page
 *      with #tgAuthResult=<base64 JSON> (readReturnedLogin)
 *
 * The user object is signed by Telegram; the backend checks the hash before
 * anything else. Nothing here is trusted on its own.
 */
const ORIGIN = 'https://oauth.telegram.org'

type TgUser = Record<string, unknown>

/** After a full-page login Telegram returns here with #tgAuthResult=...; read it once and clean the address */
export function readReturnedLogin(): TgUser | null {
  const m = location.hash.match(/[#&]tgAuthResult=([A-Za-z0-9_=-]*)/)
  if (!m) return null
  history.replaceState(null, '', location.pathname + location.search)
  try {
    const json = atob((m[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))
    const user = JSON.parse(decodeURIComponent(escape(json))) as unknown
    return user && typeof user === 'object' ? (user as TgUser) : null
  } catch {
    return null
  }
}

async function askTelegram(botId: number): Promise<TgUser | null> {
  try {
    const res = await fetch(`${ORIGIN}/auth/get`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
      body: `bot_id=${encodeURIComponent(botId)}`,
    })
    const data = (await res.json()) as { user?: TgUser }
    return data.user ?? null
  } catch {
    return null
  }
}

export function TelegramLogin({ botId, onAuth }: { botId: number; onAuth: (user: TgUser) => void }) {
  const [state, setState] = useState<'idle' | 'waiting' | 'cancelled'>('idle')
  const cleanup = useRef<() => void>(() => {})
  useEffect(() => () => cleanup.current(), [])

  const start = () => {
    cleanup.current()
    const w = 550
    const h = 470
    const left = Math.max(0, (screen.width - w) / 2)
    const top = Math.max(0, (screen.height - h) / 2)
    const url = `${ORIGIN}/auth?bot_id=${encodeURIComponent(botId)}&origin=${encodeURIComponent(location.origin)}&request_access=write&return_to=${encodeURIComponent(location.href)}`
    const popup = window.open(url, `telegram_oauth_bot${botId}`, `width=${w},height=${h},left=${left},top=${top},status=0,location=0,menubar=0,toolbar=0`)
    if (!popup) {
      // Blocked or a phone: go there in this tab; Telegram brings the result back in the address
      location.assign(url)
      return
    }
    setState('waiting')
    let done = false
    const finish = (user: TgUser | null) => {
      if (done) return
      done = true
      cleanup.current()
      if (user) {
        setState('idle')
        onAuth(user)
      } else setState('cancelled')
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== ORIGIN || e.source !== popup) return
      let data: { event?: string; result?: TgUser | false } = {}
      try {
        data = typeof e.data === 'string' ? (JSON.parse(e.data) as typeof data) : (e.data as typeof data)
      } catch {
        return
      }
      if (data.event === 'auth_result') finish(data.result || null)
    }
    window.addEventListener('message', onMessage)
    const timer = window.setInterval(() => {
      if (popup.closed) void askTelegram(botId).then(finish)
    }, 300)
    cleanup.current = () => {
      window.removeEventListener('message', onMessage)
      window.clearInterval(timer)
    }
    popup.focus()
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={start}
        className="inline-flex h-12 w-full max-w-xs items-center justify-center gap-2.5 rounded-xl bg-[#2AABEE] px-5 text-[15px] font-bold text-white transition hover:bg-[#229ED9]"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 fill-current">
          <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
        </svg>
        {state === 'waiting' ? 'Waiting for Telegram' : 'Log in with Telegram'}
      </button>
      {state === 'waiting' && <p className="text-center text-[12.5px] text-ink/60">Confirm in the Telegram window that opened. Telegram may also send you a message to approve.</p>}
      {state === 'cancelled' && <p className="text-center text-[12.5px] text-ink/60">The login was not finished. Try again.</p>}
    </div>
  )
}
