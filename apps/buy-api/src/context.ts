import type { Logger } from 'pino'
import type { Config } from './config'
import type { Db } from './db/client'
import type { MainApi } from './lib/main-api'
import type { Paystack } from './lib/paystack'

/** Everything a route or service needs, built once in server.ts (or a test). */
export interface AppContext {
  config: Config
  db: Db
  log: Logger
  now: () => number
  paystack: Paystack
  mainApi: MainApi
}

/** Who is calling, for the security log */
export interface RequestMeta {
  ipHash: string | null
  route: string
}
