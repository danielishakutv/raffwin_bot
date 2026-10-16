/**
 * /v1 routes for the Mini App. Each handler: parse with the shared schema,
 * call a service, return the shared shape. Errors go to errorHandler.
 */
import { Router } from 'express'
import {
  addressBody,
  contactPrefsBody,
  profilePatchBody,
  refreshBody,
  signUpBody,
  telegramAuthBody,
  usernameQuery,
} from '@raffwin/shared/schemas'
import { validateUsername } from '@raffwin/shared'
import type { Request } from 'express'
import type { AppContext } from '../context'
import * as account from '../services/account'
import * as auth from '../services/auth'
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

  return router
}
