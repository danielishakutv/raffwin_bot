import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

export type Db = NodePgDatabase<typeof schema>

export interface DbHandle {
  db: Db
  pool: pg.Pool
  close(): Promise<void>
}

/**
 * `searchPath` puts every table in one schema; tests use it to get a fresh,
 * empty schema per run without touching anything else in the database.
 */
export function createDb(url: string, options: { searchPath?: string; max?: number } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  })
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() }
}

/** Postgres SQLSTATE 23505 on a named unique index, for turning races into API errors. */
export function uniqueViolation(error: unknown): string | null {
  const e = (error as { cause?: unknown })?.cause ?? error
  const code = (e as { code?: string })?.code
  if (code !== '23505') return null
  return (e as { constraint?: string }).constraint ?? 'unknown'
}
