import { motion } from 'framer-motion'
import { Check, MapPin, Phone } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usingRealApi } from '@/api'
import { errorMessage } from '@/api/errors'
import { fadeUp, staggerContainer } from '@/components/motion'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Field, Input, Select } from '@/components/ui/Field'
import { PageHeader } from '@/components/ui/PageHeader'
import { toast } from '@/components/ui/toastStore'
import { NIGERIAN_STATES } from '@/data/states'
import { useBackButton } from '@/hooks/useBackButton'
import { formatPhoneDisplay, normalizeNigerianPhone } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { requestContact, type ContactShare } from '@/services/telegram'
import { validateFullName, validatePhone, validateRequired } from '@/services/validation'
import { useAppStore } from '@/store/useAppStore'

/** One message per outcome, so a failed share says what to do next. */
function contactProblem(share: ContactShare | null, phone: string | null): string | null {
  if (!share) return 'Share your number through Telegram so the courier can call you'
  switch (share.status) {
    case 'shared':
      return phone ? null : 'Your Telegram account uses a number outside Nigeria. Raffle Win delivers in Nigeria only.'
    case 'cancelled':
      return 'You closed the prompt. The courier needs your number to hand over the prize.'
    case 'unsupported':
      return 'This Telegram app is too old to share a number. Update Telegram, then open Raffle Win again.'
    case 'no_proof':
      return 'Telegram did not confirm the number. Tap the button to try again.'
  }
}

/**
 * KYC: the only place personal details are asked for, and only what is
 * needed to deliver a prize: the name to hand it to, a phone the courier can
 * call (shared from Telegram, so it is the account's real number), and the
 * nearest motor park in the player's city. Never a house address.
 */
export function KycPage() {
  const navigate = useNavigate()
  useBackButton(true, () => navigate('/profile'))
  const profile = useAppStore((s) => s.profile)
  const saveKyc = useAppStore((s) => s.saveKyc)

  const [form, setForm] = useState({
    fullName: profile?.fullName ?? '',
    phone: '',
    state: profile?.delivery?.state ?? '',
    city: profile?.delivery?.city ?? '',
    motorPark: profile?.delivery?.motorPark ?? '',
  })
  const [touched, setTouched] = useState(false)
  const [contact, setContact] = useState<ContactShare | null>(null)
  const [sharing, setSharing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const alreadyVerified = !!profile?.phoneVerified
  const sharedPhone = contact?.status === 'shared' ? normalizeNigerianPhone(contact.phone) : null
  const phoneError = useMemo(() => {
    if (usingRealApi) return alreadyVerified || sharedPhone ? null : contactProblem(contact, sharedPhone)
    if (profile?.phone && !form.phone) return null
    return validatePhone(form.phone)
  }, [alreadyVerified, sharedPhone, contact, form.phone, profile?.phone])

  const errors = {
    fullName: validateFullName(form.fullName),
    phone: phoneError,
    state: validateRequired(form.state, 'your state'),
    city: form.city.trim().length >= 2 ? null : 'Enter your city or town',
    motorPark: form.motorPark.trim().length >= 3 ? null : 'Enter the motor park nearest to you',
  }
  const valid = !Object.values(errors).some(Boolean)
  const set = (key: keyof typeof form) => (value: string) => {
    setServerError(null)
    setForm((f) => ({ ...f, [key]: value }))
  }

  const share = async () => {
    setSharing(true)
    const result = await requestContact()
    setContact(result)
    setSharing(false)
    if (result.status === 'shared') haptics.notify('success')
  }

  const submit = async () => {
    setTouched(true)
    if (!valid) {
      sound.play('error')
      haptics.notify('error')
      return
    }
    setSaving(true)
    setServerError(null)
    try {
      await saveKyc({
        fullName: form.fullName,
        state: form.state,
        city: form.city,
        motorPark: form.motorPark,
        ...(contact?.status === 'shared' ? { contactProof: contact.proof } : {}),
        ...(!usingRealApi && form.phone ? { phone: form.phone } : {}),
      })
      sound.play('chime')
      haptics.notify('success')
      toast.success('Delivery details saved')
      navigate('/profile', { replace: true })
    } catch (error) {
      setServerError(errorMessage(error))
      sound.play('error')
      haptics.notify('error')
    } finally {
      setSaving(false)
    }
  }

  const shownPhone = sharedPhone ?? profile?.phone ?? null

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex flex-col gap-4 pb-10">
      <PageHeader title="Prize delivery" subtitle="Needed only when you win a physical prize" back="/profile" />

      <motion.div variants={fadeUp} className="surface flex gap-3 rounded-card p-4 text-[13px] text-mist">
        <MapPin size={18} className="mt-0.5 shrink-0 text-sun" />
        <p>
          For your safety we never deliver to a home address. Prizes go to the motor park nearest to you, and the courier calls you
          when it arrives. Bring the phone on this page to collect.
        </p>
      </motion.div>

      <motion.form
        variants={fadeUp}
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field label="Full name" htmlFor="kyc-name" hint="As on the ID you will show at the park" error={touched ? errors.fullName : null}>
          <Input id="kyc-name" autoComplete="name" value={form.fullName} onChange={(e) => set('fullName')(e.target.value)} invalid={touched && !!errors.fullName} />
        </Field>

        {usingRealApi ? (
          <Field
            label="Phone number"
            htmlFor="kyc-phone-share"
            error={touched ? errors.phone : null}
            success={
              shownPhone && (alreadyVerified || sharedPhone) ? (
                <>
                  <Check size={14} strokeWidth={3} /> {formatPhoneDisplay(shownPhone)}, verified by Telegram
                </>
              ) : null
            }
          >
            {!alreadyVerified && !sharedPhone && (
              <BouncyButton id="kyc-phone-share" type="button" variant="secondary" block loading={sharing} onClick={() => void share()}>
                <Phone size={16} /> Share my number from Telegram
              </BouncyButton>
            )}
          </Field>
        ) : (
          <Field
            label="Phone number"
            htmlFor="kyc-phone"
            hint={profile?.phone ? `Saved: ${formatPhoneDisplay(profile.phone)}. Type a new one to change it.` : 'Nigerian mobile number (demo: typed in)'}
            error={touched ? errors.phone : null}
          >
            <Input
              id="kyc-phone"
              type="tel"
              inputMode="tel"
              leading="+234"
              placeholder="803 123 4567"
              value={form.phone}
              onChange={(e) => set('phone')(e.target.value)}
              invalid={touched && !!errors.phone}
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="State" htmlFor="kyc-state" error={touched ? errors.state : null}>
            <Select id="kyc-state" placeholder="Select state" options={NIGERIAN_STATES} value={form.state} onChange={(e) => set('state')(e.target.value)} />
          </Field>
          <Field label="City / town" htmlFor="kyc-city" error={touched ? errors.city : null}>
            <Input id="kyc-city" placeholder="Ikeja" value={form.city} onChange={(e) => set('city')(e.target.value)} invalid={touched && !!errors.city} />
          </Field>
        </div>

        <Field
          label="Nearest motor park"
          htmlFor="kyc-park"
          hint="The park where you can collect, e.g. Jibowu, Ojota, Utako or Mile 1"
          error={touched ? errors.motorPark : null}
        >
          <Input id="kyc-park" placeholder="Ojota Motor Park" value={form.motorPark} onChange={(e) => set('motorPark')(e.target.value)} invalid={touched && !!errors.motorPark} />
        </Field>

        {serverError && <p className="text-[13px] font-medium text-coral">{serverError}</p>}

        <BouncyButton type="submit" size="lg" block pulse={valid} loading={saving}>
          Save delivery details
        </BouncyButton>
      </motion.form>
    </motion.div>
  )
}
