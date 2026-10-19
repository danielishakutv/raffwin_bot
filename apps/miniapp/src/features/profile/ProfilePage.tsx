import { motion } from 'framer-motion'
import { Bell, BellRing, ChevronRight, History, MapPin, Settings2, ShieldCheck, Ticket, Trophy, UserPlus, UserRound, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { startAdminSignIn, usingRealApi } from '@/api'
import { errorMessage } from '@/api/errors'
import { getWebApp } from '@/services/telegram'
import { staggerContainer, popIn } from '@/components/motion'
import { Avatar } from '@/components/ui/Avatar'
import { Toggle } from '@/components/ui/Field'
import { formatPhoneDisplay } from '@/services/format'
import { sound } from '@/services/sound'
import { useAppStore, useMyWins } from '@/store/useAppStore'
import { PhoneSheet } from '@/features/phone/PhoneShare'
import { SectionCard } from './SectionCard'
import { BotMessagesSection, ContactSection, DemoControls, PersonalInfoSection } from './sections'
import { cn } from '@/components/ui/cn'
import { hasTrustedDevice, signInWithDevice, useAdminSession } from '@/features/admin/adminSession'

/** Profile hub: identity, address, verification, contact, history links, settings. */
export function ProfilePage() {
  const navigate = useNavigate()
  const profile = useAppStore((s) => s.profile)
  const entries = useAppStore((s) => s.entries)
  const transactions = useAppStore((s) => s.transactions)
  const wins = useMyWins()
  const settings = useAppStore((s) => s.settings)
  const setMuted = useAppStore((s) => s.setMuted)
  const setMusic = useAppStore((s) => s.setMusic)
  const [open, setOpen] = useState<string | null>(null)
  const [phoneOpen, setPhoneOpen] = useState(false)

  // Signing out clears the profile: leave the app area.
  useEffect(() => {
    if (!profile) navigate('/', { replace: true })
  }, [profile, navigate])

  if (!profile) return null
  const toggle = (id: string) => setOpen((cur) => (cur === id ? null : id))

  const links = [
    { to: '/profile/history', icon: History, label: 'Transaction history', count: transactions.length },
    { to: '/profile/entries', icon: Ticket, label: 'My entries', count: entries.reduce((s, e) => s + e.qty, 0) },
    { to: '/profile/wins', icon: Trophy, label: 'My wins', count: wins.length },
    { to: '/referrals', icon: UserPlus, label: 'Invite friends, earn 10%', count: null },
  ]

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex flex-col gap-4">
      <motion.header variants={popIn} className="surface flex items-center gap-4 rounded-card p-4">
        <Avatar name={profile.fullName} seed={profile.username} image={profile.verification.selfieImage} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[20px] font-bold">{profile.fullName}</h1>
          <p className="truncate text-[13px] text-mist">@{profile.username}</p>
          <p className={cn('mt-1.5 inline-flex items-center gap-1 text-[12px] font-bold', profile.kycComplete ? 'text-mint' : 'text-sun')}>
            <ShieldCheck size={14} /> {profile.kycComplete ? 'Ready to receive prizes' : 'Delivery details needed for prizes'}
          </p>
        </div>
      </motion.header>

      {profile.isAdmin && <AdminEntry />}

      <motion.div variants={popIn} className="flex flex-col gap-3">
        <SectionCard id="personal" icon={<UserRound size={20} />} title="Personal info" summary={`@${profile.username}${profile.phone ? ` · ${formatPhoneDisplay(profile.phone)}` : ''}`} open={open === 'personal'} onToggle={toggle}>
          <PersonalInfoSection key={profile.username + profile.fullName} profile={profile} onPhone={() => setPhoneOpen(true)} />
        </SectionCard>
        <Link
          to="/kyc"
          onClick={() => sound.play('click')}
          className="tap surface flex items-center gap-3 rounded-card p-4"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/8 text-mist">
            <MapPin size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-bold">Prize delivery (KYC)</span>
            <span className="block truncate text-[13px] text-mist">
              {profile.delivery ? `${profile.delivery.motorPark}, ${profile.delivery.city}` : 'Your name, phone and nearest motor park'}
            </span>
          </span>
          <ChevronRight size={18} className="text-haze" />
        </Link>
        <SectionCard id="contact" icon={<Bell size={20} />} title="Contact info" summary="Where we reach you about draws and deliveries" open={open === 'contact'} onToggle={toggle}>
          <ContactSection profile={profile} />
        </SectionCard>
      </motion.div>

      <motion.nav variants={popIn} className="surface flex flex-col divide-y divide-white/8 rounded-card">
        {links.map((l) => (
          <Link key={l.to} to={l.to} onClick={() => sound.play('click')} className="tap flex items-center gap-3 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/8 text-mist">
              <l.icon size={20} />
            </span>
            <span className="flex-1 text-[15px] font-bold">{l.label}</span>
            <span className="nums text-[13px] font-bold text-mist">{l.count}</span>
            <ChevronRight size={18} className="text-haze" />
          </Link>
        ))}
      </motion.nav>

      <motion.section variants={popIn} className="surface rounded-card p-4">
        <h2 className="flex items-center gap-2 text-[15px] font-bold">
          <BellRing size={18} className="text-mist" /> Bot messages
        </h2>
        <div className="mt-2">
          <BotMessagesSection profile={profile} />
        </div>
      </motion.section>

      <motion.section variants={popIn} className="surface rounded-card p-4">
        <h2 className="flex items-center gap-2 text-[15px] font-bold">
          <Settings2 size={18} className="text-mist" /> Sound
        </h2>
        <div className="mt-2 flex flex-col divide-y divide-white/8">
          <Toggle checked={!settings.muted} onChange={(on) => setMuted(!on)} label="Sound effects" description="Taps, entries, wins" />
          <Toggle checked={settings.music} onChange={setMusic} label="Background tune" description="Soft loop at low volume" disabled={settings.muted} />
        </div>
      </motion.section>

      {!usingRealApi && (
        <motion.div variants={popIn}>
          <SectionCard id="demo" icon={<Wrench size={20} />} title="Demo controls" summary="Testing switches. Not part of the real product." open={open === 'demo'} onToggle={toggle}>
            <DemoControls />
          </SectionCard>
        </motion.div>
      )}

      {/* Outside the section cards, so the sheet is positioned against the screen */}
      <PhoneSheet open={phoneOpen} onClose={() => setPhoneOpen(false)} />
    </motion.div>
  )
}

/**
 * Shown to admin accounts only. On a trusted device (one full sign-in done
 * here before) one tap opens the admin. Otherwise it opens nothing by itself:
 * the admin screen needs a sign-in through the bot (master password, username,
 * password), which returns an "Open admin" button and trusts this device.
 */
function AdminEntry() {
  const navigate = useNavigate()
  const unlocked = useAdminSession((s) => s.token !== null)
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [trusted, setTrusted] = useState(false)
  const [opening, setOpening] = useState(false)
  useEffect(() => {
    let alive = true
    hasTrustedDevice().then(
      (t) => alive && setTrusted(t),
      (e: unknown) => console.warn('[admin] could not check for a trusted device', e),
    )
    return () => {
      alive = false
    }
  }, [])
  const openTrusted = async () => {
    setOpening(true)
    setError(null)
    try {
      if (await signInWithDevice()) navigate('/admin')
      else setTrusted(false)
    } catch (e) {
      // The API no longer trusts this device (it was forgotten here): the full sign-in is next
      setError(errorMessage(e))
      setTrusted(false)
    } finally {
      setOpening(false)
    }
  }
  const start = async () => {
    setState('busy')
    setError(null)
    try {
      await startAdminSignIn()
      setState('sent')
      // The rest happens in the chat: close the app so the bot's question is in view
      window.setTimeout(() => getWebApp()?.close(), 1500)
    } catch (e) {
      setError(errorMessage(e))
      setState('idle')
    }
  }
  return (
    <motion.section variants={popIn} className="rounded-card border border-white/20 bg-white p-4 text-black">
      <p className="text-[15px] font-bold">Admin</p>
      {unlocked ? (
        <button type="button" onClick={() => navigate('/admin')} className="mt-2 w-full rounded-lg bg-black py-2.5 text-[14px] font-bold text-white">
          Open the admin screen
        </button>
      ) : trusted ? (
        <>
          <p className="mt-1 text-[13px]">This device is trusted for your admin account.</p>
          <button type="button" disabled={opening} onClick={() => void openTrusted()} className="mt-2 w-full rounded-lg bg-black py-2.5 text-[14px] font-bold text-white disabled:opacity-50">
            {opening ? 'Opening...' : 'Open the admin'}
          </button>
        </>
      ) : state === 'sent' ? (
        <p className="mt-1 text-[13px]">The bot has messaged you. Answer it in the chat with the master password, your admin username and your password. It then sends an Open admin button.</p>
      ) : (
        <>
          <p className="mt-1 text-[13px]">
            Locked. Signing in happens in the bot chat and needs the master password, your admin username and password. After that, this device is trusted and one tap opens the admin.
          </p>
          <button type="button" disabled={state === 'busy'} onClick={() => void start()} className="mt-2 w-full rounded-lg bg-black py-2.5 text-[14px] font-bold text-white disabled:opacity-50">
            {state === 'busy' ? 'Asking the bot...' : 'Start admin sign-in'}
          </button>
          {error && <p className="mt-2 text-[12px] font-semibold">Error: {error}</p>}
        </>
      )}
    </motion.section>
  )
}
