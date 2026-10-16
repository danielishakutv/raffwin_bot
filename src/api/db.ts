/**
 * Demo "database": a single JSON document in localStorage.
 * The mock API is the only module allowed to touch it. When the real backend
 * arrives this file disappears and src/api/index.ts calls real endpoints.
 */
import type { Entry, Profile, Raffle, Transaction } from '@/data/types'
import { seedRaffles } from '@/data/seed'

export interface DbShape {
  version: 1
  seededAt: string
  profile: Profile | null
  onboardingComplete: boolean
  balance: number
  raffles: Raffle[]
  entries: Entry[]
  transactions: Transaction[]
}

const KEY = 'raffwin.demo.db.v1'
let cache: DbShape | null = null

function createSeed(now: number = Date.now()): DbShape {
  return {
    version: 1,
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
    if (parsed.version !== 1 || !Array.isArray(parsed.raffles)) return null
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
