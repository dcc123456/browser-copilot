import { describe, expect, it } from 'vitest'
import {
  applyDebugDecision,
  buildBlockNode,
  describeNodeParams,
  patchNodeParams,
  removeNodes,
  setRetryPolicy,
  type DebugDecision,
} from '../src/lib/workflow/auto-debug-patch'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

/** Build a minimal Workflow from nodes + edges (mirrors workflow-engine.spec). */
function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

const node = (id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label: blockId,
  position: { x: 0, y: 0 },
  data: { blockId, description: '', ...data },
})

const edge = (source: string, target: string, handle?: string): WorkflowEdge => ({
  id: `${source}->${target}${handle ? `:${handle}` : ''}`,
  source,
  target,
  ...(handle ? { sourceHandle: handle } : {}),
})

describe('setRetryPolicy', () => {
  it('writes an engine-compatible onError policy and keeps other params', () => {
    const wf = makeWorkflow([node('a', 'trigger'), node('b', 'event-click')], [edge('a', 'b')])
    const applied = setRetryPolicy(wf, 'b', { retryTimes: 3, retryIntervalSec: 2 })
    expect(applied.changed).toBe(true)
    const onError = applied.workflow.drawflow.nodes[1]!.data['onError'] as Record<string, unknown>
    // Engine contract: enable + retry + toDo:'retry', interval stored in seconds.
    expect(onError).toMatchObject({ enable: true, retry: true, toDo: 'retry', retryTimes: 3, retryInterval: 2 })
    expect(applied.changes[0]).toContain('重试')
  })

  it('merges into an existing onError object instead of replacing it', () => {
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('b', 'event-click', { onError: { enable: true, toDo: 'error', errorMessage: 'boom' } })],
      [edge('a', 'b')],
    )
    const applied = setRetryPolicy(wf, 'b', { retryTimes: 2, retryIntervalSec: 5 })
    const onError = applied.workflow.drawflow.nodes[1]!.data['onError'] as Record<string, unknown>
    expect(onError['errorMessage']).toBe('boom')
    expect(onError['toDo']).toBe('retry')
    expect(onError['retryInterval']).toBe(5)
  })

  it('clamps nonsensical AI numbers into the engine-safe range', () => {
    const wf = makeWorkflow([node('a', 'trigger'), node('b', 'event-click')], [edge('a', 'b')])
    const applied = setRetryPolicy(wf, 'b', { retryTimes: 99, retryIntervalSec: 0.1 })
    const onError = applied.workflow.drawflow.nodes[1]!.data['onError'] as Record<string, unknown>
    expect(onError['retryTimes']).toBe(5)
    expect(onError['retryInterval']).toBe(1)
  })

  it('is a no-op for an unknown node and never mutates the input workflow', () => {
    const wf = makeWorkflow([node('a', 'trigger')], [])
    const applied = setRetryPolicy(wf, 'missing', {})
    expect(applied.changed).toBe(false)
    expect(applied.workflow).toBe(wf)
  })
})

describe('patchNodeParams', () => {
  it('merges corrected params flat onto node data and reports old → new', () => {
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('b', 'event-click', { selector: '.stale' })],
      [edge('a', 'b')],
    )
    const applied = patchNodeParams(wf, 'b', { selector: '.fresh' })
    expect(applied.changed).toBe(true)
    expect(applied.workflow.drawflow.nodes[1]!.data['selector']).toBe('.fresh')
    expect(applied.changes[0]).toContain('.stale')
    expect(applied.changes[0]).toContain('.fresh')
  })

  it('protects blockId and disableBlock from being rewritten', () => {
    // Canonical nodes carry the catalog defaults (incl. disableBlock: false).
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('b', 'event-click', { disableBlock: false })],
      [edge('a', 'b')],
    )
    const applied = patchNodeParams(wf, 'b', { blockId: 'ai-agent', disableBlock: true, selector: 'x' })
    expect(applied.changed).toBe(true)
    const data = applied.workflow.drawflow.nodes[1]!.data
    expect(data['blockId']).toBe('event-click')
    expect(data['disableBlock']).toBe(false)
    expect(data['selector']).toBe('x')
  })

  it('is a no-op on an empty patch', () => {
    const wf = makeWorkflow([node('a', 'trigger')], [])
    expect(patchNodeParams(wf, 'a', {}).changed).toBe(false)
  })
})

describe('buildBlockNode', () => {
  it('returns null for an unknown block id', () => {
    expect(buildBlockNode('not-a-block', {}, { x: 0, y: 0 }, 'd')).toBeNull()
  })

  it('fills catalog defaults, applies overrides and marks the node as AI-added', () => {
    const built = buildBlockNode(
      'element-exists',
      { selector: '.guard' },
      { x: 10, y: 20 },
      'AI 调试自动添加：元素存在守卫',
    )
    expect(built).not.toBeNull()
    expect(built!.data['blockId']).toBe('element-exists')
    expect(built!.data['selector']).toBe('.guard')
    expect(built!.data['throwError']).toBe(false)
    expect(built!.data['description']).toContain('AI 调试')
    expect(built!.label).toBe('Element exists')
  })

  it('generates unique ids across calls', () => {
    const a = buildBlockNode('delay', {}, { x: 0, y: 0 }, 'd')
    const b = buildBlockNode('delay', {}, { x: 0, y: 0 }, 'd')
    expect(a!.id).not.toBe(b!.id)
  })
})

describe('removeNodes', () => {
  it('splices a removed node: predecessors reconnect to its default downstream', () => {
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('dup', 'get-text'), node('c', 'delay')],
      [edge('a', 'dup'), edge('dup', 'c')],
    )
    const applied = removeNodes(wf, ['dup'])
    expect(applied.changed).toBe(true)
    expect(applied.workflow.drawflow.nodes.map((n) => n.id)).toEqual(['a', 'c'])
    expect(applied.workflow.drawflow.edges).toHaveLength(1)
    expect(applied.workflow.drawflow.edges[0]).toMatchObject({ source: 'a', target: 'c' })
    expect(applied.changes[0]).toContain('删除')
  })

  it('resolves splice targets through chains of removed nodes', () => {
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('dup1', 'get-text'), node('dup2', 'get-text'), node('c', 'delay')],
      [edge('a', 'dup1'), edge('dup1', 'dup2'), edge('dup2', 'c')],
    )
    const applied = removeNodes(wf, ['dup1', 'dup2'])
    expect(applied.changed).toBe(true)
    expect(applied.workflow.drawflow.edges).toEqual([
      expect.objectContaining({ source: 'a', target: 'c' }),
    ])
  })

  it('rewrites the targetHandle of spliced edges to the new target block', () => {
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('dup', 'get-text'), node('c', 'delay')],
      [edge('a', 'dup'), edge('dup', 'c')],
    )
    const applied = removeNodes(wf, ['dup'])
    expect(applied.workflow.drawflow.edges[0]!.targetHandle).toBe('delay-input-1')
  })

  it('never removes trigger blocks or the first node', () => {
    const wf = makeWorkflow(
      [node('t', 'trigger'), node('b', 'event-click')],
      [edge('t', 'b'), edge('b', 't')],
    )
    const applied = removeNodes(wf, ['t'])
    expect(applied.changed).toBe(false)
    expect(applied.workflow.drawflow.nodes).toHaveLength(2)
  })

  it('refuses to remove every node and ignores unknown ids', () => {
    const single = makeWorkflow([node('a', 'trigger')], [])
    expect(removeNodes(single, ['a']).changed).toBe(false)
    const wf = makeWorkflow([node('a', 'trigger'), node('b', 'delay')], [edge('a', 'b')])
    expect(removeNodes(wf, ['ghost']).changed).toBe(false)
  })

  it('drops dangling edges but keeps branches that only touch one removed node', () => {
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('dup', 'get-text'), node('keep', 'conditions'), node('c', 'delay')],
      [edge('a', 'dup'), edge('dup', 'keep'), edge('keep', 'c')],
    )
    const applied = removeNodes(wf, ['dup'])
    const targets = applied.workflow.drawflow.edges.map((e) => `${e.source}->${e.target}`)
    expect(targets).toEqual(['a->keep', 'keep->c'])
  })
})

describe('describeNodeParams', () => {
  it('summarizes params as key=value pairs and skips noise keys', () => {
    const line = describeNodeParams(
      node('b', 'event-click', {
        blockId: 'event-click',
        description: '人类描述',
        disableBlock: false,
        selector: '.submit',
        findBy: 'cssSelector',
        markEl: true,
        empty: '',
        gone: undefined,
        off: false,
      }),
    )
    expect(line).toContain('selector=.submit')
    expect(line).toContain('findBy=cssSelector')
    expect(line).toContain('markEl=true')
    expect(line).not.toContain('blockId')
    expect(line).not.toContain('description')
    expect(line).not.toContain('disableBlock')
    expect(line).not.toContain('empty')
    expect(line).not.toContain('off')
  })

  it('collapses the retry policy and truncates long values', () => {
    const line = describeNodeParams(
      node('b', 'event-click', {
        onError: { enable: true, retry: true, toDo: 'retry', retryTimes: 3, retryInterval: 2000 },
        selector: 'x'.repeat(120),
      }),
    )
    expect(line).toContain('onError=重试×3')
    expect(line).toMatch(/selector=x{50}…/)
    expect(line).not.toContain('retryTimes=')
  })

  it('returns an empty string for a bare node', () => {
    expect(describeNodeParams(node('b', 'delay'))).toBe('')
  })
})

describe('applyDebugDecision', () => {
  const base = (): Workflow =>
    makeWorkflow(
      [node('a', 'trigger'), node('b', 'event-click', { selector: '.stale' }), node('c', 'delay')],
      [edge('a', 'b'), edge('b', 'c')],
    )

  it('retry: routes to the retry policy op', () => {
    const decision: DebugDecision = { diagnosis: '抖动', strategy: 'retry', retryTimes: 2, retryIntervalSec: 3 }
    const applied = applyDebugDecision(base(), 'b', decision)
    const onError = applied.workflow.drawflow.nodes[1]!.data['onError'] as Record<string, unknown>
    expect(onError).toMatchObject({ toDo: 'retry', retryTimes: 2, retryInterval: 3 })
  })

  it('repair-params: merges the patch; empty patch is a no-op', () => {
    const applied = applyDebugDecision(base(), 'b', {
      diagnosis: '选择器过期',
      strategy: 'repair-params',
      paramsPatch: { selector: '.fresh' },
    })
    expect(applied.changed).toBe(true)
    expect(applied.workflow.drawflow.nodes[1]!.data['selector']).toBe('.fresh')

    const empty = applyDebugDecision(base(), 'b', { diagnosis: '', strategy: 'repair-params' })
    expect(empty.changed).toBe(false)
  })

  it('insert-branch (element-exists, skip): guard sits before the failing node with true/false routing', () => {
    const applied = applyDebugDecision(base(), 'b', {
      diagnosis: '元素可能不存在',
      strategy: 'insert-branch',
      branch: { kind: 'element-exists', selector: '.maybe', onFalse: 'skip' },
    })
    expect(applied.changed).toBe(true)
    const wf = applied.workflow
    const guard = wf.drawflow.nodes.find((n) => n.data['blockId'] === 'element-exists')!
    expect(guard.data['selector']).toBe('.maybe')
    const route = (from: string, suffix: string): string | undefined =>
      wf.drawflow.edges.find((e) => e.source === from && e.sourceHandle?.endsWith(suffix))?.target
    expect(route(guard.id, 'output-1')).toBe('b')
    expect(route(guard.id, 'output-2')).toBe('c') // skip → failing node's default next
    // Predecessor rewired to the guard with the guard's input handle.
    const intoGuard = wf.drawflow.edges.find((e) => e.target === guard.id)!
    expect(intoGuard.source).toBe('a')
    expect(intoGuard.targetHandle).toBe('element-exists-input-1')
  })

  it('insert-branch (onFalse ai-agent): false branch reaches an AI agent node', () => {
    const applied = applyDebugDecision(base(), 'b', {
      diagnosis: '页面改版',
      strategy: 'insert-branch',
      branch: { kind: 'element-exists', selector: '.maybe', onFalse: 'ai-agent', agentPrompt: '找到新元素' },
    })
    const wf = applied.workflow
    const agent = wf.drawflow.nodes.find((n) => n.data['blockId'] === 'ai-agent')!
    expect(agent.data['prompt']).toBe('找到新元素')
    const guard = wf.drawflow.nodes.find((n) => n.data['blockId'] === 'element-exists')!
    const falseTarget = wf.drawflow.edges.find(
      (e) => e.source === guard.id && e.sourceHandle?.endsWith('output-2'),
    )?.target
    expect(falseTarget).toBe(agent.id)
    // The agent then continues to the failing node's default downstream.
    const afterAgent = wf.drawflow.edges.find((e) => e.source === agent.id)?.target
    expect(afterAgent).toBe('c')
  })

  it('insert-branch: falls back to the failing node selector, else refuses', () => {
    const fallback = applyDebugDecision(base(), 'b', {
      diagnosis: '',
      strategy: 'insert-branch',
      branch: { kind: 'element-exists', onFalse: 'skip' },
    })
    expect(fallback.changed).toBe(true)
    expect(fallback.changes[0]).toContain('条件守卫')

    const selectorless = makeWorkflow(
      [node('a', 'trigger'), node('b', 'delay'), node('c', 'delay')],
      [edge('a', 'b'), edge('b', 'c')],
    )
    const refused = applyDebugDecision(selectorless, 'b', {
      diagnosis: '',
      strategy: 'insert-branch',
      branch: { kind: 'element-exists', onFalse: 'skip' },
    })
    expect(refused.changed).toBe(false)
  })

  it('insert-ai-agent: splices the agent before the failing node and applies extra params', () => {
    const applied = applyDebugDecision(base(), 'b', {
      diagnosis: '需要动态定位',
      strategy: 'insert-ai-agent',
      agent: { prompt: '重新定位', actOnPage: true },
      alsoPatchParams: { selector: '.new-home' },
    })
    expect(applied.changed).toBe(true)
    const wf = applied.workflow
    const agent = wf.drawflow.nodes.find((n) => n.data['blockId'] === 'ai-agent')!
    expect(agent.data['prompt']).toBe('重新定位')
    expect(wf.drawflow.edges.find((e) => e.source === 'a')?.target).toBe(agent.id)
    expect(wf.drawflow.edges.find((e) => e.source === agent.id)?.target).toBe('b')
    expect(wf.drawflow.nodes.find((n) => n.id === 'b')!.data['selector']).toBe('.new-home')
  })

  it('remove-redundant: deletes the ids the AI listed, splicing them out', () => {
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('dup', 'get-text'), node('b', 'event-click'), node('c', 'delay')],
      [edge('a', 'dup'), edge('dup', 'b'), edge('b', 'c')],
    )
    const applied = applyDebugDecision(wf, 'b', {
      diagnosis: '重复读取',
      strategy: 'remove-redundant',
      removeNodeIds: ['dup'],
    })
    expect(applied.changed).toBe(true)
    expect(applied.workflow.drawflow.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(applied.workflow.drawflow.edges).toEqual([
      expect.objectContaining({ source: 'a', target: 'b' }),
      expect.objectContaining({ source: 'b', target: 'c' }),
    ])
  })

  it('unfixable and unknown strategies never change the graph', () => {
    const wf = base()
    expect(applyDebugDecision(wf, 'b', { diagnosis: '缺登录', strategy: 'unfixable' })).toMatchObject({
      changed: false,
      workflow: wf,
    })
  })

  it('compositional removal: repair-params may also delete nodes that no longer make sense', () => {
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('dup', 'get-text'), node('b', 'event-click', { selector: '.stale' }), node('c', 'delay')],
      [edge('a', 'dup'), edge('dup', 'b'), edge('b', 'c')],
    )
    const applied = applyDebugDecision(wf, 'b', {
      diagnosis: '选择器过期且前置读取重复',
      strategy: 'repair-params',
      paramsPatch: { selector: '.fresh' },
      removeNodeIds: ['dup'],
    })
    expect(applied.changed).toBe(true)
    const out = applied.workflow
    expect(out.drawflow.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(out.drawflow.nodes[1]!.data['selector']).toBe('.fresh')
    expect(out.drawflow.edges).toEqual([
      expect.objectContaining({ source: 'a', target: 'b' }),
      expect.objectContaining({ source: 'b', target: 'c' }),
    ])
    expect(applied.changes.some((c) => c.includes('修正'))).toBe(true)
    expect(applied.changes.some((c) => c.includes('删除'))).toBe(true)
  })

  it('compositional removal: insert-ai-agent can carry removeNodeIds too', () => {
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('dup', 'get-text'), node('b', 'event-click'), node('c', 'delay')],
      [edge('a', 'dup'), edge('dup', 'b'), edge('b', 'c')],
    )
    const applied = applyDebugDecision(wf, 'b', {
      diagnosis: '页面改版',
      strategy: 'insert-ai-agent',
      agent: { prompt: '重新定位' },
      removeNodeIds: ['dup'],
    })
    expect(applied.changed).toBe(true)
    const ids = applied.workflow.drawflow.nodes.map((n) => n.id)
    expect(ids).not.toContain('dup')
    expect(applied.workflow.drawflow.nodes.find((n) => n.data['blockId'] === 'ai-agent')).toBeTruthy()
  })

  it('unfixable ignores removeNodeIds (never a mixed signal)', () => {
    const wf = makeWorkflow([node('a', 'trigger'), node('b', 'delay')], [edge('a', 'b')])
    const applied = applyDebugDecision(wf, 'b', {
      diagnosis: '',
      strategy: 'unfixable',
      removeNodeIds: ['b'],
    })
    expect(applied.changed).toBe(false)
    expect(applied.workflow.drawflow.nodes).toHaveLength(2)
  })

  it('all ops are pure: the input workflow object is never mutated', () => {
    const wf = base()
    const before = JSON.stringify(wf)
    applyDebugDecision(wf, 'b', {
      diagnosis: '',
      strategy: 'insert-branch',
      branch: { kind: 'element-exists', selector: '.x', onFalse: 'ai-agent', agentPrompt: 'p' },
    })
    applyDebugDecision(wf, 'b', { diagnosis: '', strategy: 'remove-redundant', removeNodeIds: ['b'] })
    applyDebugDecision(wf, 'b', { diagnosis: '', strategy: 'retry', retryTimes: 4 })
    expect(JSON.stringify(wf)).toBe(before)
  })
})
