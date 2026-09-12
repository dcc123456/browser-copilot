/**
 * Offline benchmark harness for the AI-debug session (调试基准执行器).
 *
 * Drives the REAL `runDebugSession` against the scripted scenarios with fully
 * injected dependencies, so the success rate is computable in CI without a
 * browser, a model, or network. This is the "measure first" instrument: it
 * produces the baseline number the success-rate work is judged against.
 *
 * @module tests/bench/harness
 */
import {
  runDebugSession,
  type DebugSessionDeps,
} from '../../src/background/workflow-engine/debug-session'
import type { TakeoverReport } from '../../src/lib/workflow/ai-takeover'
import type { DebugPhase } from '../../src/lib/workflow/takeover-stats'
import type { Workflow, WorkflowNode } from '../../src/lib/workflow/types'
import { BENCH_SCENARIOS, type BenchScenario } from './scenarios'

function makeWorkflow(): Workflow {
  const node = (id: string, label: string, data: Record<string, unknown> = {}): WorkflowNode => ({
    id,
    label,
    position: { x: 0, y: 0 },
    data: { ...data },
  })
  return {
    id: 'bench-wf',
    name: '基准工作流',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    drawflow: {
      nodes: [node('trigger', 'trigger'), node('click', 'event-click', { selector: '.stale' })],
      edges: [],
    },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

/** What one scenario produced, in report-friendly form. */
export interface ScenarioOutcome {
  id: string
  title: string
  failureClass: BenchScenario['failureClass']
  ok: boolean
  verified: boolean
  goalAchieved: boolean
  /**
   * Success via the terminal state: the goal ALREADY held (non-idempotent flow
   * that had landed), so there was no takeover-free pass to verify — retrying
   * could never re-demonstrate the goal.
   */
  alreadySatisfied?: boolean
  attempts: number
  rounds: number
  takeoverAttempts: number
  phases: DebugPhase[]
  failedPhase?: DebugPhase
  expectation: string
}

/** Aggregate benchmark result. */
export interface BenchReport {
  total: number
  verified: number
  /** verified / total — the strict session success rate. */
  successRate: number
  outcomes: ScenarioOutcome[]
}

const PHASE_ORDER: readonly DebugPhase[] = [
  'takeover',
  'verify',
  'replay',
  'audit',
  'rewrite-verify',
]

/** Runs one scenario through the real session loop. */
export async function runScenario(scenario: BenchScenario): Promise<ScenarioOutcome> {
  const phases = new Set<DebugPhase>()
  let takeoverAttempts = 0
  let rewriteVerifyArmed = false
  // A scenario with no provider cannot escalate (replay/audit need a model).
  const hasProvider = scenario.takeoverAttempts > 0 || scenario.takeoverCompletes

  const deps: DebugSessionDeps = {
    maxRounds: 2,
    run: async (_workflow, opts) => {
      if (opts.aiTakeover) {
        phases.add('takeover')
        if (scenario.firstRun === 'ok') {
          return { runId: 'run-first', outcome: 'ok', summary: 'ok', variables: {} }
        }
        // Mirror the engine: a failing run hands the node to the hook while
        // running — that is how the takeover report reaches the session.
        await opts.aiTakeover({ failingNodeId: 'click' } as never)
        return { runId: 'run-first', outcome: 'failed', error: 'node failed' }
      }
      // A takeover-free run is the rewrite-verify once the audit produced a
      // corrected graph; otherwise it is the fix-verify.
      if (rewriteVerifyArmed) {
        phases.add('rewrite-verify')
        return scenario.rewriteVerifyPasses
          ? { runId: 'run-rewrite', outcome: 'ok', summary: 'rewrite ok', variables: {} }
          : { runId: 'run-rewrite', outcome: 'failed', error: 'rewrite verify failed' }
      }
      phases.add('verify')
      return scenario.verifyPasses
        ? { runId: 'run-verify', outcome: 'ok', summary: 'verify ok', variables: {} }
        : { runId: 'run-verify', outcome: 'failed', error: 'verify failed' }
    },
    createTakeover:
      ({ onTakeover }) =>
      async () => {
        takeoverAttempts = scenario.takeoverAttempts
        const report: TakeoverReport = scenario.takeoverCompletes
          ? {
              nodeId: 'click',
              nodeLabel: 'click',
              completed: true,
              attempts: scenario.takeoverAttempts,
              summary: 'done',
              ...(scenario.fix ? { fix: scenario.fix } : {}),
            }
          : {
              nodeId: 'click',
              nodeLabel: 'click',
              completed: false,
              attempts: scenario.takeoverAttempts,
              error: 'not done',
              ...(scenario.reasonKind ? { reasonKind: scenario.reasonKind } : {}),
            }
        onTakeover(report)
        return scenario.takeoverCompletes
          ? { completed: true, summary: 'done' }
          : {
              completed: false,
              reason: 'not done',
              ...(scenario.reasonKind ? { reasonKind: scenario.reasonKind } : {}),
            }
      },
    goalCheck: async () =>
      scenario.goal === null
        ? null
        : {
            achieved: scenario.goal,
            reason: 'bench',
            ...(scenario.goalAlreadySatisfied ? { alreadySatisfied: true } : {}),
          },
    savePending: async () => {},
    saveRewrite: async () => {},
    ...(hasProvider
      ? {
          replay: async () => {
            phases.add('replay')
            return { completed: true, summary: 'replayed', trace: [] }
          },
          audit: async () => {
            phases.add('audit')
            if (!scenario.replayRewrite) return null
            // A validated rewrite arms the next takeover-free run as the
            // rewrite-verify (same contract as the real wiring).
            rewriteVerifyArmed = true
            return { diagnosis: 'bench', nodes: [], changes: ['bench'], rewritten: makeWorkflow() }
          },
        }
      : {}),
  }

  const result = await runDebugSession(makeWorkflow(), deps)
  const verified = result.verified === true
  const entered = PHASE_ORDER.filter((phase) => phases.has(phase))
  const failedPhase = verified || result.cancelled ? undefined : entered[entered.length - 1]
  return {
    id: scenario.id,
    title: scenario.title,
    failureClass: scenario.failureClass,
    ok: result.ok === true,
    verified,
    goalAchieved: result.goalAchieved === true,
    ...(result.alreadySatisfied ? { alreadySatisfied: true } : {}),
    attempts: result.attempts,
    rounds: result.rounds ?? 0,
    takeoverAttempts,
    phases: entered,
    ...(failedPhase ? { failedPhase } : {}),
    expectation: scenario.expectation,
  }
}

/** Runs every scenario and aggregates the result. */
export async function runBench(): Promise<BenchReport> {
  const outcomes: ScenarioOutcome[] = []
  for (const scenario of BENCH_SCENARIOS) outcomes.push(await runScenario(scenario))
  const verified = outcomes.filter((outcome) => outcome.verified).length
  return {
    total: outcomes.length,
    verified,
    successRate: outcomes.length > 0 ? verified / outcomes.length : 0,
    outcomes,
  }
}

/** Renders the report as Markdown (the CLI's human-readable output). */
export function formatReport(report: BenchReport): string {
  const lines: string[] = []
  lines.push(
    `# AI 调试离线基准报告`,
    '',
    `- 场景总数：${report.total}`,
    `- 已验证（无接管跑通且目标达成）：${report.verified}`,
    `- 其中终态达成（非幂等流程已生效，无需再跑）：${
      report.outcomes.filter((o) => o.alreadySatisfied).length
    }`,
    `- **会话成功率：${(report.successRate * 100).toFixed(1)}%**`,
    '',
    '| 场景 | 失败类 | 结果 | 接管尝试 | 进入阶段 | 失败阶段 | 说明 |',
    '|---|---|---|---|---|---|---|',
  )
  for (const outcome of report.outcomes) {
    lines.push(
      `| ${outcome.id} ${outcome.title} | ${outcome.failureClass} | ${
        outcome.alreadySatisfied
          ? '✅ 终态已满足'
          : outcome.verified
            ? '✅ 已验证'
            : outcome.ok
              ? '⚠️ 通过未验证'
              : '❌ 失败'
      } | ${outcome.takeoverAttempts} | ${outcome.phases.join(' → ') || '—'} | ${
        outcome.failedPhase ?? '—'
      } | ${outcome.expectation} |`,
    )
  }
  return lines.join('\n')
}
