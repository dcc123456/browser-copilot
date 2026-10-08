/**
 * Page-context reanchoring — the deterministic repair for a WRONG_ORIGIN the
 * graph itself causes: the recorded grounding disagrees with the site the
 * graph's own first navigation drives onto, so the anchor moves (and only the
 * anchor moves) before the replay proves it.
 */
import { describe, expect, it, vi } from 'vitest'
import { runAutoRepair, type AutoRepairDeps } from '../src/background/workflow-engine/auto-repair/orchestrator'
import type { WorkflowCondition } from '../src/lib/workflow/conditions'
import { PatchEngine } from '../src/lib/workflow/repair/patch-engine'
import { applyRepairCandidate } from '../src/lib/workflow/repair-candidate'
import type { FailureAnalysis } from '../src/lib/workflow/repair/types'
import { pageContextOf } from '../src/lib/workflow/page-context'
import {
  navigationAnchorOf,
  pageContextReanchorCandidate,
  pageContextReanchorPatchSet,
} from '../src/lib/workflow/page-context-reanchor'
import type { Workflow } from '../src/lib/workflow/types'
import { edge, linearChain, makeWorkflow, node } from './repair/helpers'

const GUARD_MESSAGE =
  'WRONG_ORIGIN: 当前页面（https://creator.xiaohongshu.com）不是该工作流的目标站点（https://github.com）'

/** t → nav(url) — the shape where the graph contradicts its own grounding. */
function graphWithNavigationFirst(url = 'https://creator.example.com/publish'): Workflow {
  const chain = linearChain(['t', 'nav', 'click'], (id) =>
    id === 't' ? 'trigger' : id === 'nav' ? 'new-tab' : 'event-click',
  )
  const nav = chain.nodes[1]!
  nav.data = { ...nav.data, url }
  return makeWorkflow(
    chain.nodes,
    [edge('t', 'nav'), edge('nav', 'click')],
  )
}

function groundedWith(expectedOrigin: string, workflow: Workflow): Workflow {
  return {
    ...workflow,
    settings: { ...workflow.settings, generationOriginUrl: expectedOrigin },
  }
}

function analysisFor(): FailureAnalysis {
  return {
    analysisVersion: 1,
    analysisId: 'a1',
    failedNodeId: 'nav',
    rootCauseNodeIds: [],
    failureType: 'WRONG_ORIGIN',
    repairTarget: 'NO_SAFE_REPAIR',
    dependencyChain: [],
    variableEvidence: [],
    pageEvidence: [],
    alternatives: [],
    explanation: GUARD_MESSAGE,
    confidence: 1,
    retryRecommended: false,
  }
}

describe('navigationAnchorOf', () => {
  it('reads the destination of the graph\'s own first navigation', () => {
    const anchor = navigationAnchorOf(graphWithNavigationFirst())
    expect(anchor).toEqual({
      nodeId: 'nav',
      url: 'https://creator.example.com/publish',
      origin: 'https://creator.example.com',
    })
  })

  it('refuses to anchor past a page action or past a dynamic destination', () => {
    const actsFirst = makeWorkflow(
      [node('t', 'trigger'), node('click', 'event-click', { selector: '.x' }), node('nav', 'new-tab', { url: 'https://a.test/' })],
      [edge('t', 'click'), edge('click', 'nav')],
    )
    expect(navigationAnchorOf(actsFirst)).toBeUndefined()

    expect(navigationAnchorOf(graphWithNavigationFirst('{{targetUrl}}'))).toBeUndefined()
    expect(navigationAnchorOf(groundedWith('https://github.com', makeWorkflow([node('t', 'trigger')], [])))).toBeUndefined()
  })
})

describe('pageContextReanchorCandidate', () => {
  it('moves only the anchor, and only when the graph is self-contradicting', () => {
    const workflow = groundedWith('https://github.com', graphWithNavigationFirst())
    const candidate = pageContextReanchorCandidate(workflow)!
    expect(candidate.strategy).toBe('page-context-reanchor')
    expect(candidate.settingsPatch).toEqual({ pageContext: { origin: 'https://creator.example.com' } })
    expect(candidate.nodePatches).toEqual([])
    expect(candidate.edgePatches).toEqual([])
    expect(candidate.reason).toContain('https://creator.example.com')

    const applied = applyRepairCandidate(workflow, candidate)
    expect(applied.issues).toEqual([])
    expect(pageContextOf(applied.workflow)).toEqual({ origin: 'https://creator.example.com' })
    // The original is untouched until a verified commit.
    expect(pageContextOf(workflow)?.origin).toBe('https://github.com')
    expect(applied.workflow.drawflow.nodes).toEqual(workflow.drawflow.nodes)
  })

  it('finds nothing to re-anchor when there is no grounding or no contradiction', () => {
    expect(pageContextReanchorCandidate(graphWithNavigationFirst())).toBeUndefined()
    expect(
      pageContextReanchorCandidate(groundedWith('https://creator.example.com', graphWithNavigationFirst())),
    ).toBeUndefined()
    expect(
      pageContextReanchorCandidate(
        groundedWith('https://github.com', makeWorkflow([node('t', 'trigger'), node('click', 'event-click', { selector: '.x' })], [edge('t', 'click')])),
      ),
    ).toBeUndefined()
  })
})

describe('pageContextReanchorPatchSet (v1 patch vocabulary)', () => {
  it('validates and applies through the PatchEngine as a workflow-level operation', () => {
    const workflow = groundedWith('https://github.com', graphWithNavigationFirst())
    const patch = pageContextReanchorPatchSet(workflow, 'a1')!
    expect(patch.operations[0]?.kind).toBe('SET_PAGE_CONTEXT_ORIGIN')
    expect(patch.operations[0]?.before).toBe('https://github.com')
    expect(patch.operations[0]?.after).toBe('https://creator.example.com')

    const engine = new PatchEngine()
    const analysis = analysisFor()
    expect(engine.validatePatch(workflow, analysis, patch).ok).toBe(true)
    const applied = engine.applyPatch(workflow, analysis, patch)
    expect(pageContextOf(applied.workflow)).toEqual({ origin: 'https://creator.example.com' })
    expect(applied.workflow.drawflow.nodes).toEqual(workflow.drawflow.nodes)
  })

  it('rejects a stale patch and a non-canonical origin', () => {
    const workflow = groundedWith('https://github.com', graphWithNavigationFirst())
    const engine = new PatchEngine()
    const analysis = analysisFor()
    const patch = pageContextReanchorPatchSet(workflow, 'a1')!

    const stale = { ...patch, operations: [{ ...patch.operations[0]!, before: 'https://other.test' }] }
    const staleResult = engine.validatePatch(workflow, analysis, stale)
    expect(staleResult.ok).toBe(false)
    expect(staleResult.issues[0]?.message).toContain('stale')

    const junk = { ...patch, operations: [{ ...patch.operations[0]!, after: 'creator.example.com/publish' }] }
    const junkResult = engine.validatePatch(workflow, analysis, junk)
    expect(junkResult.ok).toBe(false)
    expect(junkResult.issues[0]?.message).toContain('canonical')
  })
})

describe('auto-repair: the reanchor closes the WRONG_ORIGIN loop without a model', () => {
  function deps(overrides: Partial<AutoRepairDeps> = {}): AutoRepairDeps {
    return {
      produceCandidate: vi.fn(async () => {
        throw new Error('the deterministic reanchor must not ask the model')
      }),
      attemptReadinessRecovery: vi.fn(async () => ({ ok: false })),
      resumeRun: vi.fn(async () => ({ outcome: 'passed' as const })),
      verification: {
        evaluateConditions: vi.fn(
          async (conditions: WorkflowCondition[]) =>
            conditions.map((condition) => ({ condition, satisfied: true })),
        ),
      },
      commit: vi.fn(async () => 7),
      emit: vi.fn(),
      ...overrides,
    }
  }

  it('replays with the re-anchored grounding and commits an ai-repair revision', async () => {
    const workflow = groundedWith('https://github.com', graphWithNavigationFirst())
    const d = deps()
    const session = await runAutoRepair({
      workflow,
      runId: 'run-1',
      failure: {
        nodeId: 'nav',
        blockId: 'new-tab',
        errorType: 'PAGE_CONTEXT_MISMATCH',
        errorMessage: GUARD_MESSAGE,
        page: {},
      },
      deps: d,
    })

    expect(session.final).toMatchObject({ status: 'success', strategy: 'page-context-reanchor', committed: true })
    const strategies = session.attempts.map((attempt) => attempt.strategy)
    expect(strategies[strategies.length - 1]).toBe('page-context-reanchor')
    expect(strategies.filter((strategy) => strategy !== 'terminal-state-check' && strategy !== 'page-context-reanchor')).toEqual([])
    expect(d.produceCandidate).not.toHaveBeenCalled()
    expect(d.attemptReadinessRecovery).not.toHaveBeenCalled()
    expect(session.modelCalls).toBe(0)

    const committed = vi.mocked(d.commit).mock.calls[0]?.[0]
    expect(committed && pageContextOf(committed)).toEqual({ origin: 'https://creator.example.com' })
    const replayed = vi.mocked(d.resumeRun).mock.calls[0]?.[0]
    expect(replayed && pageContextOf(replayed)).toEqual({ origin: 'https://creator.example.com' })
  })

  it('advances past the reanchor when the graph gives no anchor, still without a human gate', async () => {
    const workflow = groundedWith('https://github.com', makeWorkflow(
      [node('t', 'trigger'), node('click', 'event-click', { selector: '.x' })],
      [edge('t', 'click')],
    ))
    const d = deps({ produceCandidate: vi.fn(async () => null) })
    const session = await runAutoRepair({
      workflow,
      runId: 'run-2',
      failure: {
        nodeId: 'click',
        blockId: 'event-click',
        errorType: 'PAGE_CONTEXT_MISMATCH',
        errorMessage: GUARD_MESSAGE,
        page: {},
      },
      deps: d,
    })

    const reanchorAttempt = session.attempts.find((attempt) => attempt.strategy === 'page-context-reanchor')
    expect(reanchorAttempt?.outcome).toBe('no-candidate')
    expect(session.final?.status).not.toBe('blocked')
    expect(session.final?.reason ?? '').not.toMatch(/human/i)
  })
})
