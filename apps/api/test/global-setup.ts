/**
 * Once per test run: create an empty schema t_<time>_<random> in the test
 * database and migrate it. Nothing is ever dropped (house rule: no deletes);
 * old t_* schemas can be cleared by hand whenever convenient.
 */
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import type { TestProject } from 'vitest/node'
import { runMigrations } from '../src/db/migrate'

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string
    testSchema: string
  }
}

export default async function setup(project: TestProject) {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy apps/api/.env.example to apps/api/.env and point it at the raffwin_test database.',
    )
  }
  const schema = `t_${Date.now()}_${randomBytes(3).toString('hex')}`
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(`create schema "${schema}"`)
  } finally {
    await client.end()
  }
  await runMigrations(url, schema)
  project.provide('testDatabaseUrl', url)
  project.provide('testSchema', schema)
}
