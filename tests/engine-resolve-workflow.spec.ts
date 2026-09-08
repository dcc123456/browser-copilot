import { describe, expect, it } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import type { BlockExecutor } from '../src/background/workflow-engine/executors'
import { interpolate } from '../src/lib/workflow/interpolate'
import type { Workflow } from '../src/lib/workflow/types'

/**
 * The server's engine injection point: `WorkflowRunOptions.resolveWorkflow`
 * lets a Node runner source `execute-workflow` children from its own store
 * instead of the extension's chrome storage. This spec pins the contract:
 * injection resolves the child, shares variables, and propagates a missing
 * child as a non-fatal engine error line.
 */

const setVariable: BlockExecutor = async (data, ctx) => {
  const name = String(data['variableName'] ?? '')
  // The extension's set-variable interpolates at write time.
  ctx.variables[name] = interpolate(String(data['value'] ?? ''), ctx.variables)
  return null
}

const executors: Record<string, BlockExecutor> = {
  trigger: async () => null,
  'set-variable': setVariable,
}

function linearWorkflow(id: string, name: string, blocks: { id: string; blockId: string; data?: Record<string, unknown> }[]): Workflow {
  const nodes = [
    { id: 't1', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
    ...blocks.map((b) => ({ id: b.id, label: b.blockId, position: { x: 100, y: 100 }, data: { blockId: b.blockId, ...b.data } })),
  ]
  const chain = ['t1', ...blocks.map((b) => b.id)]
  const edges = chain.slice(0, -1).map((source, i) => ({ id: `e-${i}`, source, target: chain[i + 1]! }))
  return { id, name, drawflow: { nodes, edges } } as unknown as Workflow
}

describe('engine resolveWorkflow injection', () => {
  it('runs a referenced child through the injected resolver and shares variables', async () => {
    const child = linearWorkflow('child-1', '子流程', [
      { id: 's1', blockId: 'set-variable', data: { variableName: 'fromChild', value: 'child-value' } },
    ])
    const parent = linearWorkflow('parent-1', '父流程', [
      {
        id: 'sub1',
        blockId: 'execute-workflow',
        data: { values: { workflowId: 'child-1' } },
      },
      { id: 'p1', blockId: 'set-variable', data: { variableName: 'afterSub', value: '{{fromChild}}!' } },
    ])

    const result = await runWorkflow(parent, {
      variables: {},
      signal: new AbortController().signal,
      executors,
      resolveWorkflow: async (wfId) => (wfId === 'child-1' ? child : null),
    })

    expect(result.outcome).toBe('ok')
    expect(result.variables?.['fromChild']).toBe('child-value')
    // The parent continues AFTER the child and can reference child outputs.
    expect(result.variables?.['afterSub']).toBe('child-value!')
  })

  it('falls back to the chrome-storage resolver when no injection is given', async () => {
    // In Node there is no chrome.storage: the default path must fail soft with
    // a friendly error line, not crash the process.
    const parent = linearWorkflow('parent-2', '父', [
      { id: 'sub1', blockId: 'execute-workflow', data: { values: { workflowId: 'ghost' } } },
    ])
    const result = await runWorkflow(parent, {
      variables: {},
      signal: new AbortController().signal,
      executors,
    })
    expect(result.outcome).toBe('ok') // missing child is logged, not fatal
    expect(result.steps?.some((s) => s.text.includes('未找到工作流 ghost'))).toBe(true)
  })

  it('guards recursive references via parentWorkflowIds even with injection', async () => {
    const selfRef = linearWorkflow('self', '自引用', [
      { id: 'sub1', blockId: 'execute-workflow', data: { values: { workflowId: 'self' } } },
      { id: 's2', blockId: 'set-variable', data: { variableName: 'done', value: 'yes' } },
    ])
    // Child-run emits are forwarded through onStep with a `[子] ` prefix —
    // that is where the recursion-guard error becomes observable.
    const lines: string[] = []
    const result = await runWorkflow(selfRef, {
      variables: {},
      signal: new AbortController().signal,
      executors,
      resolveWorkflow: async (wfId) => (wfId === 'self' ? selfRef : null),
      onStep: (_kind, _nodeId, text) => lines.push(text),
    })
    expect(result.outcome).toBe('ok')
    expect(lines.some((text) => text.includes('自循环'))).toBe(true)
    // The flow continued past the blocked recursion (in the nested run).
    expect(result.variables?.['done']).toBe('yes')
  })
})
