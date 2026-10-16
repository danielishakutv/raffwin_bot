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

  /**
   * The Mini App's own address, e.g. https://test.example.com/ - the
   * bot's buttons open it, and the webhook lives at <it>/api/telegram/webhook.
   */
  PUBLIC_APP_URL: z.string().url().startsWith('https://', 'Telegram only opens Mini Apps over https').optional(),
  /** Telegram sends it back in X-Telegram-Bot-Api-Secret-Token on every update. Unset = no webhook route. */
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{24,256}$/, 'TELEGRAM_WEBHOOK_SECRET: 24-256 of A-Z a-z 0-9 _ -')
    .optional(),

  /* Admin ------------------------------------------------------------------ */
  /**
   * argon2id hash of the master password the bot asks for first. Make it with
   *   pnpm --filter @raffwin/api admin:master-hash
   * Unset = admin sign-in through the bot is switched off.
   */
  ADMIN_MASTER_PASSWORD_HASH: z.string().startsWith('$argon2id$').optional(),
  /** The hidden bot command that starts admin sign-in (never listed in the bot's menu) */
  ADMIN_BOT_COMMAND: z.string().regex(/^[a-z0-9_]{4,32}$/, 'ADMIN_BOT_COMMAND: 4-32 of a-z 0-9 _').default('staffdesk'),
  /** Optional, 32 random bytes base64url: reserved for encrypting admin secrets at rest (unused since codes were dropped) */
  ADMIN_DATA_KEY: z.string().length(43, 'ADMIN_DATA_KEY must be 32 random bytes, base64url (43 characters)').optional(),
  ADMIN_SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  ADMIN_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`Invalid API environment:\n${lines.join('\n')}`)
  }
  return parsed.data
}
