import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { Spinner } from '@/components/ui/Spinner'
import { useAppStore } from '@/store/useAppStore'

/** Shown while the store boots on a deep link (e.g. /raffles/:id from a bot start_param). */
function Booting() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner className="h-8 w-8 text-grape-2" />
    </div>
  )
}

/** Waits for the account (created on first open; there is no sign-up). */
export function RequireProfile({ children }: { children: ReactNode }) {
  const booted = useAppStore((s) => s.booted)
  const bootError = useAppStore((s) => s.bootError)
  const profile = useAppStore((s) => s.profile)
  if (bootError) return <Navigate to="/" replace />
  if (!booted) return <Booting />
  if (!profile) return <Navigate to="/" replace />
  return children
}

/** Sends a first-time player through onboarding (welcome, how it works, rules) first. */
export function RequireOnboarded({ children }: { children: ReactNode }) {
  const booted = useAppStore((s) => s.booted)
  const bootError = useAppStore((s) => s.bootError)
  const profile = useAppStore((s) => s.profile)
  const onboardingComplete = useAppStore((s) => s.onboardingComplete)
  if (bootError) return <Navigate to="/" replace />
  if (!booted) return <Booting />
  if (!profile) return <Navigate to="/" replace />
  if (!onboardingComplete) return <Navigate to="/onboarding" replace />
  return children
}
