/**
 * The admin screen, inside the Mini App. Plain black and white on purpose.
 * Reached only through the bot's admin sign-in (adminSession.ts); every
 * request it makes is written to the audit log by the API.
 *
 * Phones get a sticky header with a sideways-scrolling tab strip; wide
 * screens get a sidebar. Tabs live in ./tabs and ./raffles.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { BarChart3, ClipboardCheck, Cog, Gift, Lock, ScrollText, ShieldAlert, UserCog, Users, Wallet } from 'lucide-react'
import { cn } from '@/components/ui/cn'
import { env } from '@/services/env'
import { adminCall, useAdminSession } from './adminSession'
import { RafflesTab } from './raffles/RafflesTab'
import { AdminsTab } from './tabs/AdminsTab'
import { ApprovalsTab } from './tabs/ApprovalsTab'
import { FinanceTab } from './tabs/FinanceTab'
import { AuditTab, SecurityTab } from './tabs/LogTabs'
import { OverviewTab } from './tabs/OverviewTab'
import { PlayersTab } from './tabs/PlayersTab'
import { SettingsTab } from './tabs/SettingsTab'
import { AskDialog, Button, Err } from './ui'

type Tab = 'overview' | 'raffles' | 'finance' | 'approvals' | 'players' | 'settings' | 'security' | 'audit' | 'admins'
const TABS: { id: Tab; label: string; icon: ReactNode; perm?: string }[] = [
  { id: 'overview', label: 'Overview', icon: <BarChart3 size={16} /> },
  { id: 'raffles', label: 'Raffles', icon: <Gift size={16} /> },
  { id: 'finance', label: 'Finance', icon: <Wallet size={16} />, perm: 'finance.read' },
  { id: 'approvals', label: 'Approvals', icon: <ClipboardCheck size={16} /> },
  { id: 'players', label: 'Players', icon: <Users size={16} /> },
  { id: 'settings', label: 'Settings', icon: <Cog size={16} /> },
  { id: 'security', label: 'Security', icon: <ShieldAlert size={16} /> },
  { id: 'audit', label: 'Audit', icon: <ScrollText size={16} /> },
  { id: 'admins', label: 'Admins', icon: <UserCog size={16} />, perm: 'admins.manage' },
]

const TAB_KEY = 'raffwin_admin_tab'
function rememberedTab(): Tab {
  try {
    const t = sessionStorage.getItem(TAB_KEY)
    return TABS.some((x) => x.id === t) ? (t as Tab) : 'overview'
  } catch {
    // Storage blocked in this webview: start on the overview
    return 'overview'
  }
}

export function AdminScreen() {
  const navigate = useNavigate()
  const { token, me, error, expiresAt, idleMinutes, kept } = useAdminSession()
  const [tab, setTabState] = useState<Tab>(rememberedTab)
  const scroller = useRef<HTMLDivElement>(null)
  const scrollTop = useCallback(() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' }), [])
  const setTab = (t: Tab) => {
    setTabState(t)
    try {
      sessionStorage.setItem(TAB_KEY, t)
    } catch (e) {
      console.warn('[admin] could not remember the tab', e)
    }
    scroller.current?.scrollTo({ top: 0 })
  }
  // Keep the chosen tab in view in the phone strip
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [tab])

  if (!token || !me) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center overflow-auto bg-neutral-50 p-4 font-body text-black">
        <div className="admin-in w-full max-w-sm rounded-2xl border border-black/15 bg-white p-6 text-center shadow-[0_20px_50px_-30px_rgba(0,0,0,0.5)]">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-black text-white">
            <Lock size={20} />
          </span>
          <h1 className="mt-4 text-[18px] font-extrabold">Admin is locked</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-neutral-600">
            In the bot chat, send the admin command, then the master password, your username and your password. Use the Open admin button the bot sends back.
          </p>
          <Err message={error} className="text-left" />
          <Button className="mt-5 w-full" onClick={() => navigate('/profile')}>
            Back to the app
          </Button>
        </div>
      </div>
    )
  }

  const tabs = TABS.filter((t) => !t.perm || me.permissions.includes(t.perm))
  const active = tabs.some((t) => t.id === tab) ? tab : 'overview'
  const superAdmin = me.role === 'super_admin'
  const until = expiresAt ? new Date(expiresAt).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }) : '-'
  const idle = idleMinutes ? (idleMinutes >= 60 ? `${idleMinutes / 60} h` : `${idleMinutes} min`) : null

  const lock = () => {
    void adminCall('POST', '/auth/logout')
      .catch((err: unknown) => console.warn('[admin] logout request failed; locking here anyway', err))
      .finally(() => {
        useAdminSession.getState().clear()
        navigate('/profile')
      })
  }

  return (
    <div ref={scroller} className="fixed inset-0 z-40 overflow-y-auto overflow-x-hidden bg-neutral-50 font-body text-black antialiased">
      <AskDialog />
      <header className="sticky top-0 z-20 border-b border-black/15 bg-white/95 backdrop-blur">
        <p
          className={cn(
            'px-4 py-1 text-center text-[11.5px] font-bold tracking-wide',
            env.isProduction ? 'bg-black text-white' : 'bg-[repeating-linear-gradient(135deg,#fff_0_8px,#f1f1f1_8px_16px)] text-black',
          )}
        >
          {env.isProduction ? `LIVE · @${env.botUsername} · real players and raffles` : `TEST · @${env.botUsername} · sample data, nothing here reaches the live app`}
        </p>
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-2 text-[15px] font-extrabold leading-tight">
              Raffle Win admin
              <span className="rounded-full border border-black/20 px-2 py-px text-[11px] font-semibold text-neutral-700">
                {me.name} · {me.role.replace('_', ' ')}
              </span>
            </p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-neutral-500">
              Signed in until {until}
              {idle ? `, locks after ${idle} unused` : ''}. {kept ?? ''}
            </p>
          </div>
          <Button size="sm" icon={<Lock size={14} />} onClick={lock}>
            Lock
          </Button>
        </div>
        {/* Phone and tablet: a sideways tab strip */}
        <nav ref={strip} className="overflow-x-auto px-3 pb-2 [scrollbar-width:none] lg:hidden [&::-webkit-scrollbar]:hidden" aria-label="Admin sections">
          <div className="flex w-max gap-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={active === t.id ? 'page' : undefined}
                onClick={() => setTab(t.id)}
                className={cn(
                  'inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-semibold transition-colors duration-200',
                  active === t.id ? 'bg-black text-white' : 'text-neutral-600 hover:bg-neutral-100 hover:text-black',
                )}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
        </nav>
      </header>

      <div className="mx-auto flex max-w-[1400px] gap-6 px-4 lg:px-6">
        {/* Wide screens: sidebar */}
        <nav className="sticky top-[92px] hidden h-max w-52 shrink-0 py-6 lg:block" aria-label="Admin sections">
          <ul className="grid gap-0.5">
            {tabs.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  aria-current={active === t.id ? 'page' : undefined}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13.5px] font-semibold transition-colors duration-200',
                    active === t.id ? 'bg-black text-white' : 'text-neutral-600 hover:bg-white hover:text-black',
                  )}
                >
                  {t.icon}
                  {t.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main key={active} className="admin-in min-w-0 flex-1 py-4 pb-20 text-[14px] lg:py-6">
          {active === 'overview' && <OverviewTab />}
          {active === 'raffles' && <RafflesTab can={me.permissions} superAdmin={superAdmin} onScrollTop={scrollTop} />}
          {active === 'finance' && <FinanceTab can={me.permissions} />}
          {active === 'approvals' && <ApprovalsTab can={me.permissions} />}
          {active === 'players' && <PlayersTab can={me.permissions} superAdmin={superAdmin} />}
          {active === 'settings' && <SettingsTab can={me.permissions} superAdmin={superAdmin} />}
          {active === 'security' && <SecurityTab />}
          {active === 'audit' && <AuditTab />}
          {active === 'admins' && <AdminsTab />}
        </main>
      </div>
    </div>
  )
}

