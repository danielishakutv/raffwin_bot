import { pino } from 'pino'
import supertest from 'supertest'
import { afterAll, inject } from 'vitest'
import { createApp } from '../src/app'
import { loadConfig, type Config } from '../src/config'
import type { AppContext } from '../src/context'
import { createDb } from '../src/db/client'
import { AccessTokens } from '../src/lib/access-token'
import { signTelegramData } from '../src/lib/telegram-auth'

export const BOT_TOKEN = '1234567890:TEST-token-for-signing-initdata-only'
/** 32 zero bytes, base64url: only ever used to encrypt test TOTP secrets */
export const TEST_ADMIN_DATA_KEY = Buffer.alloc(32).toString('base64url')

/**
 * Real time plus an offset: tests move time instead of sleeping. (A frozen
 * clock would disagree with data the tests build from Date.now().)
 */
export class Clock {
  private offsetMs = 0
  now = () => Date.now() + this.offsetMs
  advance(seconds: number) {
    this.offsetMs += seconds * 1000
  }
}

export function testApp(overrides: Partial<Record<keyof Config, string>> = {}) {
  const handle = createDb(inject('testDatabaseUrl'), { searchPath: inject('testSchema'), max: 4 })
  afterAll(() => handle.close())
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: inject('testDatabaseUrl'),
    BOT_TOKEN,
    BOT_USERNAME: 'raffwin_test_bot',
    JWT_SECRET: 'x'.repeat(48),
    IP_HASH_SALT: 'test-salt-test-salt',
    ADMIN_DATA_KEY: TEST_ADMIN_DATA_KEY,
    ...overrides,
  })
  const clock = new Clock()
  const ctx: AppContext = {
    config,
    db: handle.db,
    log: pino({ level: 'silent' }),
    tokens: new AccessTokens(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS),
    now: clock.now,
  }
  const app = createApp(ctx, { rateLimits: { global: 10_000, auth: 10_000 } })
  return { app, ctx, clock, http: supertest(app), db: handle.db }
}

let nextTelegramId = 7_000_000_000 + Math.floor(Math.random() * 1_000_000) * 100

/** A fresh Telegram id per call, unique across runs sharing one database. */
export function telegramId(): number {
  nextTelegramId += 1
  return nextTelegramId
}

/** initData exactly as a Telegram client would send it, signed with BOT_TOKEN. */
export function initData(
  user: { id: number; first_name?: string; username?: string },
  opts: { authDate?: number; startParam?: string; token?: string } = {},
): string {
  const fields: Record<string, string> = {
    query_id: `AAH${user.id}`,
    user: JSON.stringify({ first_name: 'Ada', ...user }),
    auth_date: String(opts.authDate ?? Math.floor(Date.now() / 1000)),
    ...(opts.startParam ? { start_param: opts.startParam } : {}),
  }
  fields.hash = signTelegramData(fields, opts.token ?? BOT_TOKEN)
  return new URLSearchParams(fields).toString()
}

/** The `response` string of WebApp.requestContact, signed with BOT_TOKEN. */
export function contactProof(
  userId: number,
  phone: string,
  opts: { authDate?: number; token?: string } = {},
): string {
  const fields: Record<string, string> = {
    contact: JSON.stringify({ user_id: userId, phone_number: phone, first_name: 'Ada' }),
    auth_date: String(opts.authDate ?? Math.floor(Date.now() / 1000)),
  }
  fields.hash = signTelegramData(fields, opts.token ?? BOT_TOKEN)
  return new URLSearchParams(fields).toString()
}

/** A unique valid Nigerian mobile number per call. */
let phoneSeq = Math.floor(Math.random() * 9_000_000)
export function nigerianPhone(): string {
  phoneSeq += 1
  return `+234803${String(phoneSeq).padStart(7, '0')}`
}

export function uniqueUsername(prefix = 'u'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}
