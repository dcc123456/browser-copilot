#!/usr/bin/env node
/**
 * Reliability benchmark runner (spec §15/§16, Phase 11).
 *
 * Thin wrapper: the benchmark itself is the deterministic vitest suite
 * `tests/reliability-benchmark.spec.ts` (R01–R10 strict targets + layered
 * L1/L2/L3 metrics + certification transitions), so CI and local runs share
 * one source of truth. This script runs it and reports the exit code.
 */
import { spawnSync } from 'node:child_process'

const result = spawnSync('pnpm', ['vitest', 'run', 'tests/reliability-benchmark.spec.ts'], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
