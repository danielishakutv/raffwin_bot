import { useEffect, useRef } from 'react'

declare global {
  interface Window {
    onTelegramAuth?: (user: Record<string, unknown>) => void
  }
}

/**
 * Telegram's own login button (https://core.telegram.org/widgets/login). It
 * opens Telegram's confirmation and hands back the signed user data, which
 * the backend checks. It only works on the domain set for the bot in BotFather.
 */
export function TelegramLogin({ bot, onAuth }: { bot: string; onAuth: (user: Record<string, unknown>) => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    window.onTelegramAuth = onAuth
    const el = box.current
    if (!el) return
    const script = document.createElement('script')
    script.src = 'https://telegram.org/js/telegram-widget.js?22'
    script.async = true
    script.setAttribute('data-telegram-login', bot)
    script.setAttribute('data-size', 'large')
    script.setAttribute('data-radius', '12')
    script.setAttribute('data-onauth', 'onTelegramAuth(user)')
    el.replaceChildren(script)
    return () => {
      el.replaceChildren()
      delete window.onTelegramAuth
    }
  }, [bot, onAuth])
  return <div ref={box} className="flex min-h-[44px] justify-center" />
}
