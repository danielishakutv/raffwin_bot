import { randomUUID } from 'node:crypto'
import cors from 'cors'
import express, { type Express, type RequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import { sql } from 'drizzle-orm'
import type { ApiErrorBody } from '@raffwin/shared'
import pkg from '../package.json' with { type: 'json' }
import type { AppContext } from './context'
import { errorHandler, notFound, requestMeta } from './http/middleware'
import { v1Routes } from './http/routes'
import { recordSecurityEvent } from './lib/security-events'

export interface AppOptions {
  /** Requests per minute per IP: all of /v1, and the auth endpoints on their own */
  rateLimits?: { global: number; auth: number }
}

export function createApp(ctx: AppContext, options: AppOptions = {}): Express {
  const limits = options.rateLimits ?? { global: 300, auth: 20 }
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', parseTrustProxy(ctx.config.TRUST_PROXY))

  app.use(
    pinoHttp({
      logger: ctx.log,
      genReqId: (_req, res) => {
        const id = randomUUID()
        res.setHeader('X-Request-Id', id)
        return id
      },
      // Health checks every minute from the watchdog would drown everything else
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  )
  app.use(helmet())
  app.use(
    cors({
      origin: ctx.config.CORS_ORIGINS,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  )
  app.use(express.json({ limit: '16kb' }))

  app.get('/health', async (_req, res) => {
    let db: 'up' | 'down' = 'up'
    try {
      await ctx.db.execute(sql`select 1`)
    } catch (error) {
      ctx.log.error({ err: error }, 'health: database unreachable')
      db = 'down'
    }
    res.status(db === 'up' ? 200 : 503).json({
      ok: db === 'up',
      db,
      env: ctx.config.NODE_ENV,
      version: pkg.version,
      commit: ctx.config.GIT_COMMIT,
    })
  })

  app.use('/v1', limiter(ctx, limits.global, 'global'))
  app.use('/v1/auth', limiter(ctx, limits.auth, 'auth'))
  app.use('/v1', v1Routes(ctx))

  app.use(notFound)
  app.use(errorHandler(ctx))
  return app
}

function limiter(ctx: AppContext, perMinute: number, name: string): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      const meta = requestMeta(ctx, req)
      void recordSecurityEvent(ctx.db, ctx.log, {
        severity: 'low',
        category: 'ratelimit',
        kind: `ratelimit_${name}`,
        ipHash: meta.ipHash,
        route: meta.route,
        requestId: meta.requestId,
        actionTaken: 'throttled',
      })
      const body: ApiErrorBody = {
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a minute and try again.', requestId: meta.requestId },
      }
      res.status(429).json(body)
    },
  })
}

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^\d+$/.test(value)) return Number(value)
  return value
}
