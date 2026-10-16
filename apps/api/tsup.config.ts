import { defineConfig } from 'tsup'

// Bundles @raffwin/shared (TypeScript source) into the output; npm packages stay external.
export default defineConfig({
  entry: { server: 'src/server.ts', migrate: 'src/db/migrate.ts', 'create-admin': 'src/cli/create-admin.ts', 'setup-bot': 'src/cli/setup-bot.ts', 'master-hash': 'src/cli/master-hash.ts' },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  // No clean step: builds overwrite their own files; nothing is deleted
  clean: false,
  sourcemap: true,
  noExternal: ['@raffwin/shared'],
})
