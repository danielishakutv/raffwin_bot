/**
 * The HTTP app. Apache serves the built site and passes /api here. Nothing
 * here sends CORS headers: the pages and the API share one origin, and no
 * other site may call it from a browser.
 */
import { randomUUID } from 'node:crypto'
import express, { type Express, type RequestHandler } from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import { sql } from 'drizzle-orm'
import type { AppContext } from './context'
import { HttpError } from './lib/util'
import { recordSecurity } from './services/security'
import { clientIp, errorHandler, requestMeta, sameSiteWrites } from './http/middleware'
import { apiRoutes } from './http/routes'
import { webhookRoutes } from './http/webhook'

export interface AppOptions {
  /** Requests per minute per address */
  rateLimits?: { global: number; login: number; checkout: number }
}

export function createApp(ctx: AppContext, options: AppOptions = {}): Express {
  const limits = options.rateLimits ?? { global: 300, login: 20, checkout: 10 }
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', ctx.config.TRUST_PROXY === 'false' ? false : ctx.config.TRUST_PROXY)

  app.use(
    pinoHttp({
      logger: ctx.log,
      genReqId: (_req, res) => {
        const id = randomUUID()
        res.setHeader('X-Request-Id', id)
        return id
      },
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  )
  app.use(helmet())

  const limiter = (perMinute: number, name: string): RequestHandler =>
    rateLimit({
      windowMs: 60_000,
      limit: perMinute,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: (req) => ipKeyGenerator(clientIp(ctx, req) ?? 'unknown'),
      handler: (req, res) => {
        void recordSecurity(ctx, { kind: `ratelimit_${name}`, severity: 'low', ipHash: requestMeta(ctx, req).ipHash })
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a minute and try again.' } })
      },
    })

  app.get('/api/health', async (_req, res) => {
    let db: 'up' | 'down' = 'up'
    try {
      await ctx.db.execute(sql`select 1`)
    } catch (error) {
      ctx.log.error({ err: error }, 'health: database unreachable')
      db = 'down'
    }
    res.status(db === 'up' ? 200 : 503).json({ ok: db === 'up', db, commit: ctx.config.GIT_COMMIT })
  })

  // Before the JSON parser: the signature covers the raw body
  app.use('/api', limiter(limits.global, 'global'))
  app.use('/api', webhookRoutes(ctx))

  app.use(express.json({ limit: '8kb' }))
  app.use('/api/auth', limiter(limits.login, 'login'))
  app.use('/api/checkout', limiter(limits.checkout, 'checkout'))
  app.use('/api', sameSiteWrites(ctx), apiRoutes(ctx))

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Not found.')))
  app.use(errorHandler(ctx))
  return app
}
