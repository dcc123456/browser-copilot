/**
 * The pre-save trial replay (first-run-success D2).
 *
 * Two things are under test here, and the second outranks the first:
 *
 *  1. what the trial is allowed to run and what it reports — the unsafe cutoff,
 *     the record it reduces a run to, and the stage report the card shows;
 *  2. that it can NEVER cost a workflow its save: every path through the runner
 *     (opt-out, no page, a throw, a timeout, a cancel) resolves, and the graph
 *     the caller holds is either the one it passed in or that graph healed.
 *
 * A "verification" that lowered the number of workflows that get saved would
 * have made the original problem worse, so the assertions below treat a
 * rejection or a swallowed save as the failure case even before the reporting
 * is checked.
 *
 * @module tests/generation-trial
 */
import { describe, expect, it, vi } from 'vitest'
import {
  TRIAL_BUDGET_MS,
  executionPath,
  isUnsafeNode,
  normalizeTrialRun,
  skippedTrialRecord,
  trialCertifies,
  trialCutoffNodeId,
  trialFailed,
  trialHasNothingToProve,
  trialRecordOf,
  type TrialRunRecord,
} from '../src/lib/workflow/trial-run'
import {
  createTrialExecute,
  runGenerationTrial,
  withTrialRecord,
  type TrialExecute,
} from '../src/background/workflow-engine/repair/generation-trial'
import { independentVerifyStage } from '../src/background/workflow-engine/generation/generation-pipeline'
import type {
  ExecuteWorkflowOptions,
  ExecuteWorkflowResult,
} from '../src/background/workflow-engine/run-workflow'
import type { NodeDegradation } from '../src/lib/workflow/self-heal'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'
import { newId } from '../src/lib/storage'

function node(blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: newId(),
    label: blockId,
    position: { x: 0, y: 0 },
    data: { blockId, ...data },
  }
}

/** A trigger followed by `steps`, wired as the single chain the engine walks. */
function chain(steps: WorkflowNode[], name = 'trial'): Workflow {
  const trigger = node('trigger', { type: 'manual' })
  const nodes = [trigger, ...steps]
  const edges = nodes.slice(1).map((step, index) => ({
    id: `e${index}`,
    source: nodes[index]?.id ?? '',
    target: step.id,
  }))
  return {
    id: 'wf',
    name,
    createdAt: 0,
    updatedAt: 0,
    trigger: { type: 'manual', enabled: true },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes, edges },
  }
}

/** A read step: what the trial exists to replay. */
function readStep(selector = '#search'): WorkflowNode {
  return node('get-text', { selector, variableName: 'text' })
}

/** A step whose declared intent is a commit — the cutoff the trial obeys. */
function unsafeStep(): WorkflowNode {
  return node('event-click', {
    selector: '#pay',
    __reliability: { intent: 'submit the order' },
  })
}

function resultOf(overrides: Partial<ExecuteWorkflowResult> = {}): ExecuteWorkflowResult {
  return { runId: 'run-1', outcome: 'ok', ...overrides }
}

function degradationOf(n: WorkflowNode, to = 'css|#pay'): NodeDegradation {
  return { nodeId: n.id, rung: 2, from: 'css|.order button', to, matchCount: 2 }
}

describe('executionPath', () => {
  it('walks the first out-edge chain and leaves the trigger out', () => {
    const a = readStep('#a')
    const b = readStep('#b')
    const wf = chain([a, b])
    expect(executionPath(wf).map((n) => n.id)).toEqual([a.id, b.id])
  })

  it('ignores nodes a hand-wired branch made unreachable from the trigger', () => {
    const a = readStep('#a')
    const branch = readStep('#branch')
    const wf = chain([a])
    wf.drawflow.nodes.push(branch)
    expect(executionPath(wf).map((n) => n.id)).toEqual([a.id])
  })

  it('stops at a cycle instead of walking forever', () => {
    const a = readStep('#a')
    const b = readStep('#b')
    const wf = chain([a, b])
    wf.drawflow.edges.push({ id: 'back', source: b.id, target: a.id })
    expect(executionPath(wf).map((n) => n.id)).toEqual([a.id, b.id])
  })
})

describe('trial cutoff', () => {
  it('is the first step that cannot be undone, never a read before it', () => {
    const submit = unsafeStep()
    const wf = chain([readStep(), node('event-click', { selector: '#more' }), submit])
    expect(trialCutoffNodeId(wf)).toBe(submit.id)
    expect(isUnsafeNode(submit)).toBe(true)
  })

  it('is undefined when the whole chain is repeat-safe', () => {
    expect(trialCutoffNodeId(chain([readStep(), node('event-click', { selector: '#next' })]))).toBe(
      undefined,
    )
  })

  it('has nothing to prove when the graph starts by committing', () => {
    const submit = unsafeStep()
    expect(trialHasNothingToProve(chain([submit, readStep()]))).toBe(true)
    expect(trialHasNothingToProve(chain([readStep(), submit]))).toBe(false)
    // No cutoff means the whole graph is safe, which is the opposite of nothing.
    expect(trialHasNothingToProve(chain([readStep()]))).toBe(false)
  })
})

describe('trialRecordOf', () => {
  const graph = { cutoffNodeId: 'unsafe', totalSteps: 5 }

  it('reads a clean full run as a pass', () => {
    const record = trialRecordOf({ outcome: 'ok', completedSteps: 5 }, { totalSteps: 5 })
    expect(record).toMatchObject({ outcome: 'passed', full: true, coveredSteps: 5 })
    expect(trialCertifies(record)).toBe(true)
  })

  it('reads a run that stopped at its cutoff as a partial, not a pass', () => {
    const record = trialRecordOf(
      { outcome: 'ok', stoppedBefore: 'unsafe', completedSteps: 4 },
      graph,
    )
    expect(record).toMatchObject({ outcome: 'partial', full: false, cutoffNodeId: 'unsafe' })
    expect(trialCertifies(record)).toBe(false)
  })

  it('keeps the machine-readable failure code out of prose', () => {
    const record = trialRecordOf(
      {
        outcome: 'failed',
        completedSteps: 1,
        failedNodeId: 'n2',
        error: 'READINESS_TIMEOUT(present): element never appeared',
      },
      graph,
    )
    expect(record).toMatchObject({
      outcome: 'failed',
      failedNodeId: 'n2',
      failureCode: 'READINESS_TIMEOUT(present)',
    })
    expect(trialFailed(record)).toBe(true)
  })

  it('reports the budget running out as a timeout even when the run said ok', () => {
    const record = trialRecordOf(
      { outcome: 'ok', completedSteps: 2, timedOut: true },
      { totalSteps: 5 },
    )
    expect(record.outcome).toBe('timeout')
    expect(trialCertifies(record)).toBe(false)
  })

  it('reports a caller cancel as a cancel, never as a broken graph', () => {
    const record = trialRecordOf(
      { outcome: 'cancelled', cancelledByCaller: true, completedSteps: 1 },
      { totalSteps: 5 },
    )
    expect(record.outcome).toBe('cancelled')
    expect(trialFailed(record)).toBe(false)
  })
})

describe('normalizeTrialRun', () => {
  it('rebuilds a record it can fully read', () => {
    const record: TrialRunRecord = {
      outcome: 'partial',
      at: 123,
      full: false,
      coveredSteps: 3,
      totalSteps: 5,
      runId: 'r',
      cutoffNodeId: 'n9',
      degradedSteps: 1,
    }
    expect(normalizeTrialRun(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  it.each([
    ['an unknown outcome', { outcome: 'verified', at: 1 }],
    ['no timestamp', { outcome: 'passed' }],
    ['a non-numeric timestamp', { outcome: 'passed', at: 'yesterday' }],
    ['a bare string', 'passed'],
    ['null', null],
  ])('drops %s instead of trusting it', (_name, raw) => {
    expect(normalizeTrialRun(raw)).toBeUndefined()
  })

  it('keeps the `false` opt-out out of the record path', () => {
    // `false` means "never trial this workflow" and is handled by the settings
    // whitelist; as a record it is meaningless, so it must not read as one.
    expect(normalizeTrialRun(false)).toBeUndefined()
  })
})

describe('runGenerationTrial', () => {
  it('opts out without touching the page when the setting says false', async () => {
    const wf = chain([readStep()])
    wf.settings.trialRun = false
    const execute = vi.fn()
    const out = await runGenerationTrial(wf, { execute })
    expect(execute).not.toHaveBeenCalled()
    expect(out.workflow).toBe(wf)
    expect(out.record).toMatchObject({ outcome: 'skipped', reason: 'disabled by settings' })
  })

  it('skips a graph whose first step commits', async () => {
    const wf = chain([unsafeStep(), readStep()])
    const execute = vi.fn()
    const out = await runGenerationTrial(wf, { execute })
    expect(execute).not.toHaveBeenCalled()
    expect(out.workflow).toBe(wf)
    expect(out.record.outcome).toBe('skipped')
  })

  it('passes the cutoff to the run and never the step after it', async () => {
    const submit = unsafeStep()
    const wf = chain([readStep(), submit])
    const seen: Parameters<TrialExecute>[1][] = []
    const execute = vi.fn(async (_workflow: Workflow, options: Parameters<TrialExecute>[1]) => {
      seen.push(options)
      return resultOf({
        outcome: 'ok',
        completedNodeIds: [wf.drawflow.nodes[1]!.id],
        stoppedBefore: submit.id,
      })
    })
    const out = await runGenerationTrial(wf, { execute })
    expect(seen[0]?.stopBefore).toBe(submit.id)
    expect(seen[0]?.traceEntry).toBe('VERIFY')
    expect(out.record).toMatchObject({ outcome: 'partial', coveredSteps: 1, totalSteps: 2 })
  })

  it('turns a throw into a skipped trial on the SAME graph', async () => {
    const wf = chain([readStep()])
    const out = await runGenerationTrial(wf, {
      execute: vi.fn(async () => {
        throw new Error('NO_INJECTABLE_TAB')
      }),
    })
    expect(out.workflow).toBe(wf)
    expect(out.record).toMatchObject({ outcome: 'skipped' })
    expect(out.record.reason).toContain('NO_INJECTABLE_TAB')
  })

  it('records a failed run as a failed trial and still returns the graph', async () => {
    const wf = chain([readStep(), node('event-click', { selector: '#go' })])
    const out = await runGenerationTrial(wf, {
      execute: vi.fn(async () =>
        resultOf({
          outcome: 'failed',
          error: 'LOCATOR_NOT_FOUND: #go',
          completedNodeIds: [wf.drawflow.nodes[1]!.id],
          trace: { failedNodeId: wf.drawflow.nodes[2]!.id } as never,
        }),
      ),
    })
    expect(out.record).toMatchObject({
      outcome: 'failed',
      failedNodeId: wf.drawflow.nodes[2]!.id,
      failureCode: 'LOCATOR_NOT_FOUND',
      coveredSteps: 1,
    })
  })

  it('writes a degraded step back into the graph it returns', async () => {
    const click = node('event-click', { selector: '.order button' })
    const wf = chain([click])
    const out = await runGenerationTrial(wf, {
      execute: vi.fn(async () =>
        resultOf({
          outcome: 'ok',
          completedNodeIds: [wf.drawflow.nodes[1]!.id, click.id],
          degradations: [degradationOf(click)],
        }),
      ),
    })
    expect(out.record.degradedSteps).toBe(1)
    const healed = out.workflow.drawflow.nodes.find((n) => n.id === click.id)!
    expect(healed.data['selector']).toBe('#pay')
    expect(healed.data['__resolution']).toMatchObject({ rung: 2, to: 'css|#pay' })
    // The caller's graph is never mutated in place: the save writes the copy.
    expect(wf.drawflow.nodes.find((n) => n.id === click.id)!.data['selector']).toBe(
      '.order button',
    )
  })

  it('records a timeout when the budget runs out', async () => {
    const wf = chain([readStep()])
    const out = await runGenerationTrial(wf, {
      budgetMs: 5,
      execute: (_workflow, options) =>
        new Promise<ExecuteWorkflowResult>((resolve) => {
          options.signal.addEventListener('abort', () => resolve(resultOf({ outcome: 'cancelled' })), {
            once: true,
          })
        }),
    })
    expect(out.record.outcome).toBe('timeout')
    expect(out.workflow).toBe(wf)
  })

  it('stops the run when the caller cancels', async () => {
    const wf = chain([readStep()])
    const controller = new AbortController()
    const pending = runGenerationTrial(wf, {
      budgetMs: TRIAL_BUDGET_MS,
      signal: controller.signal,
      execute: (_workflow, options) =>
        new Promise<ExecuteWorkflowResult>((resolve) => {
          options.signal.addEventListener('abort', () => resolve(resultOf({ outcome: 'cancelled' })), {
            once: true,
          })
        }),
    })
    controller.abort()
    const out = await pending
    expect(out.record.outcome).toBe('cancelled')
  })

  it('never rejects, whatever the run primitive does', async () => {
    const wf = chain([readStep()])
    const failures: TrialExecute[] = [
      () => {
        throw new Error('boom')
      },
      async () => {
        throw new Error('async boom')
      },
    ]
    for (const execute of failures) {
      await expect(runGenerationTrial(wf, { execute })).resolves.toMatchObject({
        record: { outcome: 'skipped' },
      })
    }
  })
})

describe('createTrialExecute', () => {
  it('runs the graph as a verification run, with no AI takeover', async () => {
    const executeWorkflow = vi.fn(
      async (_workflow: Workflow, _options: ExecuteWorkflowOptions): Promise<ExecuteWorkflowResult> =>
        resultOf(),
    )
    const execute = createTrialExecute({ executeWorkflow, scopeWindowId: 7 })
    const wf = chain([readStep()])
    await execute(wf, { stopBefore: 'n9', signal: new AbortController().signal, traceEntry: 'VERIFY' })
    expect(executeWorkflow).toHaveBeenCalledWith(wf, {
      source: 'manual',
      traceEntry: 'VERIFY',
      scopeWindowId: 7,
      stopBefore: 'n9',
      signal: expect.any(AbortSignal),
    })
    // The trial proves the GRAPH, so a model that fixes a step mid-run would
    // prove nothing: takeover is never passed.
    expect(executeWorkflow.mock.calls[0]![1].aiTakeover).toBeUndefined()
  })
})

describe('independentVerifyStage', () => {
  it('stays pending when no trial ran', () => {
    expect(independentVerifyStage()).toMatchObject({
      stage: 'INDEPENDENT_VERIFY',
      status: 'pending',
    })
  })

  it('reports the coverage the trial actually proved', () => {
    expect(
      independentVerifyStage({
        outcome: 'partial',
        at: 1,
        full: false,
        coveredSteps: 3,
        totalSteps: 4,
      }),
    ).toMatchObject({ status: 'ok', counts: { coveredSteps: 3, totalSteps: 4 } })
  })

  it('never reports a failure as anything but a warning', () => {
    const stage = independentVerifyStage({
      outcome: 'failed',
      at: 1,
      full: false,
      coveredSteps: 1,
      totalSteps: 3,
      failureCode: 'LOCATOR_NOT_FOUND',
    })
    expect(stage.status).toBe('warn')
    expect(stage.summary).toContain('LOCATOR_NOT_FOUND')
  })

  it('leaves a skipped trial pending rather than dressing it up', () => {
    expect(independentVerifyStage(skippedTrialRecord('no page'))).toMatchObject({
      status: 'pending',
    })
  })
})

describe('withTrialRecord', () => {
  it('returns a new workflow and leaves the stored one alone', () => {
    const wf = chain([readStep()])
    const record: TrialRunRecord = {
      outcome: 'passed',
      at: 1,
      full: true,
      coveredSteps: 1,
      totalSteps: 1,
    }
    const next = withTrialRecord(wf, record)
    expect(next).not.toBe(wf)
    expect(next.settings.trialRun).toMatchObject({ outcome: 'passed' })
    expect(wf.settings.trialRun).toBeUndefined()
  })
})
