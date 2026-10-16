import { useEffect } from 'react'
import { getWebApp } from '@/services/telegram'

/**
 * Shows Telegram's native back button while `visible` is true and routes its
 * click to `onBack`. No-op outside Telegram.
 */
export function useBackButton(visible: boolean, onBack: () => void): void {
  useEffect(() => {
    const button = getWebApp()?.BackButton
    if (!button || !visible) return
    button.show()
    button.onClick(onBack)
    return () => {
      button.offClick(onBack)
      button.hide()
    }
  }, [visible, onBack])
}
