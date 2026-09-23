/**
 * Offline generation benchmark (spec §37.1, metrics G1–G6).
 *
 * Deterministic simulation over the pure generation state machine, compiler
 * and save gate: each scenario replays a scripted sequence of action
 * outcomes through the same functions the live path uses, then we derive the
 * metrics. No model, no browser — the benchmark measures pipeline logic
 * (recovery, compile, save gate) rather than the network.
 */
import { describe, expect, it } from 'vitest'
import {
  attachGoalSpec,
  markFailureRecovered,
  recordActionFinished,
  recordActionStarted,
  startGenerationSession,
  successfulTraces,
  transitionGeneration,
} from '../src/lib/workflow/generation-session'
import { compileWorkflowFromTrace } from '../src/lib/workflow/workflow-compiler'
import { validateGeneratedWorkflowForSave } from '../src/lib/workflow/save-gate'

interface Scenario {
  name: string
  /** Scripted actions; `failOnce` fails then retries successfully. */
  actions: Array<{
    blockId: string
    intent: string
    failOnce?: boolean
    goal?: boolean
  }>
  /** Every action fails permanently (task completion failure scenario). */
  terminalFailure?: boolean
}

const SCENARIOS: Scenario[] = [
  {
    name: 'G-01 open url',
    actions: [{ blockId: 'open-url', intent: 'open the page', goal: true }],
  },
  {
    name: 'G-02 open + click',
    actions: [
      { blockId: 'open-url', intent: 'open the page' },
      { blockId: 'event-click', intent: 'click the button', goal: true },
    ],
  },
  {
    name: 'G-03 open + fill',
    actions: [
      { blockId: 'open-url', intent: 'open the page' },
      { blockId: 'forms', intent: 'fill the field', goal: true },
    ],
  },
  {
    name: 'G-04 late rendering recovery',
    actions: [
      { blockId: 'open-url', intent: 'open the page' },
      { blockId: 'event-click', intent: 'click late button', failOnce: true },
      { blockId: 'delay', intent: 'observe result', goal: true },
    ],
  },
  {
    name: 'G-05 unrecoverable failure',
    actions: [{ blockId: 'event-click', intent: 'click button', goal: true }],
    terminalFailure: true,
  },
]

interface ScenarioResult {
  name: string
  completed: boolean
  hadFailure: boolean
  recoveredFailure: boolean
  compiled: boolean
  saveOk: boolean
}

async function runScenario(scenario: Scenario, index: number): Promise<ScenarioResult> {
  let session = startGenerationSession({
    conversationId: `c-${index}`,
    userGoal: scenario.name,
  }).session
  session = transitionGeneration(session, 'understanding').session
  session = attachGoalSpec(session, {
    summary: scenario.name,
    successConditions: [{ kind: 'urlContains', value: 'example.com' }],
  })
  session = transitionGeneration(session, 'executing').session

  let hadFailure = false
  let recoveredFailure = false

  /** Selector for interaction blocks (locator gate). */
  const paramsFor = (action: Scenario['actions'][number]): Record<string, unknown> =>
    action.blockId === 'open-url'
      ? { url: 'https://example.com/' }
      : action.blockId === 'delay'
        ? {}
        : { selector: `#${action.intent.replace(/\W/g, '-')}` }

  for (const action of scenario.actions) {
    session = recordActionStarted(session, {
      blockId: action.blockId,
      intent: action.intent,
      params: paramsFor(action),
    }).session

    if (scenario.terminalFailure) {
      hadFailure = true
      session = recordActionFinished(session, { passed: false }).session
      return {
        name: scenario.name,
        completed: false,
        hadFailure,
        recoveredFailure,
        compiled: false,
        saveOk: false,
      }
    }

    if (action.failOnce) {
      hadFailure = true
      session = recordActionFinished(session, { passed: false }).session
      session = markFailureRecovered(session).session
      recoveredFailure = true
      // Retry the same action.
      session = recordActionStarted(session, {
        blockId: action.blockId,
        intent: `${action.intent} (retry)`,
        params: paramsFor(action),
      }).session
    }

    session = recordActionFinished(session, {
      passed: true,
      nodeId: `n-${index}-${action.intent.replace(/\W/g, '')}`,
      ...(action.goal
        ? { verification: { kind: 'goal' as const, passed: true } }
        : {}),
    }).session
  }

  let compiled = false
  let saveOk = false
  if (successfulTraces(session).length > 0) {
    session = transitionGeneration(session, 'compiling').session
    const result = compileWorkflowFromTrace({ session, name: scenario.name })
    compiled = true
    session = transitionGeneration(session, 'hardening').session
    session = transitionGeneration(session, 'ready-to-save').session
    const gate = await validateGeneratedWorkflowForSave({ workflow: result.workflow })
    saveOk = gate.ok
  }

  return {
    name: scenario.name,
    completed: true,
    hadFailure,
    recoveredFailure,
    compiled,
    saveOk,
  }
}

describe('workflow generation benchmark (G1–G6)', () => {
  it('reports the offline generation metrics', async () => {
    const results = await Promise.all(
      SCENARIOS.map((scenario, index) => runScenario(scenario, index)),
    )

    const attempts = results.length
    const completedTasks = results.filter((r) => r.completed).length
    const compiledCount = results.filter((r) => r.compiled).length
    const savedCount = results.filter((r) => r.saveOk).length
    const failureTasks = results.filter((r) => r.hadFailure)
    const recoveredTasks = failureTasks.filter((r) => r.recoveredFailure)

    // G1 Task completion rate.
    const g1 = completedTasks / attempts
    // G2 Workflow compile rate (of completed tasks).
    const g2 = compiledCount / completedTasks
    // G3 First replay/save success rate (of compiled workflows).
    const g3 = savedCount / compiledCount
    // G5 Generation recovery rate (of tasks with a failure).
    const g5 = recoveredTasks.length / failureTasks.length

    const metrics = {
      G1_taskCompletionRate: round(g1),
      G2_workflowCompileRate: round(g2),
      G3_firstReplaySuccessRate: round(g3),
      G5_generationRecoveryRate: round(g5),
      scenarios: attempts,
    }
    // eslint-disable-next-line no-console
    console.log('\n[workflow-generation benchmark]\n' + JSON.stringify(metrics, null, 2))

    // Targets: only the scripted terminal-failure scenario fails; the
    // G-04 action failure recovers; every completed task compiles and passes
    // the save gate.
    expect(g1).toBeGreaterThanOrEqual(0.8)
    expect(g2).toBe(1)
    expect(g3).toBe(1)
    // G5: the ordinary transient action failure (G-04) recovered; the
    // terminal-failure scenario is a scripted permanent failure and counts
    // as non-recoverable by design.
    expect(g5).toBeGreaterThanOrEqual(0.5)
    expect(results.find((r) => r.name.includes('G-04'))?.recoveredFailure).toBe(true)
    expect(results.find((r) => r.name.includes('G-04'))?.saveOk).toBe(true)
  })
})

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
