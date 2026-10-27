/**
 * Load a TypeScript module from a plain `.mjs` script.
 *
 * The repository has no `tsx`, and these scripts must use the SAME scoring and
 * mapping code the extension and the tests use — a second implementation would
 * be the thing that drifts. Vite's SSR module loader compiles the TS on the fly
 * with the repository's own resolution rules.
 *
 * @module scripts/load-ts-module
 */
import path from 'node:path'
import { createServer } from 'vite'

/**
 * Load every entry through one Vite server and close it before returning.
 * `entries` maps a caller-chosen key to an absolute module path.
 */
export async function loadTsModules(entries) {
  const server = await createServer({
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    // These scripts load a handful of pure modules; crawling the whole
    // repository's HTML entries would drag the editor bundle into esbuild.
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  })
  try {
    const modules = {}
    for (const [key, modulePath] of Object.entries(entries)) {
      modules[key] = await server.ssrLoadModule(path.resolve(modulePath))
    }
    return modules
  } finally {
    await server.close()
  }
}
