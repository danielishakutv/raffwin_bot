import { useEffect, useRef } from 'react'
import { toast } from '@/components/ui/toastStore'
import { burst } from '@/services/confetti'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { useAppStore } from '@/store/useAppStore'

/**
 * Says "welcome back" once when this open claimed a come-back offer (the API
 * has already credited it; the balance on screen includes it). Mounted in the
 * app shell, so it fires on whichever screen the player lands.
 */
export function WelcomeBack() {
  const welcomeBack = useAppStore((s) => s.welcomeBack)
  const consume = useAppStore((s) => s.consumeWelcomeBack)
  // Guards against a second effect run for the same credit (React's development double-run)
  const shown = useRef<object | null>(null)

  useEffect(() => {
    if (!welcomeBack || shown.current === welcomeBack) return
    shown.current = welcomeBack
    const n = welcomeBack.raffs
    toast.success(`Welcome back! ${n} free ${n === 1 ? 'Raff' : 'Raffs'} added to your balance.`)
    sound.play('coin')
    haptics.notify('success')
    burst({ x: 0.5, y: 0.25 })
    consume()
  }, [welcomeBack, consume])

  return null
}
