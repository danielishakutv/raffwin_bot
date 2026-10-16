import { motion } from 'framer-motion'
import { Bell, ChevronRight, History, MapPin, Settings2, ShieldCheck, Ticket, Trophy, UserRound, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { staggerContainer, popIn } from '@/components/motion'
import { AboutSoftware } from '@/components/ui/AboutSoftware'
import { Avatar } from '@/components/ui/Avatar'
import { Toggle } from '@/components/ui/Field'
import { formatPhoneDisplay } from '@/services/format'
import { sound } from '@/services/sound'
import { useAppStore, useMyWins } from '@/store/useAppStore'
import { SectionCard } from './SectionCard'
import { AddressSection, ContactSection, DemoControls, PersonalInfoSection, VerificationBadge, VerificationSection } from './sections'

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
  ]

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex flex-col gap-4">
      <motion.header variants={popIn} className="surface flex items-center gap-4 rounded-card p-4">
        <Avatar name={profile.fullName} seed={profile.username} image={profile.verification.selfieImage} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[20px] font-bold">{profile.fullName}</h1>
          <p className="truncate text-[13px] text-mist">@{profile.username}</p>
          <div className="mt-1.5">
            <VerificationBadge status={profile.verification.status} />
          </div>
        </div>
      </motion.header>

      <motion.div variants={popIn} className="flex flex-col gap-3">
        <SectionCard id="personal" icon={<UserRound size={20} />} title="Personal info" summary={`${formatPhoneDisplay(profile.phone)} · ${profile.email}`} open={open === 'personal'} onToggle={toggle}>
          <PersonalInfoSection key={profile.username + profile.phone + profile.email + profile.fullName} profile={profile} />
        </SectionCard>
        <SectionCard
          id="address"
          icon={<MapPin size={20} />}
          title="Delivery address"
          summary={profile.address ? `${profile.address.street}, ${profile.address.city}, ${profile.address.state}` : 'Add where prizes should be delivered'}
          open={open === 'address'}
          onToggle={toggle}
        >
          <AddressSection profile={profile} />
        </SectionCard>
        <SectionCard
          id="verification"
          icon={<ShieldCheck size={20} />}
          title="Identity verification"
          summary={profile.verification.status === 'verified' ? 'Verified' : profile.verification.status === 'pending' ? 'Pending review' : 'Required before prizes are released'}
          open={open === 'verification'}
          onToggle={toggle}
        >
          <VerificationSection key={profile.verification.status} profile={profile} />
        </SectionCard>
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
          <Settings2 size={18} className="text-mist" /> Sound
        </h2>
        <div className="mt-2 flex flex-col divide-y divide-white/8">
          <Toggle checked={!settings.muted} onChange={(on) => setMuted(!on)} label="Sound effects" description="Taps, entries, wins" />
          <Toggle checked={settings.music} onChange={setMusic} label="Background tune" description="Soft loop at low volume" disabled={settings.muted} />
        </div>
      </motion.section>

      <motion.div variants={popIn}>
        <SectionCard id="demo" icon={<Wrench size={20} />} title="Demo controls" summary="Testing switches. Not part of the real product." open={open === 'demo'} onToggle={toggle}>
          <DemoControls profile={profile} />
        </SectionCard>
      </motion.div>

      <motion.div variants={popIn}>
        <AboutSoftware />
      </motion.div>
    </motion.div>
  )
}
