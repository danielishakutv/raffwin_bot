/**
 * A very short-lived in-process cache for data every player sees the same way
 * (open raffles, their winners and entrants, the global feature switches).
 * Thousands of apps poll every few seconds; with this, one database query per
 * key per `ttlMs` answers all of them, and concurrent misses share one query.
 *
 * Only a fixed handful of keys is ever used, so nothing needs evicting.
 * A failed load is not cached: the next caller tries again. Each API process
 * has its own copy; data is at most `ttlMs` old in any of them.
 */
export class SharedCache {
  private readonly entries = new Map<string, { at: number; value: unknown }>()
  private readonly pending = new Map<string, Promise<unknown>>()
  /** Bumped by invalidate: a load that started before a change never stores its older answer */
  private readonly generation = new Map<string, number>()
  private hits = 0
  private loads = 0

  constructor(
    readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && this.clock() - hit.at < this.ttlMs) {
      this.hits += 1
      return hit.value as T
    }
    const inFlight = this.pending.get(key)
    if (inFlight) {
      this.hits += 1
      return inFlight as Promise<T>
    }
    this.loads += 1
    const started = this.clock()
    const gen = this.generation.get(key) ?? 0
    const p = load().then(
      (value) => {
        if ((this.generation.get(key) ?? 0) === gen) this.entries.set(key, { at: started, value })
        return value
      },
      (error: unknown) => {
        this.entries.delete(key)
        throw error
      },
    )
    this.pending.set(key, p)
    try {
      return await p
    } finally {
      if (this.pending.get(key) === p) this.pending.delete(key)
    }
  }

  /** Drop one key (after a change this process made), so its next reader loads fresh. */
  invalidate(key: string): void {
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1)
    this.entries.delete(key)
    this.pending.delete(key)
  }

  /** Answers served from memory vs database loads, since start (for the capacity view) */
  stats(): { hits: number; loads: number } {
    return { hits: this.hits, loads: this.loads }
  }
}

/** After a raffle changed on this process (edit, open, cancel, draw): its next poll reads fresh */
export function forgetRaffles(cache: SharedCache | undefined): void {
  cache?.invalidate(CACHE_KEYS.liveRaffles)
  cache?.invalidate(CACHE_KEYS.publicRaffles)
}

export const CACHE_KEYS = {
  liveRaffles: 'live:raffles',
  publicRaffles: 'raffles:public',
  globalFlags: 'flags:global',
  overrideUsers: 'flags:override-users',
} as const
