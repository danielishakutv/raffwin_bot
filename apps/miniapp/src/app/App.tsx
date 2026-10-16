import { useEffect, useState } from 'react'
import { HashRouter, useNavigate } from 'react-router-dom'
import { resumeStored, unlockFromUrl } from '@/features/admin/adminSession'
import { AppRoutes } from './router'
import { TelegramGate } from './TelegramGate'
import { Orbs } from '@/components/ui/Orbs'
import { StagingBadge } from '@/components/ui/StagingBadge'
import { Toaster } from '@/components/ui/Toast'
import { useRateLifecycle } from '@/hooks/useRateLifecycle'
import { useLiveSync } from '@/hooks/useLiveSync'
import { env } from '@/services/env'
import { installAudioUnlock } from '@/services/sound'
import { initTelegram, isInsideTelegram } from '@/services/telegram'
import { useAppStore } from '@/store/useAppStore'

/**
 * Opened from the bot's "Open admin" button: exchange the one-time ticket, then
 * go to the admin screen. Otherwise resume a stored super admin session, if any.
 */
function AdminTicket() {
  const navigate = useNavigate()
  useEffect(() => {
    void unlockFromUrl().then((hadTicket) => {
      if (hadTicket) navigate('/admin', { replace: true })
      else void resumeStored()
    })
  }, [navigate])
  return null
}

/** Mounted inside the gate so the rate loop only runs for real sessions. */
function RateLifecycle() {
  useRateLifecycle()
  // Counts, balance and raffle states stay current without a refresh
  useLiveSync()
  return null
}

/**
 * Root. Decides between the Telegram gate and the app, boots the store and
 * wires the one-time platform hooks (Telegram ready/expand, audio unlock).
 *
 * Routing is hash-based (#/home) because the app is served from GitHub Pages,
 * which cannot rewrite deep links to index.html.
 */
export function App() {
  const [gated] = useState(() => !isInsideTelegram() && !env.allowBrowser)
  const boot = useAppStore((s) => s.boot)

  useEffect(() => {
    initTelegram()
    return installAudioUnlock()
  }, [])

  useEffect(() => {
    if (!gated) void boot()
  }, [gated, boot])

  if (gated) return <TelegramGate />

  return (
    <HashRouter>
      <Orbs />
      <StagingBadge />
      <Toaster />
      <RateLifecycle />
      <AdminTicket />
      <AppRoutes />
    </HashRouter>
  )
}
