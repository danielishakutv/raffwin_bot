import { defineConfig } from 'drizzle-kit'

// `drizzle-kit generate` only diffs the schema against ./drizzle; it needs no database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
})
