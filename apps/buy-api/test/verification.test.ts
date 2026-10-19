/**
 * The three signatures this site depends on: Telegram's login widget, the
 * Paystack webhook, and (to show the two Telegram schemes cannot be swapped)
 * a Mini App initData signature, which the widget check must refuse.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loginDataCheckString, signTelegramLogin, verifyTelegramLogin } from '../src/lib/telegram-login'
import { paystackSignature, verifyPaystackSignature } from '../src/lib/paystack'
import { LOGIN_BOT_TOKEN, PAYSTACK_KEY, widgetLogin } from './helpers'

const NOW = Date.UTC(2026, 9, 19, 12)
const at = (secondsAgo: number) => Math.floor(NOW / 1000) - secondsAgo
const check = (data: unknown) => verifyTelegramLogin(data, LOGIN_BOT_TOKEN, { maxAgeSeconds: 86_400, now: NOW })

describe('Telegram Login Widget', () => {
  it('builds the data-check string from sorted key=value lines, without the hash', () => {
    expect(loginDataCheckString({ username: 'ada', id: '7', auth_date: '9', hash: 'x' })).toBe('auth_date=9\nid=7\nusername=ada')
  })

  it('accepts what Telegram signed, and reads the user', () => {
    const r = check(widgetLogin({ id: 4242, username: 'ada_obi' }, { authDate: at(60) }))
    expect(r).toMatchObject({ ok: true, user: { id: 4242, username: 'ada_obi', firstName: 'Ada' } })
  })

  it('accepts numbers as the widget sends them in JSON', () => {
    const d = widgetLogin({ id: 4242 }, { authDate: at(5) })
    expect(check({ ...d, id: 4242, auth_date: Number(d.auth_date) })).toMatchObject({ ok: true })
  })

  it('refuses a changed field, a wrong bot, a missing hash', () => {
    const d = widgetLogin({ id: 4242, username: 'ada' }, { authDate: at(5) })
    expect(check({ ...d, id: '4243' })).toEqual({ ok: false, reason: 'bad_hash' })
    expect(check({ ...d, username: 'someone_else' })).toEqual({ ok: false, reason: 'bad_hash' })
    expect(check({ ...d, extra: 'field' })).toEqual({ ok: false, reason: 'bad_hash' })
    expect(check(widgetLogin({ id: 4242 }, { authDate: at(5), token: '111:another-bot-token-entirely-xxxxxxxxx' }))).toEqual({ ok: false, reason: 'bad_hash' })
    const { hash: _hash, ...noHash } = d
    expect(check(noHash)).toEqual({ ok: false, reason: 'missing_hash' })
    expect(check({ ...d, hash: d.hash!.toUpperCase() })).toEqual({ ok: false, reason: 'bad_hash' })
  })

  it('refuses a login older than 24 hours or from the future', () => {
    expect(check(widgetLogin({ id: 1 }, { authDate: at(86_401) }))).toEqual({ ok: false, reason: 'expired' })
    expect(check(widgetLogin({ id: 1 }, { authDate: at(86_000) }))).toMatchObject({ ok: true })
    expect(check(widgetLogin({ id: 1 }, { authDate: at(-300) }))).toEqual({ ok: false, reason: 'future' })
  })

  it('refuses nested or odd input', () => {
    expect(check(null)).toEqual({ ok: false, reason: 'malformed' })
    expect(check([])).toEqual({ ok: false, reason: 'malformed' })
    expect(check({ id: { a: 1 }, hash: 'x' })).toEqual({ ok: false, reason: 'malformed' })
  })

  it('does not accept a Mini App initData signature: the secret differs (HMAC of "WebAppData" vs SHA-256 of the token)', () => {
    const fields = { id: '4242', first_name: 'Ada', auth_date: String(at(5)) }
    const webAppKey = createHmac('sha256', 'WebAppData').update(LOGIN_BOT_TOKEN).digest()
    const miniAppHash = createHmac('sha256', webAppKey).update(loginDataCheckString(fields)).digest('hex')
    expect(miniAppHash).not.toBe(signTelegramLogin(fields, LOGIN_BOT_TOKEN))
    expect(check({ ...fields, hash: miniAppHash })).toEqual({ ok: false, reason: 'bad_hash' })
  })
})

describe('Paystack webhook signature', () => {
  const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ip_x' } }))

  it('is HMAC-SHA512 of the raw body with the secret key', () => {
    expect(paystackSignature(body, PAYSTACK_KEY)).toBe(createHmac('sha512', PAYSTACK_KEY).update(body).digest('hex'))
    expect(verifyPaystackSignature(body, paystackSignature(body, PAYSTACK_KEY), PAYSTACK_KEY)).toBe(true)
  })

  it('refuses another key, a changed body, a missing or malformed header', () => {
    expect(verifyPaystackSignature(body, paystackSignature(body, 'sk_test_other_key_entirely_000000'), PAYSTACK_KEY)).toBe(false)
    const changed = Buffer.from(body.toString().replace('ip_x', 'ip_y'))
    expect(verifyPaystackSignature(changed, paystackSignature(body, PAYSTACK_KEY), PAYSTACK_KEY)).toBe(false)
    expect(verifyPaystackSignature(body, undefined, PAYSTACK_KEY)).toBe(false)
    expect(verifyPaystackSignature(body, 'abc', PAYSTACK_KEY)).toBe(false)
    // Re-serialised JSON is a different body: the check is on the bytes as sent
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1))
    expect(verifyPaystackSignature(reserialised, paystackSignature(body, PAYSTACK_KEY), PAYSTACK_KEY)).toBe(false)
  })
})
