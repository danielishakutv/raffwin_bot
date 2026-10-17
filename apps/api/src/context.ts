import type { Logger } from 'pino'
import type { Config } from './config'
import type { Db } from './db/client'
import type { NotificationButton } from './db/schema'
import type { AccessTokens } from './lib/access-token'

/** How a bot message is sent: Telegram HTML or plain text, with inline buttons. */
export interface SendOptions {
  /** parse_mode HTML: the text must already be escaped (lib/html.ts) */
  html?: boolean
  /** Inline keyboard rows */
  buttons?: NotificationButton[][]
  /** No sound on the player's phone */
  silent?: boolean
}

/**
 * Sends a bot message to a private chat. Rejects with Telegram's error
 * (grammY's GrammyError: error_code, description, parameters.retry_after)
 * so callers can tell "blocked the bot" (403) from "slow down" (429).
 */
export type SendTelegram = (chatId: number, text: string, opts?: SendOptions) => Promise<{ messageId: number } | void>

/** Everything a route or service needs, built once in server.ts (or a test). */
export interface AppContext {
  config: Config
  db: Db
  log: Logger
  tokens: AccessTokens
  /** Injectable clock so tests can move time */
  now: () => number
  /** The API's own bot; tests capture messages instead. Absent = this process cannot message anyone. */
  sendTelegram?: SendTelegram
}

/** What every request handler knows about the caller, for logs and security events. */
export interface RequestMeta {
  ipHash: string | null
  userAgent: string | null
  requestId: string
  route: string
}
