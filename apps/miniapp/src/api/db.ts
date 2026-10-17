/**
 * Demo "database": a single JSON document in localStorage.
 * The mock API is the only module allowed to touch it. When the real backend
 * arrives this file disappears and src/api/index.ts calls real endpoints.
 */
import type { Entry, Profile, Raffle, Transaction, TransferResult } from '@/data/types'
import type { FeatureMap } from '@raffwin/shared'
import { seedRaffles } from '@/data/seed'

export interface DbShape {
  version: 2
  seededAt: string
  profile: Profile | null
  onboardingComplete: boolean
  balance: number
  raffles: Raffle[]
  entries: Entry[]
  transactions: Transaction[]
  /*
   * Added with the engagement features. Optional so a demo database saved by
   * an older build keeps its account and history: missing = the default.
   */
  /** Demo switches over the demo defaults (see mock.ts demoFeatures) */
  features?: Partial<FeatureMap>
  /** Daily streak claims, newest first; day is a Lagos YYYY-MM-DD */
  checkins?: { day: string; streak: number }[]
  /** Sent Raffs, newest first, with the idempotency key that made each one */
  transfers?: { key: string; result: TransferResult }[]
}

const KEY = 'raffwin.demo.db.v2'
let cache: DbShape | null = null

function createSeed(now: number = Date.now()): DbShape {
  return {
    version: 2,
    seededAt: new Date(now).toISOString(),
    profile: null,
    onboardingComplete: false,
    balance: 0,
    raffles: seedRaffles(now),
    entries: [],
    transactions: [],
  }
}

function readStorage(): DbShape | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DbShape>
    if (parsed.version !== 2 || !Array.isArray(parsed.raffles)) return null
    return parsed as DbShape
  } catch (error) {
    console.warn('[db] could not read demo database, reseeding', error)
    return null
  }
}

export function loadDb(): DbShape {
  if (cache) return cache
  cache = readStorage() ?? createSeed()
  saveDb(cache)
  return cache
}

export function saveDb(db: DbShape): void {
  cache = db
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch (error) {
    // Most likely quota (large images). The in-memory copy keeps working.
    console.warn('[db] could not persist demo database', error)
  }
}

export function mutateDb<T>(fn: (db: DbShape) => T): T {
  const db = loadDb()
  const result = fn(db)
  saveDb(db)
  return result
}

export function resetDb(): DbShape {
  cache = createSeed()
  saveDb(cache)
  return cache
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}
