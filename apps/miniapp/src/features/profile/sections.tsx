import { Check, Phone } from 'lucide-react'
import type { FeatureKey } from '@raffwin/shared'
import { useEffect, useState } from 'react'
import * as api from '@/api'
import { errorMessage } from '@/api/errors'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Field, Input, Toggle } from '@/components/ui/Field'
import { Spinner } from '@/components/ui/Spinner'
import { toast } from '@/components/ui/toastStore'
import type { Profile } from '@/data/types'
import { formatPhoneDisplay } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { validateFullName, validateUsername } from '@/services/validation'
import { useAppStore } from '@/store/useAppStore'
import { SaveButton } from './SectionCard'

/** Shared "saving -> saved" button state with the check mark held for 1.6s. */
function useSaveState() {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    setSaving(true)
    try {
      await fn()
      setSaved(true)
      sound.play('chime')
      haptics.notify('success')
      toast.success('Saved')
      window.setTimeout(() => setSaved(false), 1600)
    } catch (error) {
      toast.error(errorMessage(error))
      sound.play('error')
      haptics.notify('error')
    } finally {
      setSaving(false)
    }
  }
  return { saving, saved, run }
}

/* ----------------------------------------------------------------------------
 * Personal info: name and username. The phone is never typed: Telegram shares
 * it (onPhone opens that flow), so it is shown here with an Add/Update action.
 * -------------------------------------------------------------------------- */
export function PersonalInfoSection({ profile, onPhone }: { profile: Profile; onPhone: () => void }) {
  const updateProfile = useAppStore((s) => s.updateProfile)
  const [form, setForm] = useState({ fullName: profile.fullName, username: profile.username })
  const [availability, setAvailability] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle')
  const { saving, saved, run } = useSaveState()

  const errors = {
    fullName: validateFullName(form.fullName),
    username: validateUsername(form.username),
  }
  const usernameChanged = form.username !== profile.username
  const usernameError = errors.username

  useEffect(() => {
    if (!usernameChanged || usernameError) {
      setAvailability('idle')
      return
    }
    setAvailability('checking')
    let cancelled = false
    const id = window.setTimeout(() => {
      api.checkUsername(form.username).then(
        (r) => {
          if (!cancelled) setAvailability(r.available ? 'available' : 'taken')
        },
        (error: unknown) => {
          if (!cancelled) setAvailability('idle')
          toast.error(errorMessage(error))
        },
      )
    }, 400)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [form.username, usernameChanged, usernameError])

  const dirty = form.fullName !== profile.fullName || usernameChanged
  const valid = !Object.values(errors).some(Boolean) && (!usernameChanged || availability === 'available')

  return (
    <div className="flex flex-col gap-4">
      <Field label="Full name" htmlFor="pi-name" error={errors.fullName}>
        <Input id="pi-name" value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} invalid={!!errors.fullName} />
      </Field>
      <Field
        label="Username"
        htmlFor="pi-username"
        hint="This is how winners are announced."
        error={errors.username ?? (availability === 'taken' ? 'That username is taken.' : null)}
        success={availability === 'available' ? <><Check size={14} strokeWidth={3} /> Available</> : null}
      >
        <Input
          id="pi-username"
          leading="@"
          autoCapitalize="none"
          value={form.username}
          onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.toLowerCase().replace(/\s/g, '') }))}
          invalid={!!errors.username || availability === 'taken'}
          suffix={availability === 'checking' ? <Spinner className="h-4 w-4 text-mist" /> : null}
        />
      </Field>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-mist">Phone number</p>
          <p className="mt-1 text-[15px] font-bold">{profile.phone ? formatPhoneDisplay(profile.phone) : 'Not added yet'}</p>
          <p className="text-[12px] text-haze">
            {profile.phone
              ? `${profile.phoneVerified ? 'Verified by Telegram. ' : ''}Used only to reach you about prizes; never shown to other players.`
              : 'Needed so we can reach you if you win.'}
          </p>
        </div>
        <BouncyButton size="sm" variant={profile.phone ? 'secondary' : 'sun'} sfx="click" icon={<Phone size={16} />} onClick={onPhone} className="shrink-0">
          {profile.phone ? 'Update' : 'Add'}
        </BouncyButton>
      </div>
      <SaveButton
        saving={saving}
        saved={saved}
        disabled={!dirty || !valid}
        onClick={() => void run(() => updateProfile({ fullName: form.fullName, username: form.username }))}
      />
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Contact preferences
 * -------------------------------------------------------------------------- */
export function ContactSection({ profile }: { profile: Profile }) {
  const updateContactPrefs = useAppStore((s) => s.updateContactPrefs)
  const prefs = profile.contactPrefs
  const set = (key: keyof typeof prefs) => (value: boolean) => {
    updateContactPrefs({ ...prefs, [key]: value }).catch((error: unknown) => toast.error(errorMessage(error)))
  }
  return (
    <div className="flex flex-col divide-y divide-white/8">
      <Toggle checked={prefs.telegram} onChange={set('telegram')} label="Telegram notifications" description="Draw results and winner alerts" />
      <Toggle
        checked={prefs.whatsapp}
        onChange={set('whatsapp')}
        label="WhatsApp"
        description={profile.phone ? `Delivery updates on ${formatPhoneDisplay(profile.phone)}` : 'Delivery updates, once you add your phone number'}
      />
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Bot reminders: the player's own switch for nudges and come-back offers.
 * Draw results, prize messages and announcements are not affected.
 * -------------------------------------------------------------------------- */
export function BotMessagesSection({ profile }: { profile: Profile }) {
  const setReminders = useAppStore((s) => s.setReminders)
  // Both automations switched off for everyone: say so; the player's switch still records their choice
  const pausedForAll = useAppStore((s) => !s.features.reminders && !s.features.comeback_offer)
  const [busy, setBusy] = useState(false)
  // An API from before this setting existed sends nothing: reminders were on
  const on = profile.remindersOn !== false

  const change = async (next: boolean) => {
    setBusy(true)
    try {
      await setReminders(next)
      toast.success(next ? 'Reminders are on' : 'Reminders are off. Results, prizes and announcements still reach you.')
    } catch (error) {
      toast.error(errorMessage(error))
      sound.play('error')
      haptics.notify('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Toggle
      checked={on}
      disabled={busy}
      onChange={(next) => void change(next)}
      label="Reminders from the bot"
      description={
        <>
          A short nudge when you have been away for a while, and come-back offers. Draw results, prizes and announcements always reach you.
          {pausedForAll && ' Paused for everyone at the moment.'}
        </>
      }
    />
  )
}

/* ----------------------------------------------------------------------------
 * Demo controls (mock API only)
 * -------------------------------------------------------------------------- */
export function DemoControls() {
  const expireRateNow = useAppStore((s) => s.expireRateNow)
  const resetDemo = useAppStore((s) => s.resetDemo)
  const signOut = useAppStore((s) => s.signOut)
  const features = useAppStore((s) => s.features)
  const setDemoFeature = useAppStore((s) => s.setDemoFeature)
  const [busy, setBusy] = useState<string | null>(null)

  const act = async (key: string, fn: () => Promise<void>, message: string) => {
    setBusy(key)
    try {
      await fn()
      toast.success(message)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  // What a super admin's feature switches do, so the demo can show a feature appearing and vanishing
  const demoSwitches: { key: FeatureKey; label: string; description: string }[] = [
    { key: 'raffs_transfer', label: 'Send Raffs', description: 'Wallet button to send Raffs to another player' },
    { key: 'daily_streak', label: 'Daily streak', description: 'Daily bonus card on Home' },
    { key: 'require_phone_for_entry', label: 'Phone needed to enter', description: 'Entering a raffle asks for the phone first' },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col divide-y divide-white/8">
        {demoSwitches.map((f) => (
          <Toggle
            key={f.key}
            checked={features[f.key]}
            disabled={busy === f.key}
            label={f.label}
            description={f.description}
            onChange={(on) => void act(f.key, () => setDemoFeature(f.key, on), `${f.label} ${on ? 'on' : 'off'}`)}
          />
        ))}
      </div>
      <BouncyButton variant="secondary" sfx="click" onClick={() => { expireRateNow(); toast.info('Rate expired. Fetching a new quote.') }}>
        Refresh the rate now
      </BouncyButton>
      <BouncyButton variant="secondary" sfx="click" loading={busy === 'reset'} onClick={() => void act('reset', resetDemo, 'Demo data reset')}>
        Reset demo data (keeps my account)
      </BouncyButton>
      <BouncyButton variant="danger" sfx="click" loading={busy === 'signout'} onClick={() => void act('signout', signOut, 'Started over')}>
        Start over with a fresh demo account
      </BouncyButton>
    </div>
  )
}
