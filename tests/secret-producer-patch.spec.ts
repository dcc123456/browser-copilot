import { describe, expect, it } from 'vitest'
import {
  ensureSecretProducer,
  secretVariableNameOf,
  type SecretFieldRef,
} from '../src/lib/workflow/var-suggestions'
import type { SuggestionGraph } from '../src/lib/workflow/var-suggestions'
import type { WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'
import { incomingNormalEdges } from '../src/lib/workflow/graph-edges'

/**
 * Securing a `get-secret` producer for a credential picked from the `/` menu.
 *
 * The value must never land in the workflow, so a pick has to resolve to a
 * variable a block fills at run time. Two shapes are acceptable: reuse a
 * producer that already runs before this node, or splice a new one into the
 * node's normal incoming edge. Splicing must not touch a fallback branch or a
 * loop-back — those are an error path and a retry, not the step being edited.
 */

const ref: SecretFieldRef = { credentialId: 'gh', fieldKey: 'token' }

let ids = 0
const newId = (): string => `n${(ids += 1)}`

const node = (id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label: blockId,
  position: { x: 0, y: 0 },
  data: { blockId, ...data },
})

const edge = (source: string, target: string, sourceHandle?: string): WorkflowEdge => ({
  id: `${source}->${target}${sourceHandle ? `-${sourceHandle}` : ''}`,
  source,
  target,
  sourceHandle,
})

function graph(nodes: WorkflowNode[], edges: WorkflowEdge[]): SuggestionGraph {
  return { nodes, edges }
}

/** Apply a patch the way the editor does, to check what a second pick sees. */
function apply(
  graphInput: SuggestionGraph,
  patch: ReturnType<typeof ensureSecretProducer>,
): SuggestionGraph {
  return {
    trigger: graphInput.trigger,
    nodes: patch.added ? [...graphInput.nodes, patch.added] : graphInput.nodes,
    edges: patch.edges ?? graphInput.edges,
  }
}

describe('ensureSecretProducer — reuse', () => {
  it("returns the reachable producer's own variable name", () => {
    const nodes = [
      node('t', 'trigger'),
      node('fetch', 'get-secret', { credential: 'gh::token', variableName: 'githubToken' }),
      node('post', 'forms'),
    ]
    const edges = [edge('t', 'fetch'), edge('fetch', 'post')]
    const patch = ensureSecretProducer(graph(nodes, edges), 'post', ref, newId)
    expect(patch).toEqual({ variableName: 'githubToken', reused: true })
  })

  it('names an existing producer that was left blank', () => {
    const nodes = [
      node('t', 'trigger'),
      node('fetch', 'get-secret', { credential: 'gh::token', variableName: '' }),
      node('post', 'forms'),
    ]
    const edges = [edge('t', 'fetch'), edge('fetch', 'post')]
    const patch = ensureSecretProducer(graph(nodes, edges), 'post', ref, newId)
    expect(patch.variableName).toBe(secretVariableNameOf(ref))
    expect(patch.nodePatch).toEqual({
      nodeId: 'fetch',
      patch: { variableName: secretVariableNameOf(ref) },
    })
  })

  it('ignores a producer that cannot reach this node', () => {
    const nodes = [
      node('t', 'trigger'),
      node('post', 'forms'),
      node('elsewhere', 'get-secret', { credential: 'gh::token', variableName: 'githubToken' }),
    ]
    const edges = [edge('t', 'post')]
    const patch = ensureSecretProducer(graph(nodes, edges), 'post', ref, newId)
    expect(patch.reused).toBe(false)
    expect(patch.variableName).toBe(secretVariableNameOf(ref))
  })

  it('does not reuse a producer fetching a different field', () => {
    const nodes = [
      node('t', 'trigger'),
      node('fetch', 'get-secret', { credential: 'gh::other', variableName: 'otherToken' }),
      node('post', 'forms'),
    ]
    const edges = [edge('t', 'fetch'), edge('fetch', 'post')]
    expect(ensureSecretProducer(graph(nodes, edges), 'post', ref, newId).reused).toBe(false)
  })
})

describe('ensureSecretProducer — splice a new node in', () => {
  const chain = () => [
    node('t', 'trigger'),
    node('prev', 'get-text', { variableName: 'title' }),
    node('post', 'forms'),
  ]
  const chainEdges = () => [edge('t', 'prev'), edge('prev', 'post')]

  it('rewires the normal feed and connects the new node', () => {
    const base = graph(chain(), chainEdges())
    const patch = ensureSecretProducer(base, 'post', ref, newId)
    const added = patch.added as WorkflowNode
    expect(added.data).toMatchObject({
      blockId: 'get-secret',
      credential: 'gh::token',
      variableName: secretVariableNameOf(ref),
    })
    // React Flow silently drops an edge whose handle ids do not resolve, so the
    // handles must follow the block-id convention.
    const rewired = (patch.edges as WorkflowEdge[]).find((e) => e.target === added.id)
    expect(rewired).toMatchObject({ source: 'prev', targetHandle: 'get-secret-input-1' })
    const onward = (patch.edges as WorkflowEdge[]).find((e) => e.source === added.id)
    expect(onward).toMatchObject({
      target: 'post',
      sourceHandle: 'get-secret-output-1',
      targetHandle: 'forms-input-1',
    })
    expect((patch.edges as WorkflowEdge[]).length).toBe(base.edges.length + 1)
  })

  it('leaves a fallback branch pointing at the node alone', () => {
    const nodes = [...chain(), node('cond', 'conditions')]
    const edges = [
      ...chainEdges(),
      edge('post', 'cond'),
      edge('cond', 'post', 'conditions-output-fallback'),
    ]
    const patch = ensureSecretProducer(graph(nodes, edges), 'post', ref, newId)
    const fallback = (patch.edges as WorkflowEdge[]).find(
      (e) => e.sourceHandle === 'conditions-output-fallback',
    )
    expect(fallback?.target).toBe('post')
  })

  it('lands clear of the node already sitting where it would go', () => {
    const nodes = [
      node('t', 'trigger'),
      { ...node('prev', 'get-text', { variableName: 'title' }), position: { x: -240, y: 0 } },
      node('post', 'forms'),
    ]
    const patch = ensureSecretProducer(graph(nodes, chainEdges()), 'post', ref, newId)
    expect(patch.added?.position).toEqual({ x: -240, y: 90 })
  })

  it('reports detached when the node has nothing to splice into', () => {
    const nodes = [node('t', 'trigger'), node('post', 'forms')]
    const patch = ensureSecretProducer(graph(nodes, []), 'post', ref, newId)
    expect(patch.detached).toBe(true)
    expect(patch.edges).toEqual([])
  })

  it('is idempotent: the second pick reuses what the first one inserted', () => {
    const base = graph(chain(), chainEdges())
    const first = ensureSecretProducer(base, 'post', ref, newId)
    const second = ensureSecretProducer(apply(base, first), 'post', ref, newId)
    expect(second.reused).toBe(true)
    expect(second.variableName).toBe(first.variableName)
    expect(second.added).toBeUndefined()
  })

  it('splices the single normal feed of a plain chain', () => {
    const base = graph(chain(), chainEdges())
    const patch = ensureSecretProducer(base, 'post', ref, newId)
    expect(incomingNormalEdges(base.edges, 'post').map((feed) => feed.id)).toEqual(['prev->post'])
    expect(
      (patch.edges as WorkflowEdge[]).filter((e) => e.target === patch.added?.id),
    ).toHaveLength(1)
  })

  it('reports detached rather than severing a node caught in a cycle', () => {
    // prev -> post -> prev is a retry pair: the canvas treats both halves as
    // loop-backs, so there is no normal input to splice into. Inventing a
    // connection here would rewrite the retry semantics — report it instead.
    const nodes = chain()
    const edges = [...chainEdges(), edge('post', 'prev')]
    const patch = ensureSecretProducer(graph(nodes, edges), 'post', ref, newId)
    expect(patch.detached).toBe(true)
    expect(patch.added).toBeDefined()
  })
})
