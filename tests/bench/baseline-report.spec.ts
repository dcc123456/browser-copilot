/**
 * Workflow AI reliability BASELINE report (计划 T00.5).
 *
 * One fixture-driven, fully deterministic snapshot of the four pipeline
 * stages, measured against the REAL production modules:
 *
 *  - generation: scripted raw action traces (HistoryEntry[]) → `workflowFromHistory`
 *    (parse) then `validateGeneratedWorkflow` on the provenance-stamped result
 *    (compile);
 *  - execution: R01–R10 run through the real graph interpreter with the stub
 *    executors in generated-strict mode;
 *  - debug: the offline AI-debug benchmark harness (`runBench` success rate);
 *  - stability: each strict scenario re-run on a second fresh page.
 *
 * No browser, no model, no network: the same commit re-running this file gets
 * the same numbers. The computed report is compared against the checked-in
 * artifact `tests/bench/baseline.json` (the `commit` field alone is allowed to
 * differ). Set UPDATE_BASELINE=1 to refresh the artifact.
 */
import { execSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { workflowFromHistory } from '../../src/lib/storage'
import { validateGeneratedWorkflow } from '../../src/lib/workflow/generated-validation'
import { runScenario } from '../../specs/reliability-fixtures/scenarios'
import { RELIABILITY_SCENARIOS } from '../../specs/reliability-fixtures/scenarios'
import { runBench } from './harness'

import type { HistoryEntry } from '../../src/lib/types'

// --- Generation trace fixtures -------------------------------------------------

let entrySeq = 0
function traceEntry(
  conversationId: string,
  action: string,
  args: Record<string, unknown>,
  summary = action,
  ok = true,
): HistoryEntry {
  entrySeq += 1
  return {
    id: `h-${entrySeq}`,
    at: entrySeq,
    conversationId,
    action,
    summary,
    host: 'shop.example',
    approved: true,
    ok,
    args,
  }
}

/** Five G-cases as raw, chronological action traces. */
const GENERATION_CASES: { id: string; entries: HistoryEntry[] }[] = [
  {
    // G01 open page → click button
    id: 'G01',
    entries: [
      traceEntry('g1', 'open_url', { url: 'https://shop.example/list' }),
      traceEntry('g1', 'click', { target: '#go', selector: '#go' }, '点击 Go'),
    ],
  },
  {
    // G02 search → read result (fill + click search)
    id: 'G02',
    entries: [
      traceEntry('g2', 'fill', { selector: '#q', value: 'phone' }),
      traceEntry('g2', 'click', { selector: '#search-btn' }, '点击搜索'),
    ],
  },
  {
    // G03 fill form → submit → verify (submit is a click on the submit control)
    id: 'G03',
    entries: [
      traceEntry('g3', 'fill', { selector: '#email', value: 'a@b.com' }),
      traceEntry('g3', 'click', { selector: '#submit-btn' }, '点击提交'),
    ],
  },
  {
    // G04 multi-step: navigate → fill → submit
    id: 'G04',
    entries: [
      traceEntry('g4', 'open_url', { url: 'https://shop.example/new' }),
      traceEntry('g4', 'fill', { selector: '#title', value: 'Order 1' }),
      traceEntry('g4', 'click', { selector: '#submit-btn' }, '点击提交'),
    ],
  },
  {
    // G05 actions the compiler cannot turn into any block: parse must fail
    id: 'G05',
    entries: [
      traceEntry('g5', 'think', { thought: 'exploring' }),
      traceEntry('g5', 'summarize', { text: 'nothing replayable' }),
    ],
  },
]

/** Parse one raw trace; then compile (strict-validate) the parsed workflow. */
function compileTrace(entries: HistoryEntry[], name: string): {
  parsed: boolean
  compiled: boolean
  issues: string[]
} {
  const workflow = workflowFromHistory(entries, name)
  if (!workflow) return { parsed: false, compiled: false, issues: [] }
  // Same stamping the production history path performs (history-compile.ts).
  workflow.settings.provenance = 'chat-history'
  workflow.settings.generationOriginUrl = 'https://shop.example'
  const report = validateGeneratedWorkflow(workflow)
  return {
    parsed: true,
    compiled: report.ok,
    issues: report.errors.slice(0, 4).map((i) => `[${i.code}] ${i.message}`),
  }
}

// --- Measurement ---------------------------------------------------------------

interface BaselineReport {
  commit: string
  sampleSizes: { generation: number; execution: number; debug: number; stability: number }
  generation: {
    parseRate: number
    compileRate: number
    cases: Record<string, { parsed: boolean; compiled: boolean; issues: string[] }>
  }
  execution: {
    firstRunSuccess: number
    goalSuccess: number
    cases: Record<string, { ok: boolean; submitCalls: number }>
  }
  debug: {
    verifiedRecoveryRate: number
    total: number
    verified: number
  }
  stability: {
    replaySuccessRate: number
    cases: Record<string, { first: boolean; second: boolean }>
  }
}

function rate(part: number, total: number): number {
  return total === 0 ? 0 : Number((part / total).toFixed(4))
}

async function measure(): Promise<BaselineReport> {
  // Generation.
  const generationCases: BaselineReport['generation']['cases'] = {}
  for (const testCase of GENERATION_CASES) {
    generationCases[testCase.id] = compileTrace(testCase.entries, testCase.id)
  }
  const parsedCount = GENERATION_CASES.filter((c) => generationCases[c.id]!.parsed).length
  const compiledCount = GENERATION_CASES.filter((c) => generationCases[c.id]!.compiled).length

  // Execution (strict mode, real engine + stub executors).
  const executionCases: BaselineReport['execution']['cases'] = {}
  for (const scenario of RELIABILITY_SCENARIOS) {
    const result = await runScenario(scenario, 'strict')
    executionCases[scenario.id] = {
      ok: result.final.outcome === 'ok',
      submitCalls: result.submitCalls,
    }
  }
  const firstRunOk = RELIABILITY_SCENARIOS.filter(
    (s) => executionCases[s.id]!.ok,
  ).length

  // Debug (offline benchmark over the real debug-session loop).
  const debugReport = await runBench()

  // Stability: a second strict pass on a FRESH page for every scenario.
  const stabilityCases: BaselineReport['stability']['cases'] = {}
  for (const scenario of RELIABILITY_SCENARIOS) {
    const first = await runScenario(scenario, 'strict')
    const second = await runScenario(scenario, 'strict')
    stabilityCases[scenario.id] = {
      first: first.final.outcome === 'ok',
      second: second.final.outcome === 'ok',
    }
  }
  const replayOk = RELIABILITY_SCENARIOS.filter(
    (s) =>
      stabilityCases[s.id]!.first && stabilityCases[s.id]!.second,
  ).length

  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    // Non-git checkout: keep the placeholder.
  }

  return {
    commit,
    sampleSizes: {
      generation: GENERATION_CASES.length,
      execution: RELIABILITY_SCENARIOS.length,
      debug: debugReport.total,
      stability: RELIABILITY_SCENARIOS.length,
    },
    generation: {
      parseRate: rate(parsedCount, GENERATION_CASES.length),
      compileRate: rate(compiledCount, GENERATION_CASES.length),
      cases: generationCases,
    },
    execution: {
      firstRunSuccess: rate(firstRunOk, RELIABILITY_SCENARIOS.length),
      goalSuccess: rate(firstRunOk, RELIABILITY_SCENARIOS.length),
      cases: executionCases,
    },
    debug: {
      verifiedRecoveryRate: rate(debugReport.verified, debugReport.total),
      total: debugReport.total,
      verified: debugReport.verified,
    },
    stability: {
      replaySuccessRate: rate(replayOk, RELIABILITY_SCENARIOS.length),
      cases: stabilityCases,
    },
  }
}

// --- Spec ----------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const artifactPath = resolve(here, 'baseline.json')

describe('workflow AI reliability baseline', () => {
  it('produces a deterministic fixture-driven baseline report', async () => {
    const report = await measure()

    console.log(`[baseline] JSON ${JSON.stringify(report)}`)

    // Sanity: every stage is populated from a real, non-empty sample.
    expect(report.sampleSizes.generation).toBe(GENERATION_CASES.length)
    expect(report.sampleSizes.execution).toBe(RELIABILITY_SCENARIOS.length)
    expect(report.sampleSizes.debug).toBeGreaterThan(0)
    expect(report.sampleSizes.stability).toBe(RELIABILITY_SCENARIOS.length)
    for (const value of [
      report.generation.parseRate,
      report.generation.compileRate,
      report.execution.firstRunSuccess,
      report.execution.goalSuccess,
      report.debug.verifiedRecoveryRate,
      report.stability.replaySuccessRate,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }

    if (process.env['UPDATE_BASELINE'] === '1') {
      await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
      return
    }

    // Reproducibility: the checked-in artifact must match this commit's
    // measurement (the commit hash field alone is allowed to differ).
    const stored = JSON.parse(await readFile(artifactPath, 'utf-8')) as BaselineReport
    const withoutCommit = (value: BaselineReport): Omit<BaselineReport, 'commit'> => {
      const { commit: _commit, ...rest } = value
      return rest
    }
    expect(withoutCommit(report)).toEqual(withoutCommit(stored))
  })
})
