import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAppStore } from '@/store/useAppStore'

/** Redirects to sign-up until a profile exists. */
export function RequireProfile({ children }: { children: ReactNode }) {
  const booted = useAppStore((s) => s.booted)
  const profile = useAppStore((s) => s.profile)
  if (!booted) return <Navigate to="/" replace />
  if (!profile) return <Navigate to="/signup" replace />
  return children
}

/** Redirects to sign-up / onboarding until both are done. */
export function RequireOnboarded({ children }: { children: ReactNode }) {
  const booted = useAppStore((s) => s.booted)
  const profile = useAppStore((s) => s.profile)
  const onboardingComplete = useAppStore((s) => s.onboardingComplete)
  if (!booted) return <Navigate to="/" replace />
  if (!profile) return <Navigate to="/signup" replace />
  if (!onboardingComplete) return <Navigate to="/onboarding" replace />
  return children
}
