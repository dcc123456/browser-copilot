import { describe, expect, it } from 'vitest'
import {
  collectDependencies,
  rewriteWorkflowCalls,
  workflowCalls,
} from '../src/lib/marketplace/dependencies'
import type { Workflow } from '../src/lib/workflow/types'

function callNode(id: string, target: unknown): Workflow['drawflow']['nodes'][number] {
  return {
    id,
    label: 'Execute workflow',
    position: { x: 0, y: 0 },
    data: { blockId: 'execute-workflow', values: { workflowId: target } },
  }
}

function workflow(id: string, name: string, nodes: Workflow['drawflow']['nodes'] = []): Workflow {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 2,
    trigger: { type: 'manual' },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes, edges: [] },
  }
}

function calling(id: string, name: string, ...targets: string[]): Workflow {
  return workflow(
    id,
    name,
    targets.map((target, index) => callNode(`n${index}`, target)),
  )
}

describe('workflowCalls', () => {
  it('reads the editor value container and the legacy top-level layout', () => {
    const legacy: Workflow['drawflow']['nodes'][number] = {
      id: 'old',
      label: 'Execute workflow',
      position: { x: 0, y: 0 },
      data: { blockId: 'execute-workflow', workflowId: '  child-1  ' },
    }
    const graph = workflow('root', 'Root', [callNode('new', 'child-2'), legacy])
    expect(workflowCalls(graph)).toEqual([
      { nodeId: 'new', nodeLabel: 'Execute workflow', workflowId: 'child-2' },
      { nodeId: 'old', nodeLabel: 'Execute workflow', workflowId: 'child-1' },
    ])
  })

  it('ignores blocks that do not call another workflow', () => {
    const graph = workflow('root', 'Root', [
      { id: 'p', label: 'Open page', position: { x: 0, y: 0 }, data: { blockId: 'new-tab' } },
    ])
    expect(workflowCalls(graph)).toEqual([])
  })
})

describe('collectDependencies', () => {
  it('bundles a called workflow as a deps file', () => {
    const root = calling('root', 'Publish report', 'child')
    const child = workflow('child', 'Collect numbers')

    const plan = collectDependencies(root, [root, child])

    expect(plan.missing).toEqual([])
    expect(plan.dependencies.map((dependency) => dependency.path)).toEqual([
      'deps/collect-numbers.json',
    ])
    expect(plan.dependencies[0]!.workflow.id).toBe('child')
  })

  it('walks transitively and lists a dependency after the workflows it calls', () => {
    const root = calling('root', 'Root', 'middle')
    const middle = calling('middle', 'Middle', 'leaf')
    const leaf = workflow('leaf', 'Leaf')

    const plan = collectDependencies(root, [root, middle, leaf])

    expect(plan.dependencies.map((dependency) => dependency.workflow.id)).toEqual([
      'leaf',
      'middle',
    ])
  })

  it('bundles a shared dependency once', () => {
    const root = calling('root', 'Root', 'a', 'b')
    const a = calling('a', 'A', 'shared')
    const b = calling('b', 'B', 'shared')
    const shared = workflow('shared', 'Shared')

    const plan = collectDependencies(root, [root, a, b, shared])

    expect(plan.dependencies.map((dependency) => dependency.workflow.id).sort()).toEqual([
      'a',
      'b',
      'shared',
    ])
  })

  it('cuts cycles and ignores a workflow calling itself', () => {
    const root = calling('root', 'Root', 'child')
    const child = calling('child', 'Child', 'root', 'child')

    const plan = collectDependencies(root, [root, child])

    expect(plan.missing).toEqual([])
    expect(plan.dependencies.map((dependency) => dependency.workflow.id)).toEqual(['child'])
  })

  it('reports a missing target once, however many steps call it', () => {
    const root = calling('root', 'Root', 'gone', 'gone')

    const plan = collectDependencies(root, [root])

    expect(plan.dependencies).toEqual([])
    expect(plan.missing).toEqual([
      { nodeId: 'n0', nodeLabel: 'Execute workflow', workflowId: 'gone' },
    ])
  })

  it('reports empty and run-time-only targets instead of publishing a dangling call', () => {
    const root = workflow('root', 'Root', [
      callNode('empty', ''),
      callNode('dynamic', '{{targetWorkflow}}'),
    ])

    const plan = collectDependencies(root, [root])

    expect(plan.missing.map((call) => call.workflowId)).toEqual(['', '{{targetWorkflow}}'])
  })

  it('gives same-named dependencies distinct files', () => {
    const root = calling('root', 'Root', 'a', 'b')
    const first = workflow('a', 'Export orders')
    const second = workflow('b', 'Export orders')

    const plan = collectDependencies(root, [root, first, second])

    expect(plan.dependencies.map((dependency) => dependency.path)).toEqual([
      'deps/export-orders.json',
      'deps/export-orders-2.json',
    ])
  })
})

describe('rewriteWorkflowCalls', () => {
  const ids = new Map([['child', 'mkt-parent-abcdef-child']])

  it('rewrites the value container the engine reads', () => {
    const rewritten = rewriteWorkflowCalls(calling('root', 'Root', 'child'), ids)
    expect(rewritten.drawflow.nodes[0]!.data).toEqual({
      blockId: 'execute-workflow',
      values: { workflowId: 'mkt-parent-abcdef-child' },
    })
  })

  it('rewrites a legacy top-level call without inventing a value container', () => {
    const legacy = workflow('root', 'Root', [
      {
        id: 'old',
        label: 'Execute workflow',
        position: { x: 0, y: 0 },
        data: { blockId: 'execute-workflow', workflowId: 'child' },
      },
    ])
    const rewritten = rewriteWorkflowCalls(legacy, ids)
    expect(rewritten.drawflow.nodes[0]!.data).toEqual({
      blockId: 'execute-workflow',
      workflowId: 'mkt-parent-abcdef-child',
    })
  })

  it('leaves calls it does not own alone and does not mutate the input', () => {
    const original = calling('root', 'Root', 'elsewhere')
    const rewritten = rewriteWorkflowCalls(original, ids)

    expect(rewritten.drawflow.nodes[0]!.data['values']).toEqual({
      workflowId: 'elsewhere',
    })
    expect(original.drawflow.nodes[0]!.data['values']).toEqual({ workflowId: 'elsewhere' })
  })
})
