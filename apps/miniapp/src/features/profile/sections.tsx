import { Check } from 'lucide-react'
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
 * Personal info: name and username. The phone comes from Telegram on the KYC
 * page and is shown here read-only.
 * -------------------------------------------------------------------------- */
export function PersonalInfoSection({ profile }: { profile: Profile }) {
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
      <div>
        <p className="text-[13px] font-semibold text-mist">Phone number</p>
        <p className="mt-1 text-[15px] font-bold">{profile.phone ? formatPhoneDisplay(profile.phone) : 'Not given yet'}</p>
        <p className="text-[12px] text-haze">
          {profile.phoneVerified ? 'Verified by Telegram.' : 'Shared from Telegram on the prize delivery (KYC) page.'}
        </p>
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
        description={profile.phone ? `Delivery updates on ${formatPhoneDisplay(profile.phone)}` : 'Delivery updates, once you give your phone on the KYC page'}
      />
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Demo controls (mock API only)
 * -------------------------------------------------------------------------- */
export function DemoControls() {
  const expireRateNow = useAppStore((s) => s.expireRateNow)
  const resetDemo = useAppStore((s) => s.resetDemo)
  const signOut = useAppStore((s) => s.signOut)
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

  return (
    <div className="flex flex-col gap-4">
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
