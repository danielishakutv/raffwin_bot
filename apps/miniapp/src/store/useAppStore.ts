/**
 * Client state. Data comes from the API layer (src/api) and is cached here;
 * only user settings are persisted by the store itself. Replacing the mock
 * API with real endpoints does not change this file.
 */
import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { defaultFeatures, FEATURE_KEYS, type FeatureMap } from '@raffwin/shared'
import * as api from '@/api'
import type {
  Bootstrap,
  LiveSnapshot,
  ContactPrefs,
  Entry,
  Profile,
  Raffle,
  KycInput,
  StreakState,
  Transaction,
  TransferResult,
  VerificationStatus,
  WinnerSlot,
} from '@/data/types'
import { bumpDemoRate, isRateValid, type RateQuote } from '@/services/rates'
import { sound } from '@/services/sound'
import { useToast } from '@/components/ui/toastStore'

export type RateStatus = 'idle' | 'loading' | 'ready' | 'expired' | 'error'

export interface Settings {
  muted: boolean
  music: boolean
  swipeHintSeen: boolean
}

export interface AppState {
  booted: boolean
  booting: boolean
  bootError: string | null
  /** Why live updates are paused (shown in the app), or null while they flow */
  liveError: string | null
  profile: Profile | null
  onboardingComplete: boolean
  balance: number
  raffles: Raffle[]
  entries: Entry[]
  transactions: Transaction[]
  rate: RateQuote | null
  rateStatus: RateStatus
  settings: Settings
  /** Effective feature switches for this player: from bootstrap, then every live poll */
  features: FeatureMap
  /** Raffs a come-back offer just credited, until the app has said so once */
  welcomeBack: { raffs: number } | null
  /** Daily streak (feature daily_streak); null until loaded */
  streak: StreakState | null

  boot: () => Promise<void>
  /** Merges a polled snapshot; fetches full data only for what it shows has changed */
  applyLive: (live: LiveSnapshot) => Promise<void>
  /** Full reload of everything (used when the app comes back to the foreground) */
  refreshAll: () => Promise<void>
  setLiveError: (message: string | null) => void
  /** The welcome-back message has been shown */
  consumeWelcomeBack: () => void
  saveKyc: (input: KycInput) => Promise<void>
  completeOnboarding: () => Promise<void>
  refreshRate: () => Promise<void>
  /** Called every second by the rate lifecycle hook. */
  tickRate: (now: number) => void
  /** Demo control: expire the current quote so a new one is fetched. */
  expireRateNow: () => void
  refreshRaffles: () => Promise<void>
  /** idempotencyKey: one per confirmation, reused on retry, so a lost reply never makes a second entry */
  enterRaffle: (raffleId: string, qty: number, idempotencyKey: string, priceRaffs?: number) => Promise<api.EnterRaffleResponse>
  drawRaffle: (raffleId: string) => Promise<{ raffle: Raffle; youWon: boolean }>
  buyRaffs: (req: Omit<api.BuyRaffsRequest, 'rateId'>) => Promise<api.BuyRaffsResponse>
  updateProfile: (patch: Partial<Pick<Profile, 'fullName' | 'phone' | 'email' | 'username'>>) => Promise<void>
  updateContactPrefs: (prefs: ContactPrefs) => Promise<void>
  /** Saves the phone from a Telegram contact share (demo: a typed number) */
  savePhone: (contactProof: string) => Promise<Profile>
  /** Re-reads the profile (after the player shared their phone in the bot chat) */
  refreshProfile: () => Promise<Profile>
  setReminders: (on: boolean) => Promise<void>
  loadStreak: () => Promise<StreakState>
  claimStreak: () => Promise<{ raffs: number; state: StreakState }>
  /** idempotencyKey: one per confirmation, reused on retry, so a lost reply never sends twice */
  sendRaffs: (req: api.SendRaffsRequest) => Promise<TransferResult>
  /** Demo control: what a super admin's feature switch does */
  setDemoFeature: (key: keyof FeatureMap, on: boolean) => Promise<void>
  submitVerification: (input: { idImage: string; selfieImage: string }) => Promise<void>
  setVerificationStatus: (status: VerificationStatus) => Promise<void>
  resetDemo: () => Promise<void>
  signOut: () => Promise<void>
  setMuted: (muted: boolean) => void
  setMusic: (music: boolean) => void
  markSwipeHintSeen: () => void
}

let rateInFlight: Promise<void> | null = null
let streakInFlight: Promise<StreakState> | null = null

function sameFeatures(a: FeatureMap, b: FeatureMap): boolean {
  return FEATURE_KEYS.every((k) => a[k] === b[k])
}

/**
 * The store's part of a bootstrap. A come-back credit is kept until shown
 * (a later bootstrap without one must not erase it), and a bootstrap from an
 * API that predates feature switches leaves every feature at its default.
 */
function fromBootstrap(data: Bootstrap, current: AppState) {
  const { welcomeBack, features, ...rest } = data
  const nextFeatures = features ?? defaultFeatures()
  return {
    ...rest,
    features: sameFeatures(nextFeatures, current.features) ? current.features : nextFeatures,
    welcomeBack: welcomeBack ?? current.welcomeBack,
  }
}
/** Raffle content versions from the previous live poll (null until the first one) */
let liveVersions: Map<string, string> | null = null

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      booted: false,
      booting: false,
      bootError: null,
      liveError: null,
      profile: null,
      onboardingComplete: false,
      balance: 0,
      raffles: [],
      entries: [],
      transactions: [],
      rate: null,
      rateStatus: 'idle',
      settings: { muted: false, music: false, swipeHintSeen: false },
      features: defaultFeatures(),
      welcomeBack: null,
      streak: null,

      async applyLive(live) {
        const { raffles, balance, features } = get()
        // A feature switched on or off shows or hides its screens within seconds
        if (live.features && !sameFeatures(live.features, features)) {
          set({ features: live.features, ...(live.features.daily_streak ? {} : { streak: null }) })
        }
        const known = new Map(raffles.map((r) => [r.id, r]))
        const seen = liveVersions
        liveVersions = new Map(live.raffles.map((l) => [l.id, l.version]))
        // A raffle that appeared, disappeared, was drawn or was edited by an admin needs its full record.
        // The first poll after opening has nothing to compare with, so it reloads once.
        const structural =
          seen === null ||
          live.raffles.length !== raffles.length ||
          live.raffles.some((l) => {
            const k = known.get(l.id)
            return !k || (k.drawnAt ?? null) !== (l.drawnAt ?? null) || seen.get(l.id) !== l.version
          })
        if (structural) {
          const next = await api.getRaffles()
          // A raffle I entered that closed and vanished undrawn was refunded (too few entries to draw)
          const refunded = raffles.filter(
            (r) => !r.drawnAt && Date.parse(r.deadline) <= Date.now() && !next.some((n) => n.id === r.id) && get().entries.some((e) => e.raffleId === r.id),
          )
          set({ raffles: next })
          for (const r of refunded) {
            useToast.getState().show(`${r.prizeName} did not get enough entries to be drawn. Your Raffs for it are back in your balance.`, 'info')
          }
        } else {
          const byId = new Map(live.raffles.map((l) => [l.id, l]))
          const changed = raffles.some((r) => {
            const l = byId.get(r.id)
            return !!l && (l.entriesCount !== r.entriesCount || l.entriesTarget !== r.entriesTarget || l.deadline !== r.deadline)
          })
          if (changed) {
            set({
              raffles: raffles.map((r) => {
                const l = byId.get(r.id)
                return l ? { ...r, entriesCount: l.entriesCount, entriesTarget: l.entriesTarget, deadline: l.deadline } : r
              }),
            })
          }
        }
        if (live.balance !== balance) {
          // Money moved (an entry elsewhere, a referral payout, an approved credit): show the new lines too
          const [transactions, entries] = await Promise.all([api.getTransactions(), api.getEntries()])
          set({ balance: live.balance, transactions, entries })
        }
      },

      async refreshAll() {
        const data = await api.getBootstrap()
        set(fromBootstrap(data, get()))
        // The streak may have rolled over to a new day while the app was in the background
        if (get().features.daily_streak && get().streak) {
          get().loadStreak().catch((error: unknown) => console.warn('[streak] reload after returning failed', error))
        }
      },

      setLiveError(message) {
        if (get().liveError !== message) set({ liveError: message })
      },

      consumeWelcomeBack() {
        set({ welcomeBack: null })
      },

      async boot() {
        if (get().booting) return
        set({ booting: true, bootError: null })
        try {
          const data = await api.getBootstrap()
          set({ ...fromBootstrap(data, get()), booted: true, booting: false })
        } catch (error) {
          set({ booting: false, bootError: error instanceof Error ? error.message : 'Could not load the app.' })
        }
      },

      async saveKyc(input) {
        const profile = await api.saveKyc(input)
        set({ profile })
      },

      async completeOnboarding() {
        const res = await api.completeOnboarding()
        set({ onboardingComplete: res.onboardingComplete })
      },

      async refreshRate() {
        if (rateInFlight) return rateInFlight
        set({ rateStatus: 'loading' })
        rateInFlight = (async () => {
          try {
            const quote = await api.getRate()
            set({ rate: quote, rateStatus: isRateValid(quote) ? 'ready' : 'expired' })
          } catch (error) {
            console.warn('[rate] fetch failed', error)
            set({ rateStatus: 'error' })
          } finally {
            rateInFlight = null
          }
        })()
        return rateInFlight
      },

      tickRate(now) {
        const { rate, rateStatus } = get()
        if (rateStatus === 'ready' && rate && now >= rate.expiresAt) {
          set({ rateStatus: 'expired' })
          void get().refreshRate()
        } else if ((rateStatus === 'idle' || rateStatus === 'error') && !rateInFlight) {
          void get().refreshRate()
        }
      },

      expireRateNow() {
        bumpDemoRate()
        const { rate } = get()
        if (rate) set({ rate: { ...rate, expiresAt: Date.now() } })
        set({ rateStatus: 'expired' })
        void get().refreshRate()
      },

      async refreshRaffles() {
        const raffles = await api.getRaffles()
        set({ raffles })
      },

      async enterRaffle(raffleId, qty, idempotencyKey, priceRaffs) {
        const res = await api.enterRaffle({ raffleId, qty, idempotencyKey, priceRaffs })
        set((s) => ({
          balance: res.balance,
          raffles: s.raffles.map((r) => (r.id === res.raffle.id ? res.raffle : r)),
          entries: [res.entry, ...s.entries],
          transactions: [res.transaction, ...s.transactions],
        }))
        return res
      },

      async drawRaffle(raffleId) {
        const res = await api.drawRaffle(raffleId)
        const transactions = await api.getTransactions()
        set((s) => ({
          balance: res.balance,
          raffles: s.raffles.map((r) => (r.id === res.raffle.id ? res.raffle : r)),
          transactions,
        }))
        return { raffle: res.raffle, youWon: res.youWon }
      },

      async buyRaffs(req) {
        const { rate } = get()
        if (!isRateValid(rate)) throw new Error('The rate is refreshing. One moment.')
        try {
          const res = await api.buyRaffs({ ...req, rateId: rate.id })
          set((s) => ({ balance: res.balance, transactions: [res.transaction, ...s.transactions] }))
          return res
        } catch (error) {
          const transactions = await api.getTransactions()
          set({ transactions })
          throw error
        }
      },

      async updateProfile(patch) {
        const profile = await api.updateProfile(patch)
        set({ profile })
      },


      async updateContactPrefs(prefs) {
        const profile = await api.updateContactPrefs(prefs)
        set({ profile })
      },

      async savePhone(contactProof) {
        const profile = await api.savePhone(contactProof)
        set({ profile })
        return profile
      },

      async refreshProfile() {
        const profile = await api.getProfile()
        set({ profile })
        return profile
      },

      async setReminders(on) {
        const profile = await api.setReminders(on)
        set({ profile })
      },

      async loadStreak() {
        if (streakInFlight) return streakInFlight
        streakInFlight = api
          .getStreak()
          .then((streak) => {
            set({ streak })
            return streak
          })
          .finally(() => {
            streakInFlight = null
          })
        return streakInFlight
      },

      async claimStreak() {
        const res = await api.claimStreak()
        set({ streak: res.state, balance: res.balance })
        // Show the bonus line in the history (setting the balance stops the live poll from doing it)
        api.getTransactions().then(
          (transactions) => set({ transactions }),
          (error: unknown) => console.warn('[streak] could not reload transactions after a claim', error),
        )
        return { raffs: res.raffs, state: res.state }
      },

      async sendRaffs(req) {
        const res = await api.sendRaffs(req)
        set({ balance: res.balance })
        api.getTransactions().then(
          (transactions) => set({ transactions }),
          (error: unknown) => console.warn('[transfer] could not reload transactions after sending', error),
        )
        return res
      },

      async setDemoFeature(key, on) {
        const features = await api.setDemoFeature(key, on)
        set({ features, ...(features.daily_streak ? {} : { streak: null }) })
      },

      async submitVerification(input) {
        const profile = await api.submitVerification(input)
        set({ profile })
      },

      async setVerificationStatus(status) {
        const profile = await api.setVerificationStatus(status)
        set({ profile })
      },

      async resetDemo() {
        const data = await api.resetDemo()
        set({ ...fromBootstrap(data, get()), streak: null, settings: { ...get().settings, swipeHintSeen: false } })
      },

      async signOut() {
        await api.signOut()
        const data = await api.getBootstrap()
        set({ ...fromBootstrap(data, get()), streak: null, welcomeBack: null })
      },

      setMuted(muted) {
        set((s) => ({ settings: { ...s.settings, muted } }))
        sound.setMuted(muted)
      },

      setMusic(music) {
        set((s) => ({ settings: { ...s.settings, music } }))
        sound.setMusicEnabled(music)
      },

      markSwipeHintSeen() {
        set((s) => ({ settings: { ...s.settings, swipeHintSeen: true } }))
      },
    }),
    {
      name: 'raffwin.settings.v1',
      partialize: (state) => ({ settings: state.settings }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        sound.muted = state.settings.muted
        sound.musicEnabled = state.settings.music
      },
    },
  ),
)

/* ----------------------------------------------------------------------------
 * Derived data
 * Note: selectors passed to useAppStore must return stable references (Zustand
 * v5 uses useSyncExternalStore). Anything that builds a new array/object goes
 * through useMemo in a hook instead.
 * -------------------------------------------------------------------------- */

export interface Win {
  raffle: Raffle
  slot: WinnerSlot
}

export function getMyWins(raffles: Raffle[], username: string | null | undefined): Win[] {
  if (!username) return []
  return raffles
    .filter((r) => r.drawnAt && r.winners.some((w) => w.username === username))
    .map((r) => ({ raffle: r, slot: r.winners.find((w) => w.username === username) as WinnerSlot }))
    .sort((a, b) => new Date(b.raffle.drawnAt as string).getTime() - new Date(a.raffle.drawnAt as string).getTime())
}

/** The signed-in user's wins, memoised on the raffle list and username. */
export function useMyWins(): Win[] {
  const raffles = useAppStore((s) => s.raffles)
  const username = useAppStore((s) => s.profile?.username ?? null)
  return useMemo(() => getMyWins(raffles, username), [raffles, username])
}
