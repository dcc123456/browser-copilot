import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * `chrome.scripting.executeScript({ func })` serialises the function's SOURCE
 * and evaluates it in the page, so any reference to a module-scope binding is
 * a `ReferenceError` there. Nothing else catches it: `tsc` is happy, the
 * bundler is happy, and a test that merely CALLS the injected function is
 * happy too — in a test the module scope is still in reach.
 *
 * This is not hypothetical. The check found four real cases on its first run,
 * including `runOpViaKernel`, whose `KERNEL_VERSION` reference had been
 * throwing since the commit that introduced it (proven by rebuilding the
 * shipped, minified function from its own source and calling it).
 *
 * `scripts/verify-injected-functions.mjs` walks every injection site with the
 * TypeScript checker and fails on any binding that resolves into `src/`.
 */
describe('injected functions', () => {
  it('reference nothing outside their own body', () => {
    let report = ''
    try {
      report = execFileSync(process.execPath, ['scripts/verify-injected-functions.mjs'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string }
      throw new Error(
        [
          'An injected function references a module-scope binding, so it will throw',
          'ReferenceError in the page. Pass the value through `args` instead — the',
          'docs: "This function will be serialized, and then deserialized for',
          'injection. This means that any bound parameters and execution context',
          'will be lost."',
          '',
          failed.stdout ?? '',
          failed.stderr ?? '',
        ].join('\n'),
      )
    }
    expect(report).toContain('every injected function is self-contained')
  }, 60_000)
})
