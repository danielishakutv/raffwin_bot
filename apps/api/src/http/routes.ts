/**
 * /v1 routes for the Mini App. Each handler: parse with the shared schema,
 * call a service, return the shared shape. Errors go to errorHandler.
 */
import { Router } from 'express'
import { z } from 'zod'
import {
  addressBody,
  contactPrefsBody,
  cursorQuery,
  enterRaffleBody,
  profilePatchBody,
  refreshBody,
  signUpBody,
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

  router.post('/signup', authed, async (req, res) => {
    const body = signUpBody.parse(req.body)
    res.status(201).json(await account.signUp(ctx, me(req), body, requestMeta(ctx, req)))
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

  router.put('/profile/address', authed, async (req, res) => {
    res.json(await account.updateAddress(ctx, me(req), addressBody.parse(req.body)))
  })

  router.put('/profile/contact-prefs', authed, async (req, res) => {
    res.json(await account.updateContactPrefs(ctx, me(req), contactPrefsBody.parse(req.body)))
  })

  /* Rate, raffles, entries, wallet history -------------------------------- */

  router.get('/rate', authed, async (_req, res) => {
    res.json(toRateQuote(await currentQuote(ctx.db, ctx.now())))
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
