/**
 * Calls to the main API, signed (@raffwin/relay). Its address comes from
 * MAIN_API_URL and stays in this file: errors carry a status and a code,
 * never the address, so nothing upstream can leak it into a response or a log.
 */
import {
  accountResponse,
  creditResponse,
  flagResponse,
  RELAY_REFUSALS,
  signRelay,
  type AccountRequest,
  type AccountResponse,
  type CreditRequest,
  type CreditResponse,
  type FlagRequest,
  type RelayOperation,
  type RelayRefusal,
} from '@raffwin/relay'
import type { z } from 'zod'

export type RelayResult<T> =
  | { ok: true; data: T }
  /** The main API answered no; the same request will get the same answer */
  | { ok: false; refused: RelayRefusal; message: string }
  /** No answer worth keeping: try again later */
  | { ok: false; refused: null; error: string }

export interface MainApi {
  account(req: AccountRequest): Promise<RelayResult<AccountResponse>>
  credit(req: CreditRequest): Promise<RelayResult<CreditResponse>>
  flag(req: FlagRequest): Promise<RelayResult<{ recorded: boolean }>>
}

export function createMainApi(config: { MAIN_API_URL: string; RELAY_PATH: string; RELAY_SECRET: string }, now: () => number = Date.now): MainApi {
  const base = `${config.MAIN_API_URL.replace(/\/$/, '')}/internal/${config.RELAY_PATH}`

  async function send<T>(operation: RelayOperation, body: unknown, shape: z.ZodType<T>): Promise<RelayResult<T>> {
    const raw = JSON.stringify(body)
    let res: Response
    try {
      res = await fetch(`${base}/${operation}`, { method: 'POST', headers: signRelay(config.RELAY_SECRET, operation, raw, now()), body: raw, signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      // The name only: a fetch error's message and cause can carry the host name
      return { ok: false, refused: null, error: `unreachable (${(error as Error).name})` }
    }
    const json: unknown = await res.json().catch(() => null)
    if (res.ok) {
      const parsed = shape.safeParse(json)
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, refused: null, error: `unexpected answer to ${operation}` }
    }
    const code = (json as { error?: { code?: string; message?: string } } | null)?.error?.code
    if (code && code in RELAY_REFUSALS && res.status === RELAY_REFUSALS[code as RelayRefusal]) {
      return { ok: false, refused: code as RelayRefusal, message: String((json as { error: { message?: string } }).error.message ?? code) }
    }
    // 401 (signature, clock), 429, 5xx: not the request's fault; keep trying and let the logs say why
    return { ok: false, refused: null, error: `${operation} answered ${res.status}${code ? ` ${code}` : ''}` }
  }

  return {
    account: (req) => send('account', req, accountResponse),
    credit: (req) => send('credit', req, creditResponse),
    flag: (req) => send('flag', req, flagResponse),
  }
}
