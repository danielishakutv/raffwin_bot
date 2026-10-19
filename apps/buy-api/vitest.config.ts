import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Database tests share one schema per run; files run one after another
    fileParallelism: false,
    testTimeout: 15_000,
  },
})
