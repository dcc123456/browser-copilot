// defineConfig comes from vitest/config, not vite: it is the same function
// widened to accept the `test` block below. Importing it from 'vite' typechecks
// only as long as some file in the same program pulls in Vitest's type
// augmentation, which made this config's validity depend on unrelated includes.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: 'chrome116',
    // Extension pages are loaded from disk; readable output helps debugging.
    minify: false,
    sourcemap: true,
  },
  test: {
    environment: 'node',
    // .tsx too: component render tests use react-dom/server, which needs no DOM
    // environment, so they belong in this same suite.
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
  },
})
