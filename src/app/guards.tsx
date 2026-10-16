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

/** Redirects to sign-up until a profile exists. */
export function RequireProfile({ children }: { children: ReactNode }) {
  const booted = useAppStore((s) => s.booted)
  const bootError = useAppStore((s) => s.bootError)
  const profile = useAppStore((s) => s.profile)
  if (bootError) return <Navigate to="/" replace />
  if (!booted) return <Booting />
  if (!profile) return <Navigate to="/signup" replace />
  return children
}

/** Redirects to sign-up / onboarding until both are done. */
export function RequireOnboarded({ children }: { children: ReactNode }) {
  const booted = useAppStore((s) => s.booted)
  const bootError = useAppStore((s) => s.bootError)
  const profile = useAppStore((s) => s.profile)
  const onboardingComplete = useAppStore((s) => s.onboardingComplete)
  if (bootError) return <Navigate to="/" replace />
  if (!booted) return <Booting />
  if (!profile) return <Navigate to="/signup" replace />
  if (!onboardingComplete) return <Navigate to="/onboarding" replace />
  return children
}
