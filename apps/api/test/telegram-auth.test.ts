import { readdirSync, readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readInitDataUser, readSharedContact, verifyTelegramData } from '../src/lib/telegram-auth'
import { BOT_TOKEN, contactProof, initData } from './helpers'

const now = Date.now()
const opts = { maxAgeSeconds: 3600, now }

describe('verifyTelegramData', () => {
  it('accepts data signed with the bot token', () => {
    const result = verifyTelegramData(initData({ id: 42, username: 'ada' }), BOT_TOKEN, opts)
    expect(result.ok).toBe(true)
    if (result.ok) expect(readInitDataUser(result.fields)).toMatchObject({ id: 42, username: 'ada' })
  })

  it('matches an independent implementation of the documented algorithm', () => {
    // Re-derives the hash straight from the Telegram docs, without our helper
    const params = new URLSearchParams(initData({ id: 7 }))
    const hash = params.get('hash')
    params.delete('hash')
    const dcs = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
    expect(createHmac('sha256', secret).update(dcs).digest('hex')).toBe(hash)
  })

  it('rejects data signed by another bot', () => {
    const other = initData({ id: 42 }, { token: '999:another-bot-token-another-bot-token' })
    expect(verifyTelegramData(other, BOT_TOKEN, opts)).toEqual({ ok: false, reason: 'bad_hash' })
  })

  it('rejects any edited field', () => {
    const tampered = initData({ id: 42 }).replace('%22id%22%3A42', '%22id%22%3A43')
    expect(tampered).not.toBe(initData({ id: 42 }))
    expect(verifyTelegramData(tampered, BOT_TOKEN, opts)).toMatchObject({ ok: false, reason: 'bad_hash' })
  })

  it('rejects stale and future auth_date', () => {
    const old = initData({ id: 1 }, { authDate: Math.floor(now / 1000) - 3601 })
    expect(verifyTelegramData(old, BOT_TOKEN, opts)).toEqual({ ok: false, reason: 'expired' })
    const future = initData({ id: 1 }, { authDate: Math.floor(now / 1000) + 3600 })
    expect(verifyTelegramData(future, BOT_TOKEN, opts)).toEqual({ ok: false, reason: 'future' })
  })

  it('rejects missing hash and duplicated keys', () => {
    expect(verifyTelegramData('auth_date=1&user=%7B%7D', BOT_TOKEN, opts)).toEqual({ ok: false, reason: 'missing_hash' })
    const doubled = `${initData({ id: 1 })}&auth_date=1`
    expect(verifyTelegramData(doubled, BOT_TOKEN, opts)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('reads a shared contact', () => {
    const result = verifyTelegramData(contactProof(42, '2348031234567'), BOT_TOKEN, opts)
    expect(result.ok).toBe(true)
    if (result.ok) expect(readSharedContact(result.fields)).toMatchObject({ user_id: 42, phone_number: '2348031234567' })
  })
})

describe('migrations', () => {
  // drizzle-kit writes "public"."table" into foreign keys; that pins every
  // table to the public schema and breaks per-run test schemas.
  it('never name the public schema', () => {
    for (const file of readdirSync('drizzle').filter((f) => f.endsWith('.sql'))) {
      expect(readFileSync(`drizzle/${file}`, 'utf8'), file).not.toContain('"public".')
    }
  })
})
