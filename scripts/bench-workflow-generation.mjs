#!/usr/bin/env node
/**
 * Workflow generation benchmark runner (spec §37).
 *
 * Thin wrapper: the benchmark itself is the deterministic vitest suite
 * `tests/workflow-generation-benchmark.spec.ts` (metrics G1–G6), so CI and
 * local runs share one source of truth. This script runs it and reports the
 * exit code.
 */
import { spawnSync } from 'node:child_process'

const result = spawnSync('pnpm', ['vitest', 'run', 'tests/workflow-generation-benchmark.spec.ts'], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
