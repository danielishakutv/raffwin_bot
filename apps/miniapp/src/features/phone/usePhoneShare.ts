import { useEffect, useRef, useState } from 'react'
import { usingRealApi } from '@/api'
import { errorMessage } from '@/api/errors'
import type { Profile } from '@/data/types'
import { botLink } from '@/services/env'
import { haptics } from '@/services/haptics'
import { sound } from '@/services/sound'
import { openExternal, requestContact } from '@/services/telegram'
import { validatePhone } from '@/services/validation'
import { useAppStore } from '@/store/useAppStore'

/**
 * idle     nothing tried yet (or a try failed: see error)
 * asking   Telegram's "share your number" prompt is open
 * saving   sending the share to Raffle Win
 * bot      this Telegram app cannot share from the Mini App: share in the bot chat, then re-check
 * checking re-reading the profile after the bot-chat route
 * saved    the phone is on the account
 */
export type PhoneShareStatus = 'idle' | 'asking' | 'saving' | 'bot' | 'checking' | 'saved'

export interface PhoneShare {
  status: PhoneShareStatus
  /** What went wrong and what to do next, or null */
  error: string | null
  /** The saved number (E.164) once status is 'saved' */
  phone: string | null
  /** Demo build only (no Telegram to share from): the typed number */
  demoPhone: string
  setDemoPhone: (value: string) => void
  /** True in the demo build: the number is typed instead of shared */
  typed: boolean
  /** Ask Telegram for the account's number (demo: save the typed one) */
  share: () => Promise<void>
  /** Opens the bot chat at its phone prompt (/start phone) */
  openBot: () => void
  /** After the bot-chat route: has the number arrived? */
  recheck: () => Promise<void>
}

/** The bot's /start payload that answers with a "Share my phone number" keyboard */
export const BOT_PHONE_LINK = `${botLink}?start=phone`

/**
 * The phone-share flow used by onboarding, the dashboard card, the profile,
 * entering a raffle and sending Raffs. One message per outcome, so a failed
 * share always says what happened and what to do next.
 */
export function usePhoneShare(onSaved?: (profile: Profile) => void): PhoneShare {
  const savePhone = useAppStore((s) => s.savePhone)
  const refreshProfile = useAppStore((s) => s.refreshProfile)
  const [status, setStatus] = useState<PhoneShareStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [phone, setPhone] = useState<string | null>(null)
  const [demoPhone, setDemoPhone] = useState('')
  // The latest callback, so a share that finishes after a re-render calls the current one
  const savedRef = useRef(onSaved)
  useEffect(() => {
    savedRef.current = onSaved
  }, [onSaved])

  const done = (profile: Profile) => {
    setPhone(profile.phone)
    setStatus('saved')
    setError(null)
    sound.play('chime')
    haptics.notify('success')
    savedRef.current?.(profile)
  }

  const fail = (message: string, next: PhoneShareStatus = 'idle') => {
    setError(message)
    setStatus(next)
    sound.play('error')
    haptics.notify('error')
  }

  const save = async (proof: string) => {
    setStatus('saving')
    try {
      done(await savePhone(proof))
    } catch (e) {
      fail(errorMessage(e))
    }
  }

  const share = async () => {
    setError(null)
    if (!usingRealApi) {
      const problem = validatePhone(demoPhone)
      if (problem) return fail(problem)
      return save(demoPhone)
    }
    setStatus('asking')
    const result = await requestContact()
    switch (result.status) {
      case 'shared':
        return save(result.proof)
      case 'cancelled':
        return fail('You closed the Telegram prompt. Tap the button again when you are ready.')
      case 'no_proof':
        return fail('Telegram did not confirm the number. Tap the button to try again.')
      case 'unsupported':
        // Not an error the player caused: offer the route that works on every Telegram app
        setStatus('bot')
        return
    }
  }

  const openBot = () => {
    setError(null)
    setStatus('bot')
    openExternal(BOT_PHONE_LINK)
  }

  const recheck = async () => {
    setStatus('checking')
    setError(null)
    try {
      const profile = await refreshProfile()
      if (profile.phone) return done(profile)
      fail('Your number has not reached us yet. In the bot chat, tap "Share my phone number", then come back and tap Done.', 'bot')
    } catch (e) {
      fail(errorMessage(e), 'bot')
    }
  }

  return { status, error, phone, demoPhone, setDemoPhone, typed: !usingRealApi, share, openBot, recheck }
}
