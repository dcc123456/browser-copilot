import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The server tests exercise the extension's pure engine, which reads the
  // compile-time `__OCR__` flag injected by the root `vite.config.ts`. Mirror
  // it here so importing engine modules under vitest does not throw
  // `ReferenceError: __OCR__ is not defined`.
  define: { __OCR__: 'true' },
  test: {
    // `.smoke.ts` covers the end-to-end runner boot test (see test/e2e/).
    include: ['test/**/*.test.ts', 'test/**/*.smoke.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
})
