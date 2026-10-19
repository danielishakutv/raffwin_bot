/* ----------------------------------------------------------------------------
 * Feature switches
 *
 * Every switchable feature is listed here, once. A super admin turns each one
 * on or off for everyone (feature_flags) and can override that for single
 * players (feature_flag_overrides): effective = the player's override if
 * there is one, else the global switch, else defaultEnabled.
 *
 * Adding a feature: add an entry here, check isFeatureOn() where the feature
 * acts (the API refuses with FEATURE_OFF when it is off) and read
 * `features[key]` in the app to show or hide it. Nothing else changes: the
 * admin's Features tab lists whatever is in this registry, and the core
 * modules (raffles, entries, wallet, referrals, KYC) never depend on a switch.
 * -------------------------------------------------------------------------- */

export interface FeatureDefinition {
  /** Shown in the admin */
  name: string
  description: string
  /** Before a super admin has touched the switch */
  defaultEnabled: boolean
  /** player: something players see and use; automation: something the bot or server does */
  audience: 'player' | 'automation'
  /**
   * Suggested bot message to every player when the feature is turned on for
   * everyone (the admin can edit it, or send nothing). Null = nothing to announce.
   */
  announce: string | null
}

export const FEATURES = {
  raffs_transfer: {
    name: 'Send Raffs',
    description: 'Players send Raffs from their balance to another player by username. Both need a verified phone; a daily cap applies (Settings).',
    defaultEnabled: false,
    audience: 'player',
    announce: 'New on Raffle Win: you can now send Raffs to a friend. Open the Wallet and tap Send Raffs.',
  },
  daily_streak: {
    name: 'Daily streak',
    description: 'Players claim a small Raffs bonus once a day; coming back on consecutive days grows the bonus (rewards in Settings).',
    defaultEnabled: false,
    audience: 'player',
    announce: 'New on Raffle Win: daily streaks. Open the app every day to claim free Raffs, and keep your streak going for bigger rewards.',
  },
  reminders: {
    name: 'Bot reminders',
    description: 'The bot reminds players who have not opened the app for 6 to 10 hours (randomised), with a different message each time. Never during quiet hours.',
    defaultEnabled: true,
    audience: 'automation',
    announce: null,
  },
  comeback_offer: {
    name: 'Come-back offer',
    description: 'After 2 days away, the bot offers 1 free Raff, credited the next time the player opens the app.',
    defaultEnabled: true,
    audience: 'automation',
    announce: null,
  },
  new_raffle_alerts: {
    name: 'New raffle alerts',
    description: 'The bot messages players when a new raffle opens.',
    defaultEnabled: true,
    audience: 'automation',
    announce: null,
  },
  draw_reminders: {
    name: 'Draw reminders',
    description:
      'The bot messages 1 hour, 30 minutes and 5 minutes before each draw: entrants hear how many tickets they hold; everyone else with new raffle alerts on gets a last chance to enter (never in quiet hours).',
    defaultEnabled: true,
    audience: 'automation',
    announce: null,
  },
  require_phone_for_entry: {
    name: 'Phone needed to enter',
    description: 'Players must share their phone number through Telegram before entering a raffle, so winners can always be reached.',
    defaultEnabled: true,
    audience: 'player',
    announce: null,
  },
} as const satisfies Record<string, FeatureDefinition>

export type FeatureKey = keyof typeof FEATURES
export type FeatureMap = Record<FeatureKey, boolean>

export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[]

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FEATURES, value)
}

/** Every feature at its default: what a fresh install (and the demo app) uses. */
export function defaultFeatures(): FeatureMap {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, FEATURES[k].defaultEnabled])) as FeatureMap
}
