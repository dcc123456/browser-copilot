/**
 * The graph validation and assembly used by the MCP `save_workflow` tool.
 * These are the checks that keep a hand-authored graph from being saved with
 * dangling edges or unknown blocks.
 */
import { describe, expect, it } from 'vitest'
import {
  assembleAuthoredWorkflow,
  AUTHORED_GRAPH_LIMITS,
  validateAuthoredGraph,
  type AuthoredGraphInput,
} from '../src/lib/workflow/authored-graph'

function node(id: string, blockId: string, position = { x: 0, y: 0 }): Record<string, unknown> {
  return { id, label: blockId, position, data: { blockId } }
}

function edge(id: string, source: string, target: string): Record<string, unknown> {
  return {
    id,
    source,
    target,
    sourceHandle: `${source}-output-1`,
    targetHandle: `${target}-input-1`,
  }
}

function validGraph(): AuthoredGraphInput {
  return {
    name: 'Data only',
    nodes: [node('t1', 'trigger'), node('p1', 'parse-excel'), node('e1', 'export-data')],
    edges: [edge('e-t1-p1', 't1', 'p1'), edge('e-p1-e1', 'p1', 'e1')],
  }
}

describe('validateAuthoredGraph', () => {
  it('accepts a well-formed trigger → operators chain', () => {
    const result = validateAuthoredGraph(validGraph())
    expect(result.errors).toEqual([])
    expect(result.nodes).toHaveLength(3)
    expect(result.edges).toHaveLength(2)
  })

  it('rejects dangling edge endpoints', () => {
    const graph = validGraph()
    graph.edges = [edge('e1', 't1', 'missing')]
    expect(validateAuthoredGraph(graph).errors).toContain('edge e1 target "missing" is not a node')
  })

  it('rejects unknown block ids', () => {
    const graph = validGraph()
    graph.nodes = [node('t1', 'trigger'), node('x1', 'not-a-real-block')]
    expect(validateAuthoredGraph(graph).errors.join(' ')).toContain('unknown blockId')
  })

  it('rejects duplicate node and edge ids', () => {
    const graph = validGraph()
    graph.nodes = [node('same', 'trigger'), node('same', 'export-data')]
    graph.edges = [edge('same', 'same', 'same'), edge('same', 'same', 'same')]
    const errors = validateAuthoredGraph(graph).errors
    expect(errors).toContain('duplicate node ids')
    expect(errors).toContain('duplicate edge ids')
  })

  it('requires a trigger node or trigger spec', () => {
    const graph = validGraph()
    graph.nodes = [node('p1', 'parse-excel')]
    graph.edges = []
    expect(validateAuthoredGraph(graph).errors).toContain(
      'a graph needs a trigger node or a trigger spec',
    )
  })

  it('accepts a trigger spec in place of a trigger node', () => {
    const graph = validGraph()
    graph.nodes = [node('p1', 'parse-excel')]
    graph.edges = []
    graph.trigger = { type: 'manual', enabled: true }
    expect(validateAuthoredGraph(graph).errors).toEqual([])
  })

  it('warns on label/blockId mismatch and missing handles', () => {
    const graph = validGraph()
    graph.nodes = [
      node('t1', 'trigger'),
      { ...node('p1', 'parse-excel'), label: 'Read sheet' },
      node('e1', 'export-data'),
    ]
    graph.edges = [{ id: 'e-t1-p1', source: 't1', target: 'p1' }, edge('e-p1-e1', 'p1', 'e1')]
    const warnings = validateAuthoredGraph(graph).warnings.join(' ')
    expect(warnings).toContain('differs from blockId')
    expect(warnings).toContain('no explicit handle')
  })

  it('caps graph size', () => {
    const graph = validGraph()
    graph.nodes = Array.from({ length: AUTHORED_GRAPH_LIMITS.nodes + 1 }, (_, i) =>
      node(`n${i}`, 'parse-excel'),
    )
    expect(validateAuthoredGraph(graph).errors.join(' ')).toContain('nodes exceed the limit')
  })
})

describe('assembleAuthoredWorkflow', () => {
  it('fills id, timestamps, settings and trigger defaults', () => {
    const workflow = assembleAuthoredWorkflow(validGraph(), {
      id: 'w-new',
      createdAt: 100,
      updatedAt: 200,
    })
    expect(workflow).not.toBeNull()
    expect(workflow!.id).toBe('w-new')
    expect(workflow!.createdAt).toBe(100)
    expect(workflow!.updatedAt).toBe(200)
    expect(workflow!.trigger).toEqual({ type: 'manual', enabled: true })
    expect(workflow!.settings.saveLog).toBe(false)
    expect(workflow!.drawflow.nodes).toHaveLength(3)
  })

  it('keeps a supplied trigger and settings overrides', () => {
    const graph = validGraph()
    graph.trigger = { type: 'manual', enabled: false }
    graph.settings = { saveLog: true }
    const workflow = assembleAuthoredWorkflow(graph, { id: 'w', createdAt: 0, updatedAt: 0 })
    expect(workflow!.trigger).toEqual({ type: 'manual', enabled: false })
    expect(workflow!.settings.saveLog).toBe(true)
  })

  it('refuses to assemble an invalid graph', () => {
    const graph = validGraph()
    graph.edges = [edge('bad', 't1', 'nowhere')]
    expect(assembleAuthoredWorkflow(graph, { id: 'w', createdAt: 0, updatedAt: 0 })).toBeNull()
  })
})
