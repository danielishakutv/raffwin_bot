/**
 * /v1 routes for the Mini App. Each handler: parse with the shared schema,
 * call a service, return the shared shape. Errors go to errorHandler.
 */
import { Router } from 'express'
import { z } from 'zod'
import {
  contactPrefsBody,
  cursorQuery,
  enterRaffleBody,
  profilePatchBody,
  kycBody,
  refreshBody,
  telegramAuthBody,
  usernameQuery,
} from '@raffwin/shared/schemas'
import { validateUsername } from '@raffwin/shared'
import type { Request } from 'express'
import type { AppContext } from '../context'
import { HttpError } from '../lib/http-error'
import * as account from '../services/account'
import * as auth from '../services/auth'
import * as entryService from '../services/entries'
import { recentTransactions } from '../services/ledger'
import * as raffles from '../services/raffles'
import { currentQuote, toRateQuote } from '../services/rates'
import * as referrals from '../services/referrals'
import { masterPrompt, startAdminSignIn } from '../bot/admin-login'
import { authOf, requestMeta, requireAuth } from './middleware'

export function v1Routes(ctx: AppContext): Router {
  const router = Router()
  const authed = requireAuth(ctx)
  const me = (req: Request) => authOf(req).user

  /* Auth ------------------------------------------------------------------ */

  router.post('/auth/telegram', async (req, res) => {
    const { initData } = telegramAuthBody.parse(req.body)
    res.json(await auth.loginWithInitData(ctx, initData, requestMeta(ctx, req)))
  })

  router.post('/auth/refresh', async (req, res) => {
    const { refreshToken } = refreshBody.parse(req.body)
    res.json(await auth.refreshSession(ctx, refreshToken, requestMeta(ctx, req)))
  })

  router.post('/auth/logout', authed, async (req, res) => {
    await auth.logout(ctx, authOf(req).sessionId)
    res.status(204).end()
  })

  /* Account --------------------------------------------------------------- */

  router.get('/bootstrap', authed, async (req, res) => {
    res.json(await account.bootstrap(ctx, me(req)))
  })

  router.get('/username-available', authed, async (req, res) => {
    const { username } = usernameQuery.parse(req.query)
    const normalised = username.trim().toLowerCase()
    if (validateUsername(normalised)) {
      res.json({ available: false })
      return
    }
    res.json({ available: await account.isUsernameAvailable(ctx, normalised, me(req).id) })
  })

  // KYC: name, Telegram-verified phone and the motor park to deliver prizes to
  router.put('/kyc', authed, async (req, res) => {
    res.json(await account.saveKyc(ctx, me(req), kycBody.parse(req.body), requestMeta(ctx, req)))
  })

  router.post('/onboarding/complete', authed, async (req, res) => {
    res.json(await account.completeOnboarding(ctx, me(req)))
  })

  router.get('/profile', authed, async (req, res) => {
    res.json(await account.getProfile(ctx, me(req)))
  })

  router.patch('/profile', authed, async (req, res) => {
    res.json(await account.updateProfile(ctx, me(req), profilePatchBody.parse(req.body)))
  })

  router.put('/profile/contact-prefs', authed, async (req, res) => {
    res.json(await account.updateContactPrefs(ctx, me(req), contactPrefsBody.parse(req.body)))
  })

  /* Rate, raffles, entries, wallet history -------------------------------- */

  router.get('/rate', authed, async (_req, res) => {
    res.json(toRateQuote(await currentQuote(ctx.db, ctx.now())))
  })

  // Polled every few seconds by the app: counts, balance and raffle states without a refresh
  router.get('/live', authed, async (req, res) => {
    res.set('cache-control', 'no-store')
    res.json(await raffles.liveSnapshot(ctx.db, me(req), ctx.now()))
  })

  router.get('/raffles', authed, async (req, res) => {
    res.json(await raffles.listForPlayer(ctx.db, me(req).id, ctx.now()))
  })

  router.get('/raffles/:id', authed, async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id)
    if (!id.success) throw new HttpError('NOT_FOUND', 'That raffle no longer exists.')
    res.json(await raffles.getForPlayer(ctx.db, id.data))
  })

  router.post('/entries', authed, async (req, res) => {
    res.status(201).json(await entryService.enterRaffle(ctx, me(req), enterRaffleBody.parse(req.body)))
  })

  router.get('/entries', authed, async (req, res) => {
    res.json(await raffles.entriesForPlayer(ctx.db, me(req).id))
  })

  router.get('/transactions', authed, async (req, res) => {
    res.json(await recentTransactions(ctx.db, me(req).id))
  })

  /* Admin sign-in from the app ------------------------------------------ */

  // The Admin card's button: the bot then asks this account for the master password in the chat
  router.post('/admin-signin', authed, async (req, res) => {
    const user = me(req)
    if (!ctx.config.ADMIN_MASTER_PASSWORD_HASH) throw new HttpError('NOT_READY', 'Admin sign-in is not set up on this server.')
    if (!(await account.isAdminAccount(ctx, user))) throw new HttpError('FORBIDDEN', 'This Telegram account is not an admin.')
    // In a private chat with the bot, the chat id is the user's Telegram id
    const started = await startAdminSignIn(ctx, user.telegramId, user.telegramId, 'app')
    if (started === 'locked') throw new HttpError('RATE_LIMITED', 'Too many failed admin sign-ins. Try again in an hour.')
    if (!ctx.sendTelegram) throw new HttpError('NOT_READY', 'The bot cannot send messages from this server.')
    try {
      await ctx.sendTelegram(user.telegramId, masterPrompt(ctx.config))
    } catch (error) {
      ctx.log.warn({ err: error, telegramId: user.telegramId }, 'admin sign-in prompt not delivered')
      throw new HttpError('SERVER_ERROR', 'The bot could not message you. Open the bot chat, press Start, then try again.')
    }
    res.json({ ok: true })
  })

  /* Referrals ------------------------------------------------------------- */

  router.get('/referrals/summary', authed, async (req, res) => {
    res.json(await referrals.summary(ctx, me(req)))
  })

  router.get('/referrals/people', authed, async (req, res) => {
    res.json(await referrals.people(ctx, me(req), cursorQuery.parse(req.query)))
  })

  router.get('/referrals/earnings', authed, async (req, res) => {
    res.json(await referrals.earnings(ctx, me(req), cursorQuery.parse(req.query)))
  })

  return router
}
