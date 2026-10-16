import { motion } from 'framer-motion'
import { Home, Ticket, User, Wallet } from 'lucide-react'
import { NavLink, useLocation } from 'react-router-dom'
import { cn } from '@/components/ui/cn'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'

const tabs = [
  { to: '/home', label: 'Home', icon: Home },
  { to: '/raffles', label: 'Raffles', icon: Ticket },
  { to: '/wallet', label: 'Wallet', icon: Wallet },
  { to: '/profile', label: 'Profile', icon: User },
]

/** Bottom tabs. The active pill is a shared layout element, so it springs between tabs. */
export function TabBar() {
  const { pathname } = useLocation()
  return (
    <nav className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center" aria-label="Main">
      <div
        className="pointer-events-auto w-full max-w-[520px] rounded-t-[26px] border-t border-white/10 bg-ink-2/90 shadow-float backdrop-blur-xl"
        style={{ paddingBottom: 'var(--safe-bottom)' }}
      >
        <div className="flex" style={{ height: 'var(--tabbar-height)' }}>
          {tabs.map(({ to, label, icon: Icon }) => {
            const active = pathname === to || pathname.startsWith(`${to}/`)
            return (
              <NavLink
                key={to}
                to={to}
                onClick={() => {
                  if (!active) {
                    sound.play('click')
                    haptics.select()
                  }
                }}
                className="tap relative flex flex-1 flex-col items-center justify-center gap-1"
                aria-current={active ? 'page' : undefined}
              >
                {active && (
                  <motion.span
                    layoutId="tab-pill"
                    transition={{ type: 'spring', stiffness: 520, damping: 24, mass: 0.8 }}
                    className="absolute inset-x-3 inset-y-2.5 rounded-2xl bg-brand shadow-glow"
                  />
                )}
                <motion.span
                  animate={active ? { y: -1, scale: 1.08 } : { y: 0, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 20 }}
                  className={cn('relative', active ? 'text-white' : 'text-haze')}
                >
                  <Icon size={22} strokeWidth={active ? 2.4 : 2} />
                </motion.span>
                <span className={cn('relative text-[11px] font-bold', active ? 'text-white' : 'text-haze')}>{label}</span>
              </NavLink>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
