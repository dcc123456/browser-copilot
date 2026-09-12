/**
 * Tests for the AI-debug session loop (`background/workflow-engine/debug-session`):
 *  - first-pass success ⇒ verified with nothing pending;
 *  - takeover fixes are applied to a COPY and verified by a takeover-free run;
 *    a passing verify run persists the fixes as pending for user confirmation;
 *  - a failing verify run starts the next round against the patched graph;
 *  - the original workflow is never mutated and auto-wait is force-enabled on
 *    interaction blocks only.
 *
 * Everything is dependency-injected: `run` and `savePending` are stubs, so no
 * chrome, storage or network is touched.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_WAIT_MS,
  applyTakeoverFixes,
  applyDefaultWaits,
  runDebugSession,
  withWaitFor,
  WAIT_BLOCKS,
  type DebugRunResult,
} from '../src/background/workflow-engine/debug-session'
import type { TakeoverFix, TakeoverReport } from '../src/lib/workflow/ai-takeover'
import type { GoalVerdict } from '../src/lib/workflow/debug-rewrite'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

const node = (id: string, label: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label,
  position: { x: 0, y: 0 },
  data: { ...data },
})

function makeWorkflow(nodes: WorkflowNode[] = [node('a', 'trigger')]): Workflow {
  return {
    id: 'wf',
    name: '下单流程',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges: [] },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

const fix = (nodeId = 'b', selector = '.fresh'): TakeoverFix => ({
  nodeId,
  nodeLabel: nodeId,
  paramsPatch: { selector },
  note: 'fix',
})

const takeoverReport = (completed: boolean, withFix?: TakeoverFix): TakeoverReport => ({
  nodeId: withFix?.nodeId ?? 'b',
  nodeLabel: 'b',
  completed,
  attempts: 1,
  ...(completed && withFix ? { fix: withFix } : {}),
  ...(completed ? { summary: 'done' } : { error: 'nope' }),
})

interface RunCall {
  workflow: Workflow
  hadTakeover: boolean
  /** M4: the debug session id the run was stamped with. */
  sessionId?: string
}

/** Builds deps.run: a scripted sequence of run results, recording each call. */
function scriptedRun(results: DebugRunResult[]) {
  const calls: RunCall[] = []
  const run = vi.fn(
    async (
      workflow: Workflow,
      opts: { aiTakeover?: unknown; sessionId?: string },
    ): Promise<DebugRunResult> => {
      calls.push({
        workflow: structuredClone(workflow),
        hadTakeover: !!opts.aiTakeover,
        sessionId: opts.sessionId,
      })
      const next = results[calls.length - 1] ?? {
        runId: 'r?',
        outcome: 'failed',
        error: 'script exhausted',
      }
      // Mirror the engine: a run WITH a takeover hook invokes it (once) while
      // running — that is how takeover reports reach the session.
      if (typeof opts.aiTakeover === 'function') {
        await (opts.aiTakeover as (request: unknown) => Promise<unknown>)({ failingNodeId: 'b' })
      }
      return next
    },
  )
  return { run, calls }
}

/** A takeover hook factory whose hook reports `report` then completes. */
function hookReporting(report: TakeoverReport | undefined) {
  return ({ onTakeover }: { onTakeover: (r: TakeoverReport) => void }) => {
    return async (): Promise<{ completed: boolean; summary?: string }> => {
      if (report) onTakeover(report)
      return { completed: true, summary: 'done' }
    }
  }
}

describe('withWaitFor', () => {
  it('force-enables waits on interaction blocks only, keeping user-set values', () => {
    const wf = makeWorkflow([
      node('t', 'trigger'),
      node('c', 'event-click', { selector: '.a' }),
      node('f', 'forms', { selector: '.b', waitForSelector: true, waitSelectorTimeout: 9000 }),
      node('d', 'delay', { time: 500 }),
      node('g', 'get-text', { selector: '.c' }),
    ])
    const out = withWaitFor(wf, 4000)
    expect(out.drawflow.nodes.find((n) => n.id === 'c')?.data).toMatchObject({
      waitForSelector: true,
      waitSelectorTimeout: 4000,
    })
    // User choice wins: untouched.
    expect(out.drawflow.nodes.find((n) => n.id === 'f')?.data).toMatchObject({
      waitForSelector: true,
      waitSelectorTimeout: 9000,
    })
    // Non-interaction blocks are untouched.
    expect(out.drawflow.nodes.find((n) => n.id === 'd')?.data['waitForSelector']).toBeUndefined()
    expect(out.drawflow.nodes.find((n) => n.id === 'g')?.data['waitForSelector']).toBeUndefined()
    // The input workflow is NOT mutated, and the known set covers the legacy ids.
    expect(wf.drawflow.nodes.find((n) => n.id === 'c')?.data['waitForSelector']).toBeUndefined()
    expect(WAIT_BLOCKS).toContain('click')
    expect(WAIT_BLOCKS).toContain('fill')
  })
})

describe('applyDefaultWaits', () => {
  it('force-enables a short wait on interaction blocks for normal runs', () => {
    const wf = makeWorkflow([node('t', 'trigger'), node('c', 'event-click', { selector: '.a' })])
    const out = applyDefaultWaits(wf, DEFAULT_WAIT_MS)
    expect(out.drawflow.nodes.find((n) => n.id === 'c')?.data).toMatchObject({
      waitForSelector: true,
      waitSelectorTimeout: DEFAULT_WAIT_MS,
    })
    // Pure: the input is untouched.
    expect(wf.drawflow.nodes.find((n) => n.id === 'c')?.data['waitForSelector']).toBeUndefined()
  })

  it('is a no-op when the window is 0 or negative (workflow opt-out)', () => {
    const wf = makeWorkflow([node('c', 'event-click', { selector: '.a' })])
    expect(applyDefaultWaits(wf, 0)).toBe(wf)
    expect(applyDefaultWaits(wf, -1)).toBe(wf)
  })
})

describe('applyTakeoverFixes', () => {
  it('patches nodes on copies and reports what changed', () => {
    const wf = makeWorkflow([
      node('a', 'trigger'),
      node('b', 'event-click', { selector: '.stale' }),
    ])
    const result = applyTakeoverFixes(wf, [fix('b', '.fresh')])
    expect(result.applied).toBe(1)
    expect(result.changes.join('\n')).toContain('.fresh')
    expect(result.workflow.drawflow.nodes.find((n) => n.id === 'b')?.data['selector']).toBe(
      '.fresh',
    )
    expect(wf.drawflow.nodes.find((n) => n.id === 'b')?.data['selector']).toBe('.stale')
  })

  it('skips fixes that target missing nodes or protected params', () => {
    const wf = makeWorkflow([
      node('a', 'trigger'),
      node('b', 'event-click', { selector: '.stale' }),
    ])
    // 'ghost' does not exist; blockId is engine-protected and never patched.
    const result = applyTakeoverFixes(wf, [fix('ghost'), fix('b')])
    const protectedAttempt = applyTakeoverFixes(wf, [
      { nodeId: 'b', nodeLabel: 'b', paramsPatch: { blockId: 'hijack' }, note: '' },
    ])
    expect(result.applied).toBe(1)
    expect(protectedAttempt.applied).toBe(0)
  })
})

describe('runDebugSession', () => {
  it('first-pass success: verified, nothing pending, one run, auto-wait copy', async () => {
    const original = makeWorkflow([
      node('a', 'trigger'),
      node('b', 'event-click', { selector: '.x' }),
    ])
    const { run, calls } = scriptedRun([{ runId: 'r1', outcome: 'ok', summary: '成功' }])
    const savePending = vi.fn().mockResolvedValue(undefined)
    const result = await runDebugSession(original, {
      run,
      createTakeover: hookReporting(undefined),
      savePending,
    })
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      attempts: 1,
      rounds: 1,
      summary: '成功',
      pendingChanges: [],
    })
    expect(calls).toHaveLength(1)
    // Auto-wait is enabled on the copy that actually ran — never on the input.
    expect(
      calls[0]?.workflow.drawflow.nodes.find((n) => n.id === 'b')?.data['waitForSelector'],
    ).toBe(true)
    expect(
      original.drawflow.nodes.find((n) => n.id === 'b')?.data['waitForSelector'],
    ).toBeUndefined()
    expect(savePending).not.toHaveBeenCalled()
  })

  it('run fails without fixes: session fails immediately', async () => {
    const { run, calls } = scriptedRun([{ runId: 'r1', outcome: 'failed', error: '元素未找到' }])
    const result = await runDebugSession(makeWorkflow(), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
    })
    expect(result).toMatchObject({
      ok: false,
      attempts: 1,
      error: '元素未找到',
      pendingChanges: [],
    })
    expect(calls).toHaveLength(1)
  })

  it('run cancelled: session reports cancelled', async () => {
    const { run } = scriptedRun([{ runId: 'r1', outcome: 'cancelled' }])
    const result = await runDebugSession(makeWorkflow(), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
    })
    expect(result.cancelled).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('full fix flow: takeover reports a fix, verify run passes on the patched copy', async () => {
    const theFix = fix('b', '.fresh')
    const { run, calls } = scriptedRun([
      { runId: 'r1', outcome: 'failed', error: '元素未找到: .stale' },
      { runId: 'r2', outcome: 'ok', summary: '通过' },
    ])
    const savePending = vi.fn().mockResolvedValue(undefined)
    const result = await runDebugSession(
      makeWorkflow([node('a', 'trigger'), node('b', 'event-click', { selector: '.stale' })]),
      {
        run,
        createTakeover: hookReporting(takeoverReport(true, theFix)),
        savePending,
      },
    )
    expect(result).toMatchObject({ ok: true, verified: true, attempts: 2, rounds: 1 })
    expect(result.pendingChanges).toHaveLength(1)
    expect(savePending).toHaveBeenCalledWith('wf', 'r2', [theFix])
    // Run 1 had the takeover hook; the verify run did NOT.
    expect(calls[0]?.hadTakeover).toBe(true)
    expect(calls[1]?.hadTakeover).toBe(false)
    // The verify run ran the PATCHED copy.
    expect(calls[1]?.workflow.drawflow.nodes.find((n) => n.id === 'b')?.data['selector']).toBe(
      '.fresh',
    )
  })

  it('verify failure starts round 2 against the patched copy and reports unverified', async () => {
    const theFix = fix('b', '.fresh')
    const { run, calls } = scriptedRun([
      { runId: 'r1', outcome: 'failed', error: 'e1' },
      { runId: 'r2', outcome: 'failed', error: 'still broken' },
      { runId: 'r3', outcome: 'failed', error: 'still broken 2' },
      { runId: 'r4', outcome: 'failed', error: 'still broken 3' },
    ])
    const savePending = vi.fn().mockResolvedValue(undefined)
    const result = await runDebugSession(
      makeWorkflow([node('a', 'trigger'), node('b', 'event-click', { selector: '.stale' })]),
      {
        run,
        maxRounds: 2,
        createTakeover: hookReporting(takeoverReport(true, theFix)),
        savePending,
      },
    )
    expect(result.ok).toBe(false)
    expect(result.verified).toBe(false)
    expect(result.rounds).toBe(2)
    expect(result.attempts).toBe(4)
    // Fixes that never verified are NOT saved for confirmation.
    expect(savePending).not.toHaveBeenCalled()
    expect(result.pendingChanges).toHaveLength(0)
    // Round 2's first run used the patched copy (carrying round 1's fix).
    expect(calls[2]?.workflow.drawflow.nodes.find((n) => n.id === 'b')?.data['selector']).toBe(
      '.fresh',
    )
  })

  it('ok run WITH fixes still verifies before saving anything', async () => {
    const theFix = fix('b', '.fresh')
    const { run, calls } = scriptedRun([
      { runId: 'r1', outcome: 'ok', summary: '通过' },
      { runId: 'r2', outcome: 'ok', summary: '验证通过' },
    ])
    const savePending = vi.fn().mockResolvedValue(undefined)
    const result = await runDebugSession(
      makeWorkflow([node('a', 'trigger'), node('b', 'event-click', { selector: '.stale' })]),
      {
        run,
        createTakeover: hookReporting(takeoverReport(true, theFix)),
        savePending,
      },
    )
    expect(result).toMatchObject({ ok: true, verified: true, attempts: 2 })
    expect(savePending).toHaveBeenCalledTimes(1)
    expect(calls[1]?.hadTakeover).toBe(false)
  })
})

describe('runDebugSession escalation (replay + graph audit)', () => {
  const rewritten = makeWorkflow([
    node('a', 'trigger'),
    node('b', 'event-click', { selector: '.fresh', description: '点新按钮' }),
  ])

  const auditDeps = (
    outcome: {
      diagnosis: string
      nodes: never[]
      changes: string[]
      rewritten: Workflow | null
    } | null,
  ) => ({
    replay: vi.fn(async (_wf: Workflow, onStep: (kind: 'tool', text: string) => void) => {
      onStep('tool', 'snapshot_page')
      return { completed: true, summary: '实际点了新按钮', trace: ['→ snapshot_page'] }
    }),
    audit: vi.fn(async () => outcome),
    saveRewrite: vi.fn().mockResolvedValue(undefined),
  })

  it('run fails without fixes → replay → audit → verified rewrite is offered', async () => {
    const { run, calls } = scriptedRun([
      { runId: 'r1', outcome: 'failed', error: '元素未找到: .stale' },
      { runId: 'r2', outcome: 'ok', summary: '通过' },
    ])
    const deps = auditDeps({ diagnosis: '选择器过期', nodes: [], changes: ['换按钮'], rewritten })
    const result = await runDebugSession(
      makeWorkflow([node('a', 'trigger'), node('b', 'event-click', { selector: '.stale' })]),
      {
        run,
        createTakeover: hookReporting(undefined),
        savePending: vi.fn(),
        ...deps,
      },
    )
    expect(deps.replay).toHaveBeenCalledTimes(1)
    expect(deps.audit).toHaveBeenCalledTimes(1)
    // The audit sees the replay summary + the failure context.
    const auditArgs = deps.audit.mock.calls[0] as unknown as [
      Workflow,
      { summary: string; trace: string[] },
      { error?: string },
    ]
    expect(auditArgs[1].summary).toContain('实际点了新按钮')
    expect(auditArgs[2].error).toContain('元素未找到')
    // The rewrite was VERIFY-RUN (no takeover) and only then saved as pending.
    expect(calls[1]?.hadTakeover).toBe(false)
    expect(calls[1]?.workflow.drawflow.nodes.find((n) => n.id === 'b')?.data['selector']).toBe(
      '.fresh',
    )
    expect(deps.saveRewrite).toHaveBeenCalledWith('wf', 'r2', {
      workflow: rewritten,
      changes: ['换按钮'],
      diagnosis: '选择器过期',
    })
    expect(result).toMatchObject({ ok: true, verified: true })
    expect(result.rewrite?.changes).toEqual(['换按钮'])
    expect(result.pendingChanges).toHaveLength(0)
  })

  it('an unusable audit graph fails honestly without saving anything', async () => {
    const { run } = scriptedRun([{ runId: 'r1', outcome: 'failed', error: 'e1' }])
    const deps = auditDeps({ diagnosis: '整图无法修复', nodes: [], changes: [], rewritten: null })
    const result = await runDebugSession(makeWorkflow(), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
      ...deps,
    })
    expect(result.ok).toBe(false)
    expect(result.summary).toBe('整图无法修复')
    expect(deps.saveRewrite).not.toHaveBeenCalled()
  })

  it('a rewrite whose verify run fails is NOT saved', async () => {
    const { run } = scriptedRun([
      { runId: 'r1', outcome: 'failed', error: 'e1' },
      { runId: 'r2', outcome: 'failed', error: 'still broken' },
    ])
    const deps = auditDeps({ diagnosis: '重建版', nodes: [], changes: ['x'], rewritten })
    const result = await runDebugSession(makeWorkflow(), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
      ...deps,
    })
    expect(result.ok).toBe(false)
    expect(deps.saveRewrite).not.toHaveBeenCalled()
  })

  it('without replay deps the session keeps the plain-failure result', async () => {
    const { run } = scriptedRun([{ runId: 'r1', outcome: 'failed', error: '元素未找到' }])
    const result = await runDebugSession(makeWorkflow(), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
    })
    expect(result).toMatchObject({ ok: false, error: '元素未找到' })
  })
})

describe('runDebugSession goal-completion check (目标达成判定)', () => {
  it('a no-error run that did NOT achieve the goal escalates instead of passing', async () => {
    const { run } = scriptedRun([
      {
        runId: 'r1',
        outcome: 'ok',
        summary: '成功',
        variables: { title: '' },
        steps: [{ kind: 'tool', text: '读取标题' }],
      },
    ])
    const goalCheck = vi.fn(
      async (_wf: Workflow, evidence: { variables: Record<string, unknown>; steps: unknown[] }) => {
        // The judge sees the run evidence.
        expect(evidence.steps).toHaveLength(1)
        expect(evidence.variables).toEqual({ title: '' })
        return { achieved: false, reason: 'title 变量为空，没有读到内容' }
      },
    )
    const result = await runDebugSession(makeWorkflow(), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
      goalCheck,
    })
    // No replay deps → honest failure, NOT a fake pass.
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('目标未达成')
    expect(result.goalAchieved).toBeUndefined()
  })

  it('a no-error run that achieved the goal passes with the judge note', async () => {
    const { run } = scriptedRun([{ runId: 'r1', outcome: 'ok', summary: '成功' }])
    const goalCheck = vi.fn(async () => ({ achieved: true, reason: '商品页已打开' }))
    const result = await runDebugSession(makeWorkflow(), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
      goalCheck,
    })
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      goalAchieved: true,
      goalNote: '商品页已打开',
    })
  })

  it('an unavailable goal judge falls back to the no-error standard', async () => {
    const { run } = scriptedRun([{ runId: 'r1', outcome: 'ok', summary: '成功' }])
    const goalCheck = vi.fn(async () => null)
    const result = await runDebugSession(makeWorkflow(), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
      goalCheck,
    })
    expect(result).toMatchObject({ ok: true, verified: true })
    expect(result.goalAchieved).toBeUndefined()
  })

  it('a verify run without errors but without goal achievement keeps looping / escalates', async () => {
    const { run } = scriptedRun([
      { runId: 'r1', outcome: 'failed', error: 'e1' },
      { runId: 'r2', outcome: 'ok', summary: '通过' },
    ])
    const goalCheck = vi.fn(async () => ({ achieved: false, reason: '表单没有提交成功' }))
    const savePending = vi.fn()
    const result = await runDebugSession(
      makeWorkflow([node('a', 'trigger'), node('b', 'event-click', { selector: '.stale' })]),
      {
        run,
        createTakeover: hookReporting(takeoverReport(true, fix('b', '.fresh'))),
        savePending,
        goalCheck,
        maxRounds: 1,
      },
    )
    // Nothing saved; the goal gap escalates (no replay deps → failure).
    expect(savePending).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('目标未达成')
  })

  it('a rewrite verify run without goal achievement is NOT saved', async () => {
    const rewritten = makeWorkflow([
      node('a', 'trigger'),
      node('b', 'event-click', { selector: '.fresh' }),
    ])
    const { run } = scriptedRun([
      { runId: 'r1', outcome: 'failed', error: 'e1' },
      { runId: 'r2', outcome: 'ok', summary: '通过' },
    ])
    const goalCheck = vi.fn(async () => ({ achieved: false, reason: '目标仍差一步' }))
    const saveRewrite = vi.fn().mockResolvedValue(undefined)
    const result = await runDebugSession(makeWorkflow(), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
      saveRewrite,
      goalCheck,
      replay: vi.fn(async () => ({ completed: true, summary: 's', trace: [] })),
      audit: vi.fn(async () => ({ diagnosis: 'd', nodes: [], changes: ['x'], rewritten })),
    })
    expect(saveRewrite).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('目标未达成')
  })
})

/**
 * Regression for the reported bug: a LOGIN workflow that already logged in.
 * The AI judged it "not successful", retried — but there is no login page
 * anymore, so every retry failed identically and the loop never ended.
 * These tests pin both escape hatches: the terminal-state verdict and the
 * repeated-dead-end breaker.
 */
describe('runDebugSession non-idempotent goals (已达成就不再重试)', () => {
  const LOGIN_ERROR = '元素未找到：#username'
  /** The judge recognising the terminal state (already logged in). */
  const alreadyLoggedIn = vi.fn(async () => ({
    achieved: true,
    alreadySatisfied: true,
    reason: '页面已进入账户中心且存在退出登录入口，登录态已生效',
  }))

  it('a failed run whose goal ALREADY holds stops the session as a success', async () => {
    // Round 1 fails: the login form is gone because we are already logged in.
    const { run, calls } = scriptedRun([{ runId: 'r1', outcome: 'failed', error: LOGIN_ERROR }])
    const result = await runDebugSession(makeWorkflow([node('a', 'trigger')]), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
      goalCheck: alreadyLoggedIn,
    })
    // No further rounds: retrying could never reach the login page again.
    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      goalAchieved: true,
      alreadySatisfied: true,
    })
    expect(result.summary).toContain('登录态已生效')
  })

  it('the terminal-state check runs BEFORE the replay, so no replay happens', async () => {
    const { run } = scriptedRun([{ runId: 'r1', outcome: 'failed', error: LOGIN_ERROR }])
    const replay = vi.fn(async () => ({ completed: true, summary: 's', trace: [] }))
    const audit = vi.fn(async () => ({ diagnosis: 'd', nodes: [], changes: [], rewritten: null }))
    const result = await runDebugSession(makeWorkflow([node('a', 'trigger')]), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
      goalCheck: alreadyLoggedIn,
      replay,
      audit,
    })
    expect(replay).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, alreadySatisfied: true })
  })

  it('the verify-failure path also stops when the goal already holds', async () => {
    // Round 1 round fails with a fix, the takeover-free verify fails too
    // (no login page), and the judge recognises the terminal state.
    const { run, calls } = scriptedRun([
      { runId: 'r1', outcome: 'failed', error: LOGIN_ERROR },
      { runId: 'r2', outcome: 'failed', error: LOGIN_ERROR },
    ])
    const result = await runDebugSession(
      makeWorkflow([node('a', 'trigger'), node('b', 'forms', { selector: '#username' })]),
      {
        run,
        createTakeover: hookReporting(takeoverReport(true, fix('b', '.other'))),
        savePending: vi.fn(),
        goalCheck: alreadyLoggedIn,
        maxRounds: 3,
      },
    )
    // Stops after the failed verify — round 2 is never started.
    expect(calls).toHaveLength(2)
    expect(result).toMatchObject({ ok: true, alreadySatisfied: true })
  })

  it('an achieved verdict WITHOUT alreadySatisfied does not short-circuit a failed run', async () => {
    const { run } = scriptedRun([{ runId: 'r1', outcome: 'failed', error: LOGIN_ERROR }])
    const result = await runDebugSession(makeWorkflow([node('a', 'trigger')]), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
      // "Achieved" but NOT flagged as a terminal state → a real retry is sane.
      goalCheck: vi.fn(async () => ({ achieved: true, reason: '看起来没问题' })),
    })
    expect(result.ok).toBe(false)
    expect(result.alreadySatisfied).toBeUndefined()
  })

  it('the judge is told the run FAILED so it can test the terminal state', async () => {
    const { run } = scriptedRun([{ runId: 'r1', outcome: 'failed', error: LOGIN_ERROR }])
    const goalCheck = vi.fn(
      async (_wf: Workflow, evidence: { runFailed?: boolean }): Promise<GoalVerdict | null> => {
        expect(evidence.runFailed).toBe(true)
        return { achieved: true, alreadySatisfied: true, reason: '已登录' }
      },
    )
    await runDebugSession(makeWorkflow([node('a', 'trigger')]), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
      goalCheck,
    })
    expect(goalCheck).toHaveBeenCalled()
  })

  it('the SAME failure recurring stops the loop instead of retrying forever', async () => {
    // Five rounds allowed, but every round fails with the identical error:
    // a login page that will never come back.
    const { run, calls } = scriptedRun(
      Array.from({ length: 10 }, (_, i) => ({
        runId: `r${i + 1}`,
        outcome: 'failed' as const,
        error: LOGIN_ERROR,
      })),
    )
    const result = await runDebugSession(
      makeWorkflow([node('a', 'trigger'), node('b', 'forms', { selector: '#username' })]),
      {
        run,
        createTakeover: hookReporting(takeoverReport(true, fix('b', '.other'))),
        savePending: vi.fn(),
        // No judge available → the breaker is the only guard.
        maxRounds: 5,
      },
    )
    // Stopped well before the 5 rounds (10 runs) would have been spent.
    expect(calls.length).toBeLessThan(10)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('重复失败')
  })

  it('a session id is stamped onto every run the session spawns', async () => {
    // Round 1 (takeover) + the takeover-free verify run must both carry it, so
    // the session's runs, checkpoints and stats can be joined afterwards.
    const { run, calls } = scriptedRun([
      { runId: 'r1', outcome: 'failed', error: 'e1' },
      { runId: 'r2', outcome: 'ok', summary: 'ok' },
    ])
    const savePending = vi.fn().mockResolvedValue(undefined)
    await runDebugSession(
      makeWorkflow([node('a', 'trigger'), node('b', 'event-click', { selector: '.stale' })]),
      {
        run,
        createTakeover: hookReporting(takeoverReport(true, fix('b', '.fresh'))),
        savePending,
        sessionId: 'sess-1',
        goalCheck: vi.fn(async () => ({ achieved: true, reason: '目标达成' })),
      },
    )
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.sessionId === 'sess-1')).toBe(true)
    expect(savePending).toHaveBeenCalled()
  })

  it('without a session id the runs are left unstamped', async () => {
    const { run, calls } = scriptedRun([{ runId: 'r1', outcome: 'ok', summary: 'ok' }])
    await runDebugSession(makeWorkflow([node('a', 'trigger')]), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
    })
    expect(calls[0]?.sessionId).toBeUndefined()
  })

  it('a normal verified success is NOT flagged as already satisfied', async () => {
    const { run } = scriptedRun([{ runId: 'r1', outcome: 'ok', summary: '成功' }])
    const result = await runDebugSession(makeWorkflow([node('a', 'trigger')]), {
      run,
      createTakeover: hookReporting(undefined),
      savePending: vi.fn(),
      goalCheck: vi.fn(async () => ({ achieved: true, reason: '商品页已打开' })),
    })
    expect(result).toMatchObject({ ok: true, verified: true, goalAchieved: true })
    expect(result.alreadySatisfied).toBeUndefined()
  })
})
