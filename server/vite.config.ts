/**
 * Build for the server's Web console SPA.
 *
 * - `root` points at `server/web/` so `pnpm --dir server build` emits
 *   `server/web/dist/`, which `src/main.ts` serves via `@fastify/static`.
 * - `base: './'` keeps asset URLs relative, so the console works behind a
 *   reverse proxy mounted at a sub-path.
 * - The dev server proxies `/api` to a locally running runner.
 *
 * Vitest keeps using `vitest.config.ts` (it outranks vite.config.*), so this
 * file is purely the SPA build.
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
