import { describe, expect, it } from 'vitest'
import {
  buildFailureContext,
  debugWorkflow,
  failingNodeIdOf,
  type AutoDebugDeps,
  type RunAttempt,
} from '../src/background/workflow-engine/auto-debug'
import { buildDebugPrompt, parseDecision } from '../src/background/workflow-engine/auto-debug-ai'
import type { DebugDecision, DebugStepLine } from '../src/lib/workflow/auto-debug-patch'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

function makeWorkflow(): Workflow {
  const node = (id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode => ({
    id,
    label: blockId,
    position: { x: 0, y: 0 },
    data: { blockId, description: '', ...data },
  })
  const edge = (source: string, target: string): WorkflowEdge => ({
    id: `${source}->${target}`,
    source,
    target,
  })
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: {
      nodes: [
        node('a', 'trigger'),
        node('b', 'event-click', { selector: '.stale' }),
        node('c', 'delay'),
      ],
      edges: [edge('a', 'b'), edge('b', 'c')],
    },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

/** A runner whose outcomes follow a script; failures always blame node `b`. */
function scriptedRun(outcomes: ('ok' | 'failed')[], runs?: Workflow[]) {
  let index = 0
  return async (wf: Workflow): Promise<RunAttempt> => {
    runs?.push(wf)
    const outcome = outcomes[Math.min(index, outcomes.length - 1)]!
    index += 1
    if (outcome === 'ok') {
      return { runId: `run-${index}`, outcome: 'ok', summary: 'done', steps: [] }
    }
    const steps: DebugStepLine[] = [
      { kind: 'tool', nodeId: 'a', text: '' },
      { kind: 'error', nodeId: 'b', text: '元素未找到: .stale' },
    ]
    return {
      runId: `run-${index}`,
      outcome: 'failed',
      summary: '元素未找到',
      error: '元素未找到: .stale',
      steps,
    }
  }
}

describe('failingNodeIdOf', () => {
  it('returns the last error step that carries a node id', () => {
    const steps: DebugStepLine[] = [
      { kind: 'error', nodeId: 'b', text: 'x' },
      { kind: 'status', text: 'mid' },
      { kind: 'error', nodeId: 'c', text: 'y' },
    ]
    expect(failingNodeIdOf(steps)).toBe('c')
  })

  it('returns undefined when no error step has a node id', () => {
    expect(failingNodeIdOf([{ kind: 'error', text: 'engine-level' }])).toBeUndefined()
    expect(failingNodeIdOf([])).toBeUndefined()
  })
})

describe('buildFailureContext', () => {
  it('probes the failing node selector and merges page facts', async () => {
    const probed: string[] = []
    const ctx = await buildFailureContext(
      makeWorkflow(),
      'b',
      'boom',
      [{ kind: 'error', nodeId: 'b', text: 'boom' }],
      {
        probe: async (selector) => {
          probed.push(selector)
          return 0
        },
        pageFacts: async () => ({ url: 'https://x/', title: 'Page' }),
      },
    )
    expect(probed).toEqual(['.stale'])
    expect(ctx.pageFacts).toEqual({ url: 'https://x/', title: 'Page', selectorMatches: { '.stale': 0 } })
    expect(ctx.failingNodeId).toBe('b')
  })

  it('inspects the page around the failing selector and passes the elements through', async () => {
    const inspected: string[] = []
    const elements = { target: { found: false }, candidates: [{ selector: '.fresh' }], interactive: [] }
    const ctx = await buildFailureContext(makeWorkflow(), 'b', 'boom', [], {
      probe: async () => 0,
      inspectPage: async (selector) => {
        inspected.push(selector)
        return elements
      },
    })
    expect(inspected).toEqual(['.stale'])
    expect(ctx.pageFacts?.elements).toBe(elements)
  })

  it('tolerates probe/page-fact/inspection failures and omits the facts', async () => {
    const ctx = await buildFailureContext(makeWorkflow(), 'b', 'boom', [], {
      probe: async () => {
        throw new Error('no page')
      },
      pageFacts: async () => {
        throw new Error('no page')
      },
      inspectPage: async () => {
        throw new Error('no page')
      },
    })
    expect(ctx.pageFacts).toBeUndefined()
  })
})

describe('onDebugStep live log', () => {
  it('streams the debug milestones: run, failure, diagnosis, changes, verify, save', async () => {
    const log: { kind: string; text: string }[] = []
    await debugWorkflow(makeWorkflow(), {
      run: scriptedRun(['failed', 'ok']),
      aiDecide: async () => ({
        diagnosis: '选择器过期',
        strategy: 'repair-params',
        paramsPatch: { selector: '.fresh' },
      }),
      save: async () => {},
      onDebugStep: (kind, text) => log.push({ kind, text }),
    })
    expect(log.some((e) => e.kind === 'status' && e.text.includes('第 1 次运行'))).toBe(true)
    expect(log.some((e) => e.kind === 'error' && e.text.includes('运行失败'))).toBe(true)
    expect(log.some((e) => e.kind === 'status' && e.text.includes('页面元素'))).toBe(true)
    expect(log.some((e) => e.kind === 'result' && e.text.includes('选择器过期'))).toBe(true)
    expect(log.some((e) => e.text.includes('修正参数') || e.text.includes('修复策略'))).toBe(true)
    expect(log.some((e) => e.text.includes('.fresh'))).toBe(true)
    expect(log.some((e) => e.kind === 'status' && e.text.includes('已保存'))).toBe(true)
    // On success the final result line is the run's own summary ('done' from
    // the scripted runner), falling back to the fixed wording.
    expect(
      log.some((e) => e.kind === 'result' && (e.text.includes('done') || e.text.includes('验证通过'))),
    ).toBe(true)
  })

  it('reports an AI failure into the live log', async () => {
    const log: { kind: string; text: string }[] = []
    await debugWorkflow(makeWorkflow(), {
      run: scriptedRun(['failed']),
      aiDecide: async () => {
        throw new Error('model exploded')
      },
      save: async () => {},
      onDebugStep: (kind, text) => log.push({ kind, text }),
    })
    expect(log.some((e) => e.kind === 'error' && e.text.includes('AI 诊断失败'))).toBe(true)
    expect(log.some((e) => e.text.includes('model exploded'))).toBe(true)
  })

  it('works without a log sink (optional dep)', async () => {
    const result = await debugWorkflow(makeWorkflow(), {
      run: scriptedRun(['failed', 'ok']),
      aiDecide: async () => ({ diagnosis: 'd', strategy: 'retry', retryTimes: 2, retryIntervalSec: 1 }),
      save: async () => {},
    })
    expect(result.ok).toBe(true)
  })
})

describe('debugWorkflow', () => {
  it('a passing first run never calls the AI or saves', async () => {
    let aiCalls = 0
    let saves = 0
    const result = await debugWorkflow(makeWorkflow(), {
      run: async (wf) => {
        void wf
        return { runId: 'r1', outcome: 'ok', summary: 'done', steps: [] }
      },
      aiDecide: async () => {
        aiCalls += 1
        return { diagnosis: '', strategy: 'unfixable' }
      },
      save: async () => {
        saves += 1
      },
    })
    expect(result).toMatchObject({ ok: true, attempts: 1, workflowModified: false, rounds: [] })
    expect(aiCalls).toBe(0)
    expect(saves).toBe(0)
  })

  it('a cancelled first run stops without AI involvement', async () => {
    const result = await debugWorkflow(makeWorkflow(), {
      run: async () => ({ runId: 'r1', outcome: 'cancelled', steps: [] }),
      aiDecide: async () => ({ diagnosis: '', strategy: 'retry' }),
      save: async () => {},
    })
    expect(result).toMatchObject({ ok: false, cancelled: true, attempts: 1, workflowModified: false })
  })

  it('retry decision: onError policy is saved and the second run passes', async () => {
    const runs: Workflow[] = []
    const saves: Workflow[] = []
    const decision: DebugDecision = {
      diagnosis: '偶发超时',
      strategy: 'retry',
      retryTimes: 3,
      retryIntervalSec: 2,
    }
    const result = await debugWorkflow(makeWorkflow(), {
      run: scriptedRun(['failed', 'ok'], runs),
      aiDecide: async () => decision,
      save: async (wf) => {
        saves.push(wf)
      },
    })
    expect(result.ok).toBe(true)
    expect(result.workflowModified).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.rounds[0]).toMatchObject({ strategy: 'retry', runOutcome: 'ok' })
    expect(saves).toHaveLength(1)
    const onError = saves[0]!.drawflow.nodes[1]!.data['onError'] as Record<string, unknown>
    expect(onError).toMatchObject({ enable: true, retry: true, toDo: 'retry', retryTimes: 3, retryInterval: 2 })
  })

  it('repair-params decision: the patch reaches the saved workflow', async () => {
    const saves: Workflow[] = []
    const result = await debugWorkflow(makeWorkflow(), {
      run: scriptedRun(['failed', 'ok']),
      aiDecide: async () => ({
        diagnosis: '选择器过期',
        strategy: 'repair-params',
        paramsPatch: { selector: '.fresh' },
      }),
      save: async (wf) => {
        saves.push(wf)
      },
    })
    expect(result.ok).toBe(true)
    expect(saves[0]!.drawflow.nodes[1]!.data['selector']).toBe('.fresh')
  })

  it('unfixable decision stops after the first run without saving', async () => {
    let saves = 0
    const result = await debugWorkflow(makeWorkflow(), {
      run: scriptedRun(['failed']),
      aiDecide: async () => ({ diagnosis: '登录失效', strategy: 'unfixable' }),
      save: async () => {
        saves += 1
      },
    })
    expect(result).toMatchObject({ ok: false, attempts: 1, workflowModified: false })
    expect(saves).toBe(0)
    expect(result.rounds[0]).toMatchObject({ strategy: 'unfixable', changes: [] })
  })

  it('an unusable repair (unknown node id) stops without saving', async () => {
    let saves = 0
    const result = await debugWorkflow(makeWorkflow(), {
      run: scriptedRun(['failed']),
      aiDecide: async () => ({
        diagnosis: '删除',
        strategy: 'remove-redundant',
        removeNodeIds: ['ghost'],
      }),
      save: async () => {
        saves += 1
      },
    })
    expect(result.ok).toBe(false)
    expect(saves).toBe(0)
    expect(result.rounds[0]!.changes[0]).toContain('未找到')
  })

  it('AI failures degrade to unfixable rounds instead of crashing', async () => {
    const result = await debugWorkflow(makeWorkflow(), {
      run: scriptedRun(['failed']),
      aiDecide: async () => {
        throw new Error('model exploded')
      },
      save: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.rounds[0]).toMatchObject({ strategy: 'unfixable' })
    expect(result.rounds[0]!.diagnosis).toContain('model exploded')
  })

  it('no attributable failing node → no AI call', async () => {
    let aiCalls = 0
    const result = await debugWorkflow(makeWorkflow(), {
      run: async () => ({
        runId: 'r1',
        outcome: 'failed',
        error: '步骤超限',
        steps: [{ kind: 'error', text: '步骤超限' }],
      }),
      aiDecide: async () => {
        aiCalls += 1
        return { diagnosis: '', strategy: 'retry' }
      },
      save: async () => {},
    })
    expect(aiCalls).toBe(0)
    expect(result.attempts).toBe(1)
    expect(result.rounds).toHaveLength(0)
  })

  it('stops after maxAIRounds when every re-run still fails', async () => {
    let aiCalls = 0
    const result = await debugWorkflow(makeWorkflow(), {
      run: scriptedRun(['failed']),
      aiDecide: async () => {
        aiCalls += 1
        return { diagnosis: '再试一次', strategy: 'retry', retryTimes: 1, retryIntervalSec: 1 }
      },
      save: async () => {},
    })
    expect(aiCalls).toBe(2)
    expect(result.attempts).toBe(3)
    expect(result.ok).toBe(false)
    expect(result.workflowModified).toBe(true)
    expect(result.rounds).toHaveLength(2)
  })

  it('rejects a concurrent debug of the same workflow, allows others afterwards', async () => {
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const wf = { ...makeWorkflow(), id: 'busy-wf' }
    let firstStarted = false
    const deps: AutoDebugDeps = {
      run: async () => {
        if (!firstStarted) {
          firstStarted = true
          await gate
        }
        return { runId: 'r', outcome: 'ok', steps: [] }
      },
      aiDecide: async () => ({ diagnosis: '', strategy: 'unfixable' }),
      save: async () => {},
    }
    const first = debugWorkflow(wf, deps)
    const second = await debugWorkflow(wf, deps)
    expect(second.attempts).toBe(0)
    expect(second.summary).toContain('已在调试中')
    releaseFirst()
    expect((await first).ok).toBe(true)
  })

  it('an insert-branch repair produces an engine-runnable graph that gets saved', async () => {
    const saves: Workflow[] = []
    const result = await debugWorkflow(makeWorkflow(), {
      run: scriptedRun(['failed', 'ok']),
      aiDecide: async () => ({
        diagnosis: '元素时有时无',
        strategy: 'insert-branch',
        branch: { kind: 'element-exists', selector: '.maybe', onFalse: 'skip' },
      }),
      save: async (wf) => {
        saves.push(wf)
      },
    })
    expect(result.ok).toBe(true)
    const wf = saves[0]!
    const guard = wf.drawflow.nodes.find((n) => n.data['blockId'] === 'element-exists')!
    expect(guard).toBeTruthy()
    // a → guard → (true) b; guard → (false) c
    expect(wf.drawflow.edges.find((e) => e.source === 'a')?.target).toBe(guard.id)
    expect(wf.drawflow.edges.find((e) => e.source === guard.id && e.sourceHandle?.endsWith('output-1'))?.target).toBe('b')
    expect(wf.drawflow.edges.find((e) => e.source === guard.id && e.sourceHandle?.endsWith('output-2'))?.target).toBe('c')
  })
})

describe('parseDecision', () => {
  it('parses a clean JSON reply', () => {
    const decision = parseDecision(
      '{"diagnosis":"超时","strategy":"retry","retryTimes":3,"retryIntervalSec":2}',
    )
    expect(decision).toMatchObject({ diagnosis: '超时', strategy: 'retry', retryTimes: 3, retryIntervalSec: 2 })
  })

  it('tolerates prose and markdown around the JSON', () => {
    const decision = parseDecision('好的，我的分析如下：\n```json\n{"diagnosis":"d","strategy":"repair-params","paramsPatch":{"selector":".x"}}\n```')
    expect(decision.strategy).toBe('repair-params')
    expect(decision.paramsPatch).toEqual({ selector: '.x' })
  })

  it('degrades to unfixable on garbage, empty or unknown-strategy replies', () => {
    expect(parseDecision('对不起，我做不到').strategy).toBe('unfixable')
    expect(parseDecision('').strategy).toBe('unfixable')
    expect(parseDecision('{"strategy":"explode"}').strategy).toBe('unfixable')
    expect(parseDecision('{"strategy":"retry"}').diagnosis).not.toBe('')
  })

  it('validates branch/agent payloads and string arrays', () => {
    const decision = parseDecision(
      '{"diagnosis":"d","strategy":"insert-branch","branch":{"kind":"element-exists","selector":".s","onFalse":"ai-agent","agentPrompt":"go"},"removeNodeIds":["a",42,null]}',
    )
    expect(decision.branch).toMatchObject({ kind: 'element-exists', selector: '.s', onFalse: 'ai-agent', agentPrompt: 'go' })
    expect(decision.removeNodeIds).toEqual(['a'])
    expect(parseDecision('{"strategy":"insert-branch","branch":"nope"}').branch).toBeUndefined()
  })
})

describe('buildDebugPrompt', () => {
  it('contains the graph, the failure, the strategies and the page facts', () => {
    const prompt = buildDebugPrompt({
      workflow: makeWorkflow(),
      failingNodeId: 'b',
      error: '元素未找到: .stale',
      steps: [{ kind: 'error', nodeId: 'b', text: '元素未找到: .stale' }],
      pageFacts: { url: 'https://x/', selectorMatches: { '.stale': 0 } },
    })
    expect(prompt).toContain('event-click')
    expect(prompt).toContain('.stale')
    expect(prompt).toContain('元素未找到')
    expect(prompt).toContain('remove-redundant')
    expect(prompt).toContain('https://x/')
    expect(prompt).toContain('".stale":0')
  })

  it('includes the inspected page elements and the combined-removal rule', () => {
    const prompt = buildDebugPrompt({
      workflow: makeWorkflow(),
      failingNodeId: 'b',
      error: '元素未找到',
      steps: [],
      pageFacts: {
        selectorMatches: { '.stale': 0 },
        elements: { target: { found: false, matches: 0 }, candidates: [{ selector: 'button.submit', text: '提交' }] },
      },
    })
    expect(prompt).toContain('Page elements')
    expect(prompt).toContain('button.submit')
    expect(prompt).toContain('removeNodeIds')
  })

  it('truncates overlong param strings so one node cannot blow the context', () => {
    const wf = makeWorkflow()
    wf.drawflow.nodes[1]!.data['selector'] = 'x'.repeat(500)
    const prompt = buildDebugPrompt({ workflow: wf, error: 'e', steps: [] })
    expect(prompt).toContain('…')
    expect(prompt.length).toBeLessThan(4000)
  })
})
