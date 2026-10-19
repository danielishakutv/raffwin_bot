/**
 * Environment, parsed once at start-up; a bad value stops the process with
 * the variable's name. Every secret lives here and nowhere else, and so does
 * the main API's address (MAIN_API_URL): it is read on the server only and
 * never sent to a browser, written to a response, or logged.
 */
import { z } from 'zod'
import { MIN_SECRET_LENGTH } from '@raffwin/relay'

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3420),
    /** Apache on the same host forwards /api here: loopback only */
    HOST: z.string().default('127.0.0.1'),
    DATABASE_URL: z.string().url(),
    /** This site's own address, e.g. https://buy.example.ng (Paystack sends buyers back here) */
    PUBLIC_URL: z.string().url(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    GIT_COMMIT: z.string().default('unknown'),
    /** on: this process runs the relay outbox, flag reporter and daily reconciliation */
    WORKERS: z.enum(['on', 'off']).default('on'),
    /** Express "trust proxy"; and where the visitor's address arrives behind Cloudflare */
    TRUST_PROXY: z.string().default('loopback'),
    CLIENT_IP_HEADER: z
      .string()
      .regex(/^[a-z0-9-]{3,64}$/)
      .optional(),
    IP_HASH_SALT: z.string().min(16),

    /* Telegram Login Widget: the login bot, its domain set in BotFather */
    LOGIN_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'LOGIN_BOT_TOKEN does not look like a BotFather token'),
    LOGIN_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
    /** A login older than this is refused (the widget signs auth_date) */
    LOGIN_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(86_400),
    SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    /* Paystack */
    PAYSTACK_SECRET_KEY: z.string().regex(/^sk_(test|live)_[A-Za-z0-9]{20,}$/, 'PAYSTACK_SECRET_KEY must be an sk_test_ or sk_live_ key'),
    PAYSTACK_API_URL: z.string().url().default('https://api.paystack.co'),
    /** Optional: only these addresses may post the webhook (Paystack publishes its list) */
    PAYSTACK_WEBHOOK_IPS: list,

    /* The main API, through the signed relay */
    MAIN_API_URL: z.string().url(),
    RELAY_SECRET: z.string().regex(/^[A-Za-z0-9_-]+$/).min(MIN_SECRET_LENGTH),
    RELAY_PATH: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/),

    /* Rules of sale (owner, 19 Oct) */
    /** A quote can be paid for this long after it was made */
    QUOTE_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
    /** A payment confirmed this long after its quote is credited at the quote; later ones go to an admin */
    CREDIT_WINDOW_MINUTES: z.coerce.number().int().min(30).max(240).default(120),
    /** Lagos hour the daily reconciliation runs, for the day before */
    RECONCILE_HOUR: z.coerce.number().int().min(0).max(23).default(2),
  })
  .superRefine((c, issue) => {
    // Test keys on the test site only, live keys on the live site only
    if (c.NODE_ENV === 'production' && !c.PAYSTACK_SECRET_KEY.startsWith('sk_live_')) {
      issue.addIssue({ code: 'custom', path: ['PAYSTACK_SECRET_KEY'], message: 'production needs an sk_live_ key' })
    }
    if (c.NODE_ENV === 'staging' && !c.PAYSTACK_SECRET_KEY.startsWith('sk_test_')) {
      issue.addIssue({ code: 'custom', path: ['PAYSTACK_SECRET_KEY'], message: 'staging must use an sk_test_ key' })
    }
    const strict = c.NODE_ENV === 'production' || c.NODE_ENV === 'staging'
    if (strict && (!c.PUBLIC_URL.startsWith('https://') || !c.MAIN_API_URL.startsWith('https://'))) {
      issue.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'PUBLIC_URL and MAIN_API_URL must be https' })
    }
  })

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    // Names only, never values: this message reaches the journal
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`Invalid environment:\n${lines.join('\n')}`)
  }
  return parsed.data
}
