#!/usr/bin/env node
/**
 * Runs the offline AI-debug benchmark (`tests/bench/debug-bench.spec.ts`) and
 * prints its Markdown + JSON report. No browser, model, or network is used, so
 * this is safe to run in CI as the success-rate regression gate.
 *
 * Usage: pnpm bench:debug
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vitestBin = resolve(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')

if (!existsSync(vitestBin)) {
  console.error(`[bench:debug] vitest not found at ${vitestBin}. Run "pnpm install" first.`)
  process.exit(1)
}

console.log('[bench:debug] running the offline AI-debug benchmark…')
const result = spawnSync(
  process.execPath,
  [vitestBin, 'run', 'tests/bench/debug-bench.spec.ts', '--reporter=verbose'],
  { stdio: 'inherit', cwd: repoRoot },
)

process.exit(result.status ?? 1)
