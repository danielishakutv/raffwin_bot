import { Camera, Check, FileImage, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import * as api from '@/api'
import { errorMessage } from '@/api/errors'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Chip } from '@/components/ui/Chip'
import { cn } from '@/components/ui/cn'
import { Field, Input, Select, Toggle } from '@/components/ui/Field'
import { Spinner } from '@/components/ui/Spinner'
import { toast } from '@/components/ui/toastStore'
import { NIGERIAN_STATES } from '@/data/states'
import type { Profile } from '@/data/types'
import { fileToDataUrl } from '@/hooks/useImageFile'
import { formatDateTime, formatPhoneDisplay, normalizeNigerianPhone } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { validateEmail, validateFullName, validatePhone, validateRequired, validateUsername } from '@/services/validation'
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
 * Personal info
 * -------------------------------------------------------------------------- */
export function PersonalInfoSection({ profile }: { profile: Profile }) {
  const updateProfile = useAppStore((s) => s.updateProfile)
  const [form, setForm] = useState({
    fullName: profile.fullName,
    username: profile.username,
    phone: formatPhoneDisplay(profile.phone).replace('+234 ', ''),
    email: profile.email,
  })
  const [availability, setAvailability] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle')
  const { saving, saved, run } = useSaveState()

  const errors = {
    fullName: validateFullName(form.fullName),
    username: validateUsername(form.username),
    phone: validatePhone(form.phone),
    email: validateEmail(form.email),
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
      void api.checkUsername(form.username).then((r) => {
        if (!cancelled) setAvailability(r.available ? 'available' : 'taken')
      })
    }, 400)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [form.username, usernameChanged, usernameError])

  const dirty =
    form.fullName !== profile.fullName ||
    usernameChanged ||
    normalizeNigerianPhone(form.phone) !== profile.phone ||
    form.email.trim().toLowerCase() !== profile.email
  const valid = !Object.values(errors).some(Boolean) && (!usernameChanged || availability === 'available')

  return (
    <div className="flex flex-col gap-4">
      <Field label="Full name" htmlFor="pi-name" error={errors.fullName}>
        <Input id="pi-name" value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} invalid={!!errors.fullName} />
      </Field>
      <Field
        label="Username"
        htmlFor="pi-username"
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
      <Field label="Phone number" htmlFor="pi-phone" error={errors.phone}>
        <Input id="pi-phone" type="tel" inputMode="tel" leading="+234" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} invalid={!!errors.phone} />
      </Field>
      <Field label="Email" htmlFor="pi-email" error={errors.email}>
        <Input id="pi-email" type="email" inputMode="email" autoCapitalize="none" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} invalid={!!errors.email} />
      </Field>
      <SaveButton
        saving={saving}
        saved={saved}
        disabled={!dirty || !valid}
        onClick={() =>
          void run(() =>
            updateProfile({
              fullName: form.fullName,
              username: form.username,
              phone: normalizeNigerianPhone(form.phone) ?? profile.phone,
              email: form.email,
            }),
          )
        }
      />
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Delivery address
 * -------------------------------------------------------------------------- */
export function AddressSection({ profile }: { profile: Profile }) {
  const updateAddress = useAppStore((s) => s.updateAddress)
  const [form, setForm] = useState({
    street: profile.address?.street ?? '',
    city: profile.address?.city ?? '',
    state: profile.address?.state ?? '',
    landmark: profile.address?.landmark ?? '',
    phone: profile.address?.phone ? formatPhoneDisplay(profile.address.phone).replace('+234 ', '') : formatPhoneDisplay(profile.phone).replace('+234 ', ''),
  })
  const { saving, saved, run } = useSaveState()
  const errors = {
    street: validateRequired(form.street, 'your street address'),
    city: validateRequired(form.city, 'your city or town'),
    state: validateRequired(form.state, 'your state'),
    phone: validatePhone(form.phone),
  }
  const valid = !Object.values(errors).some(Boolean)
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }))

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-mist">Physical prizes are delivered here. Keep it accurate.</p>
      <Field label="Street address" htmlFor="ad-street" error={form.street ? errors.street : null}>
        <Input id="ad-street" placeholder="12 Adeola Odeku Street" value={form.street} onChange={(e) => set('street')(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="City / town" htmlFor="ad-city">
          <Input id="ad-city" placeholder="Victoria Island" value={form.city} onChange={(e) => set('city')(e.target.value)} />
        </Field>
        <Field label="State" htmlFor="ad-state">
          <Select id="ad-state" placeholder="Select state" options={NIGERIAN_STATES} value={form.state} onChange={(e) => set('state')(e.target.value)} />
        </Field>
      </div>
      <Field label="Landmark (optional)" htmlFor="ad-landmark">
        <Input id="ad-landmark" placeholder="Opposite Eko Hotel" value={form.landmark} onChange={(e) => set('landmark')(e.target.value)} />
      </Field>
      <Field label="Phone for delivery" htmlFor="ad-phone" error={form.phone ? errors.phone : null}>
        <Input id="ad-phone" type="tel" inputMode="tel" leading="+234" value={form.phone} onChange={(e) => set('phone')(e.target.value)} />
      </Field>
      <SaveButton
        saving={saving}
        saved={saved}
        disabled={!valid}
        label="Save address"
        onClick={() =>
          void run(() =>
            updateAddress({
              street: form.street.trim(),
              city: form.city.trim(),
              state: form.state,
              landmark: form.landmark.trim(),
              phone: normalizeNigerianPhone(form.phone) ?? profile.phone,
            }),
          )
        }
      />
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Identity verification
 * -------------------------------------------------------------------------- */
export function VerificationSection({ profile }: { profile: Profile }) {
  const submitVerification = useAppStore((s) => s.submitVerification)
  const v = profile.verification
  const [idImage, setIdImage] = useState<string | null>(v.idImage)
  const [selfieImage, setSelfieImage] = useState<string | null>(v.selfieImage)
  const [busy, setBusy] = useState<'id' | 'selfie' | null>(null)
  const { saving, saved, run } = useSaveState()
  const idInput = useRef<HTMLInputElement>(null)
  const selfieInput = useRef<HTMLInputElement>(null)

  const pick = async (kind: 'id' | 'selfie', file: File | undefined) => {
    if (!file) return
    setBusy(kind)
    try {
      const url = await fileToDataUrl(file)
      if (kind === 'id') setIdImage(url)
      else setSelfieImage(url)
      sound.play('pop')
      haptics.impact('light')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const canSubmit = !!idImage && !!selfieImage && (v.status === 'unverified' || idImage !== v.idImage || selfieImage !== v.selfieImage)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <VerificationBadge status={v.status} />
        {v.submittedAt && <span className="text-[12px] text-haze">Submitted {formatDateTime(v.submittedAt)}</span>}
      </div>
      <p className="text-[13px] text-mist">
        Upload a government ID (NIN slip, driver's licence, voter's card or passport) and a clear selfie. Demo: images stay on this device only.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <UploadTile label="Government ID" icon={<FileImage size={22} />} image={idImage} busy={busy === 'id'} onPick={() => idInput.current?.click()} />
        <UploadTile label="Selfie / profile photo" icon={<Camera size={22} />} image={selfieImage} busy={busy === 'selfie'} onPick={() => selfieInput.current?.click()} />
      </div>
      <input ref={idInput} type="file" accept="image/*" className="hidden" onChange={(e) => void pick('id', e.target.files?.[0])} />
      <input ref={selfieInput} type="file" accept="image/*" capture="user" className="hidden" onChange={(e) => void pick('selfie', e.target.files?.[0])} />
      <SaveButton
        saving={saving}
        saved={saved}
        disabled={!canSubmit}
        label={v.status === 'unverified' ? 'Submit for review' : 'Resubmit documents'}
        onClick={() => void run(() => submitVerification({ idImage: idImage!, selfieImage: selfieImage! }))}
      />
      {v.status === 'pending' && <p className="text-center text-[12px] text-haze">Reviews take up to 24 hours. You can flip the outcome from Demo controls below.</p>}
    </div>
  )
}

function UploadTile({ label, icon, image, busy, onPick }: { label: string; icon: React.ReactNode; image: string | null; busy: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        sound.play('click')
        onPick()
      }}
      className={cn('tap relative flex aspect-[4/3] flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed text-mist', image ? 'border-mint/50' : 'border-white/15 bg-white/5')}
    >
      {image ? <img src={image} alt={label} className="absolute inset-0 h-full w-full object-cover" /> : null}
      {busy ? (
        <Spinner className="h-6 w-6" />
      ) : image ? (
        <span className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-mint text-ink">
          <Check size={16} strokeWidth={3} />
        </span>
      ) : (
        <>
          {icon}
          <span className="mt-1 px-2 text-center text-[12px] font-semibold">{label}</span>
        </>
      )}
    </button>
  )
}

export function VerificationBadge({ status }: { status: Profile['verification']['status'] }) {
  if (status === 'verified')
    return (
      <Chip tone="mint" icon={<ShieldCheck size={13} />}>
        Verified
      </Chip>
    )
  if (status === 'pending') return <Chip tone="sun">Pending review</Chip>
  return <Chip tone="neutral">Not verified</Chip>
}

/* ----------------------------------------------------------------------------
 * Contact preferences
 * -------------------------------------------------------------------------- */
export function ContactSection({ profile }: { profile: Profile }) {
  const updateContactPrefs = useAppStore((s) => s.updateContactPrefs)
  const prefs = profile.contactPrefs
  const set = (key: keyof typeof prefs) => (value: boolean) => {
    void updateContactPrefs({ ...prefs, [key]: value }).catch((error) => toast.error(errorMessage(error)))
  }
  return (
    <div className="flex flex-col divide-y divide-white/8">
      <Toggle checked={prefs.telegram} onChange={set('telegram')} label="Telegram notifications" description="Draw results and winner alerts" />
      <Toggle checked={prefs.whatsapp} onChange={set('whatsapp')} label="WhatsApp" description={`Delivery updates on ${formatPhoneDisplay(profile.phone)}`} />
      <Toggle checked={prefs.email} onChange={set('email')} label="Email" description={profile.email} />
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Demo controls
 * -------------------------------------------------------------------------- */
export function DemoControls({ profile }: { profile: Profile }) {
  const setVerificationStatus = useAppStore((s) => s.setVerificationStatus)
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

  const statuses = ['unverified', 'pending', 'verified'] as const
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[13px] font-semibold text-mist">Verification outcome</p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {statuses.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void act(`v-${s}`, () => setVerificationStatus(s), `Verification set to ${s}`)}
              className={cn('tap rounded-xl px-2 py-2 text-[12px] font-bold capitalize', profile.verification.status === s ? 'bg-brand text-white' : 'bg-white/8 text-mist')}
            >
              {s === 'pending' ? 'Pending' : s}
            </button>
          ))}
        </div>
      </div>
      <BouncyButton variant="secondary" sfx="click" onClick={() => { expireRateNow(); toast.info('Rate expired. Fetching a new quote.') }}>
        Refresh the Naira rate now
      </BouncyButton>
      <BouncyButton variant="secondary" sfx="click" loading={busy === 'reset'} onClick={() => void act('reset', resetDemo, 'Demo data reset')}>
        Reset demo data (keeps my account)
      </BouncyButton>
      <BouncyButton variant="danger" sfx="click" loading={busy === 'signout'} onClick={() => void act('signout', signOut, 'Signed out of the demo')}>
        Sign out and start over
      </BouncyButton>
    </div>
  )
}
