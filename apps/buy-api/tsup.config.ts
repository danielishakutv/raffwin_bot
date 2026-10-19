import { defineConfig } from 'tsup'

// Bundles @raffwin/relay (TypeScript source) into the output; npm packages stay external.
export default defineConfig({
  entry: { server: 'src/server.ts', migrate: 'src/db/migrate.ts', reconcile: 'src/cli/reconcile.ts' },
  format: 'esm',
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  // No clean step: builds overwrite their own files; nothing is deleted
  clean: false,
  sourcemap: false,
  noExternal: ['@raffwin/relay'],
})
