import { motion } from 'framer-motion'
import { Check, Phone } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as api from '@/api'
import { usingRealApi } from '@/api'
import { errorMessage, isApiError } from '@/api/errors'
import { staggerContainer, fadeUp } from '@/components/motion'
import { BouncyButton } from '@/components/ui/BouncyButton'
import { Field, Input } from '@/components/ui/Field'
import { LogoMark, Wordmark } from '@/components/ui/Logo'
import { MakerFooter } from '@/components/ui/MakerFooter'
import { Spinner } from '@/components/ui/Spinner'
import { formatPhoneDisplay, normalizeNigerianPhone } from '@/services/format'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { getTelegramUser, requestContact, type ContactShare } from '@/services/telegram'
import { validateEmail, validateFullName, validatePhone, validateUsername } from '@/services/validation'
import { useAppStore } from '@/store/useAppStore'

type Availability = 'idle' | 'checking' | 'available' | 'taken'

/** One message per outcome, so a failed share says what to do next. */
function contactProblem(share: ContactShare | null, phone: string | null): string | null {
  if (!share) return 'Share your number through Telegram'
  switch (share.status) {
    case 'shared':
      return phone ? null : 'Your Telegram account uses a number outside Nigeria. Raffle Win needs a Nigerian number.'
    case 'cancelled':
      return 'You closed the prompt. Raffle Win needs your number to create your account.'
    case 'unsupported':
      return 'This Telegram app is too old to share a number. Update Telegram, then open Raffle Win again.'
    case 'no_proof':
      return 'Telegram did not confirm the number. Tap the button to try again.'
  }
}

/**
 * First visit: create the account. Pre-fills what Telegram already knows.
 * With the real API the phone number comes from Telegram's contact share
 * (verified, cannot be typed); with the mock API it is typed in.
 */
export function SignUpPage() {
  const navigate = useNavigate()
  const booted = useAppStore((s) => s.booted)
  const profile = useAppStore((s) => s.profile)
  const onboardingComplete = useAppStore((s) => s.onboardingComplete)
  const signUp = useAppStore((s) => s.signUp)

  useEffect(() => {
    if (booted && profile) navigate(onboardingComplete ? '/home' : '/onboarding', { replace: true })
  }, [booted, profile, onboardingComplete, navigate])

  const tg = useMemo(() => getTelegramUser(), [])
  const [form, setForm] = useState({
    fullName: tg ? [tg.first_name, tg.last_name].filter(Boolean).join(' ') : '',
    username: tg?.username?.toLowerCase().replace(/[^a-z0-9_]/g, '') ?? '',
    phone: '',
    email: '',
  })
  const [touched, setTouched] = useState<Record<keyof typeof form, boolean>>({
    fullName: false,
    username: false,
    phone: false,
    email: false,
  })
  const [availability, setAvailability] = useState<Availability>('idle')
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [contact, setContact] = useState<ContactShare | null>(null)
  const [sharing, setSharing] = useState(false)

  const sharedPhone = contact?.status === 'shared' ? normalizeNigerianPhone(contact.phone) : null
  const errors = {
    fullName: validateFullName(form.fullName),
    username: validateUsername(form.username),
    phone: usingRealApi ? contactProblem(contact, sharedPhone) : validatePhone(form.phone),
    email: validateEmail(form.email),
  }

  const shareContact = async () => {
    setSharing(true)
    setServerError(null)
    const share = await requestContact()
    setContact(share)
    setTouched((t) => ({ ...t, phone: true }))
    setSharing(false)
    if (share.status === 'shared') haptics.notify('success')
  }

  // Live username check against the demo list (debounced)
  const usernameError = errors.username
  useEffect(() => {
    if (usernameError) {
      setAvailability('idle')
      return
    }
    setAvailability('checking')
    let cancelled = false
    const id = window.setTimeout(() => {
      void api.checkUsername(form.username).then((res) => {
        if (!cancelled) setAvailability(res.available ? 'available' : 'taken')
      })
    }, 400)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [form.username, usernameError])

  const update = (key: keyof typeof form) => (value: string) => {
    setServerError(null)
    setForm((f) => ({ ...f, [key]: key === 'username' ? value.toLowerCase().replace(/\s/g, '') : value }))
  }
  const blur = (key: keyof typeof form) => () => setTouched((t) => ({ ...t, [key]: true }))

  const normalizedPhone = usingRealApi ? sharedPhone : normalizeNigerianPhone(form.phone)
  const formValid = !Object.values(errors).some(Boolean) && availability === 'available'

  const submit = async () => {
    setTouched({ fullName: true, username: true, phone: true, email: true })
    if (!formValid || !normalizedPhone) {
      sound.play('error')
      haptics.notify('error')
      return
    }
    setSubmitting(true)
    setServerError(null)
    try {
      await signUp({
        fullName: form.fullName,
        username: form.username,
        phone: normalizedPhone,
        email: form.email,
        telegramId: tg?.id ?? null,
        contactProof: contact?.status === 'shared' ? contact.proof : undefined,
      })
      sound.play('chime')
      haptics.notify('success')
      navigate('/onboarding', { replace: true })
    } catch (error) {
      if (isApiError(error, 'USERNAME_TAKEN')) setAvailability('taken')
      setServerError(errorMessage(error))
      sound.play('error')
      haptics.notify('error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative mx-auto flex min-h-dvh w-full max-w-[520px] flex-col px-5 safe-top">
      <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex flex-1 flex-col pt-8">
        <motion.div variants={fadeUp} className="flex items-center gap-3">
          <LogoMark size={44} />
          <Wordmark />
        </motion.div>
        <motion.h1 variants={fadeUp} className="mt-8 text-[30px] font-bold leading-tight">
          Create my account
        </motion.h1>
        <motion.p variants={fadeUp} className="mt-2 text-[15px] text-mist">
          Step 1 of 2. Thirty seconds, then you are in the draw.
        </motion.p>

        <motion.form
          variants={fadeUp}
          className="mt-7 flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          noValidate
        >
          <Field label="Full name" htmlFor="fullName" error={touched.fullName ? errors.fullName : null}>
            <Input
              id="fullName"
              autoComplete="name"
              placeholder="Ada Obi"
              value={form.fullName}
              onChange={(e) => update('fullName')(e.target.value)}
              onBlur={blur('fullName')}
              invalid={touched.fullName && !!errors.fullName}
            />
          </Field>

          <Field
            label="Username"
            htmlFor="username"
            hint="Letters, numbers and underscores. This is how winners are announced."
            error={
              touched.username && errors.username
                ? errors.username
                : availability === 'taken'
                  ? 'That username is taken. Try another.'
                  : null
            }
            success={
              availability === 'available' ? (
                <>
                  <Check size={14} strokeWidth={3} /> @{form.username} is available
                </>
              ) : null
            }
          >
            <Input
              id="username"
              autoComplete="username"
              autoCapitalize="none"
              placeholder="ada_obi"
              leading="@"
              value={form.username}
              onChange={(e) => update('username')(e.target.value)}
              onBlur={blur('username')}
              invalid={(touched.username && !!errors.username) || availability === 'taken'}
              suffix={
                availability === 'checking' ? (
                  <Spinner className="h-4 w-4 text-mist" />
                ) : availability === 'available' ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-mint text-ink">
                    <Check size={14} strokeWidth={3} />
                  </span>
                ) : null
              }
            />
          </Field>

          {usingRealApi ? (
            <Field
              label="Phone number"
              htmlFor="phone-share"
              hint={sharedPhone ? undefined : 'Telegram shares the number on your account, so nobody can sign up with yours.'}
              error={touched.phone ? errors.phone : null}
              success={
                sharedPhone ? (
                  <>
                    <Check size={14} strokeWidth={3} /> {formatPhoneDisplay(sharedPhone)}, verified by Telegram
                  </>
                ) : null
              }
            >
              {!sharedPhone && (
                <BouncyButton
                  id="phone-share"
                  type="button"
                  variant="secondary"
                  block
                  loading={sharing}
                  onClick={() => void shareContact()}
                >
                  <Phone size={16} /> Share my number from Telegram
                </BouncyButton>
              )}
            </Field>
          ) : (
            <Field
              label="Phone number"
              htmlFor="phone"
              hint={normalizedPhone ? `We will save it as ${formatPhoneDisplay(normalizedPhone)}` : 'Nigerian mobile number'}
              error={touched.phone ? errors.phone : null}
            >
              <Input
                id="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="803 123 4567"
                leading="+234"
                value={form.phone}
                onChange={(e) => update('phone')(e.target.value)}
                onBlur={blur('phone')}
                invalid={touched.phone && !!errors.phone}
              />
            </Field>
          )}

          <Field label="Email" htmlFor="email" error={touched.email ? errors.email : null}>
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              placeholder="ada@example.com"
              value={form.email}
              onChange={(e) => update('email')(e.target.value)}
              onBlur={blur('email')}
              invalid={touched.email && !!errors.email}
            />
          </Field>

          {serverError && <p className="text-[13px] font-medium text-coral">{serverError}</p>}

          <BouncyButton type="submit" size="lg" block pulse={formValid} loading={submitting} className="mt-2">
            Continue to the rules
          </BouncyButton>
          {!usingRealApi && (
            <p className="text-center text-[12px] text-haze">Demo account. Nothing here is sent to a server.</p>
          )}
        </motion.form>
      </motion.div>
      <MakerFooter />
    </div>
  )
}
