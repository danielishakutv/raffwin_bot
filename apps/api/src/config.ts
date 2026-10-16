/**
 * Environment, parsed once at start-up. A missing or malformed value stops the
 * process with the variable's name, rather than surfacing later as a 500.
 * See .env.example for every variable and what it is for.
 */
import { z } from 'zod'

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  /** Bind address. Production sits behind Apache on the same host, so loopback only. */
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().url(),
  /** Token of the bot that hosts the Mini App; initData is signed with it. */
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'BOT_TOKEN does not look like a BotFather token'),
  BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).default('raffwin_bot'),
  /** HS256 key for access tokens. Generate with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" */
  JWT_SECRET: z.string().min(43, 'JWT_SECRET must be at least 32 random bytes (43 base64url characters)'),
  /** Salt for hashing IP addresses in logs and security events, never stored raw. */
  IP_HASH_SALT: z.string().min(16),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  /** initData older than this is refused. Telegram signs auth_date when the Mini App opens. */
  INITDATA_MAX_AGE_SECONDS: z.coerce.number().int().min(60).default(60 * 60),
  /**
   * true: each initData string may be exchanged for a session once.
   * false (default): reuse inside the age window is allowed but recorded as a
   * security event, so a reload inside Telegram does not lock the user out.
   */
  INITDATA_SINGLE_USE: bool.default(false),
  /** Comma-separated origins allowed to call the API from a browser. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** Express "trust proxy": 'loopback' when Apache on the same host forwards requests. */
  TRUST_PROXY: z.string().default('loopback'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Git commit, set by the deploy script; reported by /health. */
  GIT_COMMIT: z.string().default('unknown'),

  /* Admin ------------------------------------------------------------------ */
  /** 32 random bytes, base64url: encrypts admin TOTP secrets at rest. Same generator as JWT_SECRET with 32. */
  ADMIN_DATA_KEY: z.string().length(43, 'ADMIN_DATA_KEY must be 32 random bytes, base64url (43 characters)'),
  ADMIN_SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  ADMIN_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  /**
   * Cloudflare Access in front of admin.rafflewin.com.ng (email one-time code).
   * Team domain, e.g. rafflewin.cloudflareaccess.com, and the application AUD tag.
   * Required in staging and production: the admin API refuses requests without a valid Access token.
   */
  CF_ACCESS_TEAM_DOMAIN: z.string().optional(),
  CF_ACCESS_AUD: z.string().optional(),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema
    .superRefine((c, ctx) => {
      if ((c.NODE_ENV === 'production' || c.NODE_ENV === 'staging') && (!c.CF_ACCESS_TEAM_DOMAIN || !c.CF_ACCESS_AUD)) {
        ctx.addIssue({
          code: 'custom',
          path: ['CF_ACCESS_AUD'],
          message: 'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required in staging and production',
        })
      }
    })
    .safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`Invalid API environment:\n${lines.join('\n')}`)
  }
  return parsed.data
}
