import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { RequireOnboarded, RequireProfile } from './guards'
import { SplashPage } from '@/features/splash/SplashPage'
import { KycPage } from '@/features/kyc/KycPage'
import { AdminScreen } from '@/features/admin/AdminScreen'
import { OnboardingPage } from '@/features/onboarding/OnboardingPage'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { RafflesPage } from '@/features/raffles/RafflesPage'
import { WalletPage } from '@/features/wallet/WalletPage'
import { ProfilePage } from '@/features/profile/ProfilePage'
import { HistoryPage } from '@/features/profile/HistoryPage'
import { EntriesPage } from '@/features/profile/EntriesPage'
import { WinsPage } from '@/features/profile/WinsPage'
import { ReferralsPage } from '@/features/referrals/ReferralsPage'

/**
 * Routes (hash-based, see App.tsx):
 *  /                  splash + routing by account state
 *  /signup            create account
 *  /onboarding        welcome, how it works, rules (agree gate)
 *  /home              dashboard
 *  /raffles           swipe deck
 *  /raffles/:id       deck with the detail sheet open
 *  /wallet            buy Raffs (demo payment)
 *  /profile           profile, address, verification, contact, settings
 *  /profile/history   transaction history
 *  /profile/entries   my entries
 *  /profile/wins      my wins
 *  /referrals         invite link, referred people, 10% earnings
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<SplashPage />} />
      {/* There is no sign-up: opening the bot is the account. Old links land on the splash. */}
      <Route path="/signup" element={<Navigate to="/" replace />} />
      <Route path="/admin/*" element={<AdminScreen />} />
      <Route
        path="/onboarding"
        element={
          <RequireProfile>
            <OnboardingPage />
          </RequireProfile>
        }
      />
      <Route
        element={
          <RequireOnboarded>
            <AppShell />
          </RequireOnboarded>
        }
      >
        <Route path="/home" element={<DashboardPage />} />
        <Route path="/raffles" element={<RafflesPage />} />
        <Route path="/raffles/:id" element={<RafflesPage />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/profile/history" element={<HistoryPage />} />
        <Route path="/profile/entries" element={<EntriesPage />} />
        <Route path="/profile/wins" element={<WinsPage />} />
        <Route path="/referrals" element={<ReferralsPage />} />
        <Route path="/kyc" element={<KycPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
