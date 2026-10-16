/**
 * Applies pending migrations from apps/api/drizzle. Forward-only (section 14):
 *   pnpm --filter @raffwin/api db:migrate      (source, via tsx)
 *   node dist/migrate.js                       (built, on the server)
 * Both run with apps/api as the working directory.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from './client'

export const MIGRATIONS_DIR = resolve(process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'drizzle'))

export async function runMigrations(url: string, searchPath?: string): Promise<void> {
  const handle = createDb(url, { searchPath, max: 1 })
  try {
    await migrate(handle.db, {
      migrationsFolder: MIGRATIONS_DIR,
      ...(searchPath ? { migrationsSchema: searchPath } : {}),
    })
  } finally {
    await handle.close()
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set (apps/api/.env)')
    process.exit(1)
  }
  runMigrations(url)
    .then(() => console.log('migrations applied'))
    .catch((error: unknown) => {
      console.error('migration failed:', error)
      process.exit(1)
    })
}
