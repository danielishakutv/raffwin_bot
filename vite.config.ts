import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Short git SHA for the version label, or null outside a git checkout. */
function gitSha(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return null
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string
  }
  const sha = gitSha()
  // The version shown in the UI comes from package.json (the release source of
  // truth) unless VITE_APP_VERSION is explicitly set for the build.
  const version = env.VITE_APP_VERSION?.trim() || `${pkg.version}${sha ? `+${sha}` : ''}`

  // GitHub Pages serves a project site under /<repo>/ - the base path comes
  // from the env file for each environment (see .env.production / .env.staging).
  const base = env.VITE_BASE_PATH?.trim() || '/'

  return {
    base,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(version),
    },
    server: { port: 5173, host: true },
    build: {
      target: 'es2020',
      sourcemap: mode !== 'production',
      rollupOptions: {
        output: {
          // Keep the vendor libraries in their own long-cached chunks.
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            motion: ['framer-motion'],
            ui: ['lucide-react', 'canvas-confetti', 'zustand'],
          },
        },
      },
    },
  }
})
