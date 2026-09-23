#!/usr/bin/env node
/**
 * Workflow repair benchmark runner (spec §37).
 *
 * Thin wrapper: the benchmark itself is the deterministic vitest suite
 * `tests/workflow-repair-benchmark.spec.ts` (metrics R1–R4), so CI and local
 * runs share one source of truth. This script runs it and reports the exit
 * code.
 */
import { spawnSync } from 'node:child_process'

const result = spawnSync('pnpm', ['vitest', 'run', 'tests/workflow-repair-benchmark.spec.ts'], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
