/**
 * Client state. Data comes from the API layer (src/api) and is cached here;
 * only user settings are persisted by the store itself. Replacing the mock
 * API with real endpoints does not change this file.
 */
import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as api from '@/api'
import type {
  LiveSnapshot,
  ContactPrefs,
  Entry,
  Profile,
  Raffle,
  KycInput,
  Transaction,
  VerificationStatus,
  WinnerSlot,
} from '@/data/types'
import { bumpDemoRate, isRateValid, type RateQuote } from '@/services/rates'
import { sound } from '@/services/sound'

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

  boot: () => Promise<void>
  /** Merges a polled snapshot; fetches full data only for what it shows has changed */
  applyLive: (live: LiveSnapshot) => Promise<void>
  /** Full reload of everything (used when the app comes back to the foreground) */
  refreshAll: () => Promise<void>
  setLiveError: (message: string | null) => void
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
  submitVerification: (input: { idImage: string; selfieImage: string }) => Promise<void>
  setVerificationStatus: (status: VerificationStatus) => Promise<void>
  resetDemo: () => Promise<void>
  signOut: () => Promise<void>
  setMuted: (muted: boolean) => void
  setMusic: (music: boolean) => void
  markSwipeHintSeen: () => void
}

let rateInFlight: Promise<void> | null = null
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

      async applyLive(live) {
        const { raffles, balance } = get()
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
          set({ raffles: await api.getRaffles() })
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
        set({ ...data })
      },

      setLiveError(message) {
        if (get().liveError !== message) set({ liveError: message })
      },

      async boot() {
        if (get().booting) return
        set({ booting: true, bootError: null })
        try {
          const data = await api.getBootstrap()
          set({ ...data, booted: true, booting: false })
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
        set({ ...data, settings: { ...get().settings, swipeHintSeen: false } })
      },

      async signOut() {
        await api.signOut()
        const data = await api.getBootstrap()
        set({ ...data })
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
