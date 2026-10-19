import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The site talks to its own backend under /api only. In development that is
// the local buy-api; on the server Apache serves both from one origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5180, proxy: { '/api': 'http://127.0.0.1:3420' } },
  build: { sourcemap: false },
})
