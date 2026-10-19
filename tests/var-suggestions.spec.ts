import { describe, expect, it } from 'vitest'
import {
  collectSuggestions,
  filterSuggestions,
  placeClearOfNodes,
  type SecretOption,
  type SuggestionGraph,
} from '../src/lib/workflow/var-suggestions'
import {
  credentialRefOf,
  parseCredentialRef,
  secretVariableNameOf,
} from '../src/lib/workflow/secret-params'
import { LOOP_CONTEXT_NAMES } from '../src/lib/workflow/repair/variable-provenance'
import { ENGINE_PROVIDED_NAMES } from '../src/lib/workflow/integrity'
import type { WorkflowEdge, WorkflowNode, WorkflowTrigger } from '../src/lib/workflow/types'

/**
 * The `/` menu's answer to "which `{{name}}` can hold a value at this node?".
 *
 * Two invariants matter more than the list itself: a name must be produced by
 * something that can run BEFORE the node (otherwise the picker teaches a graph
 * that fails at run time), and every offered name must already be one the save
 * card accepts — so an engine alias is only offered when `integrity` whitelists
 * it, never because an executor happened to write it somewhere.
 */

const node = (id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label: blockId,
  position: { x: 0, y: 0 },
  data: { blockId, ...data },
})

const edge = (source: string, target: string): WorkflowEdge => ({
  id: `${source}->${target}`,
  source,
  target,
})

const trigger = (parameters: unknown[] = []): WorkflowTrigger =>
  ({ type: 'manual', parameters }) as WorkflowTrigger

function graph(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  workflowTrigger?: WorkflowTrigger,
): SuggestionGraph {
  return { nodes, edges, trigger: workflowTrigger }
}

const names = (items: ReturnType<typeof collectSuggestions>): string[] =>
  items.map((item) => item.name)

describe('credential reference codec', () => {
  it('round-trips the get-secret encoding', () => {
    const ref = { credentialId: 'gh-pat', fieldKey: 'token' }
    expect(credentialRefOf(ref)).toBe('gh-pat::token')
    expect(parseCredentialRef('gh-pat::token')).toEqual(ref)
  })

  it('rejects anything that is not a credential ref', () => {
    expect(parseCredentialRef('')).toBeNull()
    expect(parseCredentialRef('::token')).toBeNull()
    expect(parseCredentialRef('gh-pat::')).toBeNull()
    expect(parseCredentialRef(undefined)).toBeNull()
  })

  it('mints a name that survives being embedded in {{…}}', () => {
    // A credential id is user text: dots would turn the reference into a path
    // and braces would break the token regex outright.
    expect(secretVariableNameOf({ credentialId: 'a.b', fieldKey: 'c{d}' })).toBe('secret_ab_cd')
  })
})

describe('collectSuggestions — graph scope', () => {
  const chain = [node('t', 'trigger'), node('read', 'get-text', { variableName: 'title' })]
  const edges = [edge('t', 'read'), edge('read', 'post')]

  it('lists the trigger inputs and the upstream producers', () => {
    const items = collectSuggestions(
      graph(chain, edges, trigger([{ name: 'keyword', type: 'string' }])),
      'post',
      {},
    )
    expect(names(items)).toContain('keyword')
    expect(names(items)).toContain('title')
  })

  it('excludes a producer that cannot reach this node', () => {
    const detached = node('other', 'set-variable', { variableName: 'orphans' })
    const items = collectSuggestions(graph([...chain, detached], edges), 'post', {})
    expect(names(items)).not.toContain('orphans')
  })

  it('excludes the edited node itself', () => {
    const self = node('post', 'forms', { variableName: 'ownOutput' })
    const items = collectSuggestions(graph([...chain, self], edges), 'post', {})
    expect(names(items)).not.toContain('ownOutput')
  })

  it('degrades to an empty list for a node with no incoming connection', () => {
    const items = collectSuggestions(graph(chain, []), 'read', {})
    expect(names(items)).toEqual([])
  })
})

describe('collectSuggestions — aliases and loop context', () => {
  it('offers refData only when something runs before', () => {
    const nodes = [node('t', 'trigger'), node('a', 'get-text', { variableName: 'title' })]
    const edges = [edge('t', 'a')]
    expect(names(collectSuggestions(graph(nodes, edges), 'a', {}))).toContain('refData')
    expect(names(collectSuggestions(graph(nodes, []), 'a', {}))).not.toContain('refData')
  })

  it('offers dataTable only when a read actually feeds the table', () => {
    const feeder = node('read', 'get-text', { saveData: true, dataColumn: 'price' })
    const quiet = node('other', 'get-text', { variableName: 'title' })
    const target = node('post', 'forms')
    const edges = [edge('read', 'other'), edge('other', 'post')]
    expect(names(collectSuggestions(graph([feeder, quiet, target], edges), 'post', {}))).toContain(
      'dataTable',
    )
    expect(names(collectSuggestions(graph([quiet, target], edges), 'post', {}))).not.toContain(
      'dataTable',
    )
  })

  it('offers a reader fallback only when integrity sanctions the name', () => {
    const reader = node('read', 'get-text')
    const attribute = node('attr', 'attribute-value')
    const target = node('post', 'forms')
    const edges = [edge('read', 'attr'), edge('attr', 'post')]
    const items = collectSuggestions(graph([reader, attribute, target], edges), 'post', {})
    // lastText is whitelisted; lastAttribute is not, so the picker must not
    // suggest a reference the save card then reports as dangling.
    expect(names(items)).toContain('lastText')
    expect(names(items)).not.toContain('lastAttribute')
  })

  it('gates loop names on the loop producer upstream', () => {
    const loopData = node('loop', 'loop-data', { through: 'numbers' })
    const loopElements = node('elements', 'loop-elements', { selector: '.row' })
    const body = node('body', 'forms')
    const asList = (head: WorkflowNode): string[] => {
      const edges = [edge(head.id, 'body')]
      return names(collectSuggestions(graph([head, body], edges), 'body', {}))
    }
    expect(asList(loopData)).toContain('loopItem')
    expect(asList(loopData)).not.toContain('loopElementSelector')
    expect(asList(loopElements)).toContain('loopElementSelector')
    expect(asList(node('plain', 'forms'))).not.toContain('loopIndex')
  })

  it('never offers a name outside the engine whitelist or a real producer', () => {
    const nodes = [
      node('t', 'trigger'),
      node('read', 'get-text', { variableName: 'title' }),
      node('post', 'forms'),
    ]
    const edges = [edge('t', 'read'), edge('read', 'post')]
    const items = collectSuggestions(
      graph(nodes, edges, trigger([{ name: 'q', type: 'string' }])),
      'post',
      {
        secrets: [],
      },
    )
    const produced = new Set(['title', 'q'])
    for (const item of items) {
      const bare = item.insert.slice(2, -2)
      const isAlias = item.origin === 'alias' || item.origin === 'loop'
      expect(
        isAlias
          ? ENGINE_PROVIDED_NAMES.has(bare) || bare === 'dataTable'
          : produced.has(bare) || ENGINE_PROVIDED_NAMES.has(bare),
      ).toBe(true)
    }
  })

  it('keeps its loop names in step with the engine table it mirrors', () => {
    // LOOP_ALIASES is inside collectSuggestions; assert through behaviour that
    // the names it publishes are exactly the run loop's own.
    const known = new Set(LOOP_CONTEXT_NAMES.keys())
    const loopElements = node('elements', 'loop-elements')
    const body = node('body', 'forms')
    const items = collectSuggestions(
      graph([loopElements, body], [edge('elements', 'body')]),
      'body',
      {},
    )
    for (const item of items.filter((row) => row.origin === 'loop')) {
      expect(known.has(item.name)).toBe(true)
    }
  })
})

describe('collectSuggestions — secrets', () => {
  const secret: SecretOption = { credentialId: 'gh', fieldKey: 'token', label: 'GitHub' }
  const nodes = [node('t', 'trigger'), node('post', 'forms')]
  const edges = [edge('t', 'post')]

  it('offers a credential row without ever carrying a value', () => {
    const items = collectSuggestions(graph(nodes, edges), 'post', { secrets: [secret] })
    const row = items.find((item) => item.origin === 'secret')
    expect(row?.name).toBe('GitHub · token')
    expect(row?.needsProducer).toBe(true)
    expect(row?.insert).toBe(`{{${secretVariableNameOf(secret)}}}`)
    expect(JSON.stringify(row)).not.toContain('super-secret')
  })

  it('reuses an existing reachable producer and offers its name once', () => {
    const producer = node('fetch', 'get-secret', {
      credential: 'gh::token',
      variableName: 'githubToken',
    })
    const withProducer = [nodes[0] as WorkflowNode, producer, nodes[1] as WorkflowNode]
    const items = collectSuggestions(
      graph(withProducer, [edge('t', 'fetch'), edge('fetch', 'post')]),
      'post',
      { secrets: [secret] },
    )
    // The credential IS an upstream variable by then, so it shows as that
    // variable and not a second row that writes the same token.
    const same = items.filter((item) => item.insert === '{{githubToken}}')
    expect(same).toHaveLength(1)
    expect(same[0]?.origin).toBe('variable')
    expect(same[0]?.hint).toBe('get-secret')
    expect(items.some((item) => item.origin === 'secret')).toBe(false)
  })

  it('does not reuse a producer that cannot reach this node', () => {
    const orphan = node('fetch', 'get-secret', {
      credential: 'gh::token',
      variableName: 'githubToken',
    })
    const items = collectSuggestions(graph([...nodes, orphan], edges), 'post', {
      secrets: [secret],
    })
    expect(items.find((item) => item.origin === 'secret')?.needsProducer).toBe(true)
  })

  it('offers every name a reachable multi-credential producer publishes', () => {
    const producer = node('fetch', 'get-secret', {
      credential: 'gh::token',
      variableName: 'githubToken',
      credentials: [
        { credential: 'gh::token', variableName: 'githubToken' },
        { credential: 'mail::password', variableName: 'mailPassword' },
      ],
    })
    const items = collectSuggestions(
      graph(
        [nodes[0] as WorkflowNode, producer, nodes[1] as WorkflowNode],
        [edge('t', 'fetch'), edge('fetch', 'post')],
      ),
      'post',
      {
        secrets: [secret, { ...secret, credentialId: 'mail', fieldKey: 'password', label: 'Mail' }],
      },
    )
    // Both rows are upstream variables already, so neither shows as a credential
    // that still needs a producer.
    expect(items.filter((item) => item.origin === 'variable').map((item) => item.name)).toEqual(
      expect.arrayContaining(['githubToken', 'mailPassword']),
    )
    expect(items.filter((item) => item.origin === 'secret')).toEqual([])
  })
})

describe('filterSuggestions', () =>
  it('ranks a name prefix above a mid-word match', () => {
    const items = [
      { id: 'a', origin: 'variable' as const, name: 'productName', insert: '{{productName}}' },
      { id: 'b', origin: 'variable' as const, name: 'sumProduct', insert: '{{sumProduct}}' },
    ]
    expect(names(filterSuggestions(items, 'prod'))).toEqual(['productName', 'sumProduct'])
    expect(names(filterSuggestions(items, 'duct'))).toEqual(['productName', 'sumProduct'])
    expect(filterSuggestions(items, 'zzz')).toEqual([])
  }))

describe('placeClearOfNodes', () => {
  // The rule the credential producer and the AI assistant's chain append share
  // (guidelines §5.2): an inserted node never lands on top of an existing one.
  const at = (id: string, x: number, y: number): WorkflowNode => ({
    id,
    label: 'new-tab',
    position: { x, y },
    data: { blockId: 'new-tab' },
  })

  it('leaves a free position untouched', () => {
    expect(placeClearOfNodes({ x: 500, y: 0 }, [at('a', 0, 0)])).toEqual({ x: 500, y: 0 })
    expect(placeClearOfNodes({ x: 0, y: 0 }, [])).toEqual({ x: 0, y: 0 })
  })

  it('walks down rows, never sideways, until the spot is clear', () => {
    const occupied = [at('a', 240, 0), at('b', 240, 90)]
    expect(placeClearOfNodes({ x: 240, y: 0 }, occupied)).toEqual({ x: 240, y: 180 })
  })
})
