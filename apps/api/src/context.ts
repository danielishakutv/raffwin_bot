import type { Logger } from 'pino'
import type { Config } from './config'
import type { Db } from './db/client'
import type { AccessTokens } from './lib/access-token'

/** Everything a route or service needs, built once in server.ts (or a test). */
export interface AppContext {
  config: Config
  db: Db
  log: Logger
  tokens: AccessTokens
  /** Injectable clock so tests can move time */
  now: () => number
  /** Sends a plain-text bot message to a chat (the API's own bot); tests capture it instead */
  sendTelegram?: (chatId: number, text: string) => Promise<void>
}

/** What every request handler knows about the caller, for logs and security events. */
export interface RequestMeta {
  ipHash: string | null
  userAgent: string | null
  requestId: string
  route: string
}
