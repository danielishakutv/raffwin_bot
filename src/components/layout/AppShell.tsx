import { AnimatePresence, motion } from 'framer-motion'
import { useLocation, useOutlet } from 'react-router-dom'
import { TabBar } from './TabBar'
import { cn } from '@/components/ui/cn'
import { pageVariants } from '@/components/motion'

const TAB_ROOTS = ['/home', '/raffles', '/wallet', '/profile']

/** Phone-width column with the tab bar; pages fade/slide between tabs. */
export function AppShell() {
  const { pathname } = useLocation()
  const outlet = useOutlet()
  const root = `/${pathname.split('/')[1] ?? ''}`
  const showTabs = TAB_ROOTS.includes(root)

  return (
    <div className="relative mx-auto min-h-dvh w-full max-w-[520px] md:border-x md:border-white/5">
      <main className={cn('safe-top px-4 pt-4', showTabs ? 'pb-tabbar' : 'pb-8')}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={root} variants={pageVariants} initial="initial" animate="animate" exit="exit">
            {outlet}
          </motion.div>
        </AnimatePresence>
      </main>
      {showTabs && <TabBar />}
    </div>
  )
}
