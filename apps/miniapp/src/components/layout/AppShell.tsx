import { AnimatePresence, motion } from 'framer-motion'
import { useEffect } from 'react'
import { useLocation, useOutlet } from 'react-router-dom'
import { TabBar } from './TabBar'
import { cn } from '@/components/ui/cn'
import { pageVariants } from '@/components/motion'
import { LiveDrawShow } from '@/features/raffles/LiveDrawShow'
import { WelcomeBack } from '@/features/welcome/WelcomeBack'
import { useAppStore } from '@/store/useAppStore'

const TAB_ROOTS = ['/home', '/raffles', '/wallet', '/profile']

/** Phone-width column with the tab bar; pages fade/slide between tabs. */
export function AppShell() {
  const { pathname } = useLocation()
  const outlet = useOutlet()
  const root = `/${pathname.split('/')[1] ?? ''}`
  const showTabs = TAB_ROOTS.includes(root)
  const liveError = useAppStore((s) => s.liveError)

  // Hash navigation keeps the scroll position; every screen should start at the top.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [pathname])

  return (
    <div className="relative mx-auto min-h-dvh w-full max-w-[520px] overflow-x-clip md:border-x md:border-white/5">
      {liveError && (
        <p role="status" className="sticky top-0 z-30 bg-sun/90 px-4 py-1.5 text-center text-[12px] font-semibold text-ink">
          Live updates paused: {liveError} Retrying.
        </p>
      )}
      <main className={cn('safe-top px-4 pt-4', showTabs ? 'pb-tabbar' : 'pb-8')}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={root} variants={pageVariants} initial="initial" animate="animate" exit="exit">
            {outlet}
          </motion.div>
        </AnimatePresence>
      </main>
      {showTabs && <TabBar />}
      {/* "Welcome back! 1 free Raff added", once, after a come-back offer is claimed */}
      <WelcomeBack />
      {/* A raffle drawn while the app is open (or recently) plays its live draw over any screen */}
      <LiveDrawShow />
    </div>
  )
}
