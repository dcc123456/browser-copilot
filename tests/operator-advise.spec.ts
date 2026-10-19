import { describe, expect, it } from 'vitest'
import {
  appendOperatorChain,
  adviseCandidates,
  buildOperatorAdvisePrompt,
  chainOrderOf,
  edgesAfterBatchRemoved,
  operatorBatchOf,
  operatorDigestOf,
  OPERATOR_ADVISE_MAX_OPERATORS,
  parseOperatorAdviseReply,
  tailNodeOf,
  type OperatorAdviseMessage,
  type OperatorCandidate,
} from '../src/lib/workflow/operator-advise'
import type { WorkflowEdge, WorkflowNode, WorkflowTrigger } from '../src/lib/workflow/types'

/**
 * The editor's floating assistant, minus the model. Three things carry the
 * design: the model may only ever name an operator from the offer it was given
 * (so a hallucinated id can't reach the canvas), the provenance marker is added
 * by the patcher and stripped from anything the model wrote, and the chain is
 * SPLICED into the flow — an anchor that already continues somewhere keeps its
 * continuation, and an anchor that branches is refused rather than guessed.
 */

const node = (
  id: string,
  blockId: string,
  data: Record<string, unknown> = {},
  position = { x: 0, y: 0 },
): WorkflowNode => ({ id, label: blockId, position, data: { blockId, ...data } })

const edge = (source: string, target: string, sourceHandle?: string): WorkflowEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  sourceHandle,
})

const graph = (nodes: WorkflowNode[], edges: WorkflowEdge[]) => ({
  nodes,
  edges,
  trigger: { type: 'manual', enabled: true } as WorkflowTrigger,
})

let counter = 0
const newId = () => `n${(counter += 1)}`

const candidateIds = (candidates: OperatorCandidate[]): string[] =>
  candidates.map((candidate) => candidate.blockId)

describe('adviseCandidates', () => {
  it('offers the core operators as a floor, not only what discovery scored', () => {
    // A URL-only utterance scores poorly on the phrase tables; the editor must
    // still be able to add a plain New tab.
    expect(candidateIds(adviseCandidates('打开 https://www.example.com'))).toContain('new-tab')
  })

  it('never offers the trigger or a cloud-only operator', () => {
    const offered = candidateIds(adviseCandidates('trigger a google sheet row'))
    expect(offered).not.toContain('trigger')
    expect(offered).not.toContain('google-sheets')
  })

  it('carries each offer with its parameter schema and required keys', () => {
    const [newTab] = adviseCandidates('open a url').filter((c) => c.blockId === 'new-tab')
    expect(newTab?.required).toContain('url')
    expect(JSON.stringify(newTab?.schema)).toContain('url')
  })
})

describe('buildOperatorAdvisePrompt', () => {
  const history: OperatorAdviseMessage[] = [{ role: 'user', content: '打开百度' }]
  const candidates = adviseCandidates('打开百度')

  it('shows the canvas, the offer and the reply contract', () => {
    const prompt = buildOperatorAdvisePrompt({
      history,
      graphDigest: '1. new-tab {"url":"https://a"}',
      candidates,
    })
    expect(prompt).toContain('1. new-tab {"url":"https://a"}')
    expect(prompt).toContain('- new-tab — New tab')
    expect(prompt).toContain('required: url')
    expect(prompt).toContain('user: 打开百度')
    expect(prompt).toContain('"reply"')
    expect(prompt).toContain('"proposals"')
  })

  it('marks an empty canvas instead of emitting a blank section', () => {
    const prompt = buildOperatorAdvisePrompt({ history, graphDigest: '   ', candidates })
    expect(prompt).toContain('(empty)')
  })

  it('states the cap it will enforce', () => {
    const prompt = buildOperatorAdvisePrompt({
      history,
      graphDigest: '',
      candidates,
      maxOperators: 2,
    })
    expect(prompt).toContain('At most 2 operators')
  })
})

describe('parseOperatorAdviseReply', () => {
  const offered = ['new-tab', 'event-click']

  it('reads a fenced, thought-wrapped answer', () => {
    const parsed = parseOperatorAdviseReply(
      '<think>choosing the tab operator</think>\n```json\n{"reply":"已添加","proposals":[{"blockId":"new-tab","data":{"url":"https://b"}, "rationale":"opens it"}]}\n```',
      offered,
    )
    expect(parsed).toEqual({
      reply: '已添加',
      proposals: [{ blockId: 'new-tab', data: { url: 'https://b' }, rationale: 'opens it' }],
      rejected: [],
    })
  })

  it('drops ids outside the offer and names them', () => {
    const parsed = parseOperatorAdviseReply(
      '{"reply":"ok","proposals":[{"blockId":"new-tab","data":{}},{"blockId":"launch-browser","data":{}}]}',
      offered,
    )
    expect(parsed?.proposals.map((p) => p.blockId)).toEqual(['new-tab'])
    expect(parsed?.rejected).toEqual(['launch-browser'])
  })

  it('caps the chain and reports what was cut', () => {
    const rows = Array.from({ length: OPERATOR_ADVISE_MAX_OPERATORS + 2 }, () => ({
      blockId: 'new-tab',
      data: { url: 'https://b' },
    }))
    const parsed = parseOperatorAdviseReply(
      JSON.stringify({ reply: 'ok', proposals: rows }),
      offered,
    )
    expect(parsed?.proposals).toHaveLength(OPERATOR_ADVISE_MAX_OPERATORS)
    expect(parsed?.rejected).toHaveLength(2)
  })

  it('strips the provenance marker and block id the model tried to write', () => {
    const parsed = parseOperatorAdviseReply(
      '{"reply":"ok","proposals":[{"blockId":"new-tab","data":{"url":"u","blockId":"click","__workflowAi":{"addedBy":"ai"}}}]}',
      offered,
    )
    expect(parsed?.proposals[0]?.data).toEqual({ url: 'u' })
  })

  it('returns null for anything that is not a JSON object', () => {
    expect(parseOperatorAdviseReply('I cannot help with that.', offered)).toBeNull()
    expect(parseOperatorAdviseReply('{"reply":"ok"', offered)).toBeNull()
    expect(parseOperatorAdviseReply('{"reply":', offered)).toBeNull()
  })
})

describe('operatorDigestOf', () => {
  it('lists steps in flow order with parameters, variables and the selection', () => {
    const digest = operatorDigestOf(
      graph(
        [
          node('t', 'trigger'),
          node('g', 'get-data', { variableName: 'rows', limit: 3 }),
          node('orphan', 'new-tab'),
        ],
        [edge('t', 'g')],
      ),
      'g',
    )
    const lines = digest.split('\n')
    // The unwired step starts its own line, so it sorts before the selection.
    expect(lines[0]).toBe('1. trigger')
    expect(lines[1]).toBe('2. new-tab')
    expect(lines[2]).toContain('3. get-data')
    expect(lines[2]).toContain('"limit":3')
    expect(lines[2]).toContain('-> {{rows}}')
    expect(lines[2]).toContain('<< selected')
  })

  it('hides parameters a model cannot read', () => {
    const digest = operatorDigestOf(
      graph(
        [node('t', 'trigger'), node('n', 'new-tab', { url: 'https://a', blocks: [{ id: 1 }] })],
        [edge('t', 'n')],
      ),
    )
    expect(digest).toContain('{"url":"https://a"}')
    expect(digest).not.toContain('blocks')
  })

  it('says nothing about an empty canvas', () => {
    expect(operatorDigestOf(graph([], []))).toBe('')
  })
})

describe('chainOrderOf / tailNodeOf', () => {
  it('walks the main line from every step nothing feeds', () => {
    const ordered = chainOrderOf(
      graph(
        [node('t', 'trigger'), node('b', 'new-tab'), node('c', 'event-click'), node('x', 'forms')],
        [edge('t', 'b'), edge('b', 'c')],
      ),
    )
    // `x` was dropped on the canvas without wiring it, so it starts a line too.
    expect(ordered.map((n) => n.id)).toEqual(['t', 'x', 'b', 'c'])
  })

  it('appends a cycle nothing reaches last', () => {
    const ordered = chainOrderOf(
      graph(
        [node('t', 'trigger'), node('b', 'new-tab'), node('x', 'forms'), node('y', 'forms')],
        [edge('t', 'b'), edge('x', 'y'), edge('y', 'x')],
      ),
    )
    expect(ordered.map((n) => n.id)).toEqual(['t', 'b', 'x', 'y'])
  })

  it('ends at a leaf, never in front of a wired step', () => {
    const tail = tailNodeOf(
      graph(
        [node('t', 'trigger'), node('b', 'new-tab'), node('c', 'event-click'), node('a', 'delay')],
        [edge('t', 'b'), edge('b', 'c'), edge('a', 't')],
      ),
    )
    expect(tail?.id).toBe('c')
  })
})

describe('appendOperatorChain', () => {
  it('staples the chain to the end when no anchor is given', () => {
    const patch = appendOperatorChain(
      graph([node('t', 'trigger'), node('b', 'new-tab', { url: 'https://a' })], [edge('t', 'b')]),
      [{ blockId: 'event-click', data: { selector: '#x' }, rationale: '' }],
      { newId },
    )
    expect(patch.problem).toBeUndefined()
    expect(patch.added).toHaveLength(1)
    expect(patch.edges.map((e) => [e.source, e.target])).toEqual([
      ['t', 'b'],
      ['b', patch.added[0]!.id],
    ])
    expect(patch.edges[1]?.sourceHandle).toBe('new-tab-output-1')
    expect(patch.edges[1]?.targetHandle).toBe('event-click-input-1')
  })

  it('splices between the anchor and its existing continuation', () => {
    const patch = appendOperatorChain(
      graph(
        [node('t', 'trigger'), node('b', 'new-tab'), node('c', 'event-click')],
        [edge('t', 'b', 'trigger-output-1'), edge('b', 'c', 'new-tab-output-1')],
      ),
      [{ blockId: 'delay', data: {}, rationale: '' }],
      { anchorNodeId: 'b', newId },
    )
    const inserted = patch.added[0]!.id
    const byId = new Map(patch.edges.map((e) => [e.id, e]))
    // The old continuation now hangs off the inserted node, in the right port.
    expect(byId.get('b->c')?.source).toBe(inserted)
    expect(byId.get('b->c')?.sourceHandle).toBe('delay-output-1')
    expect(byId.get('b->c')?.target).toBe('c')
    expect(patch.edges.find((e) => e.target === inserted)?.source).toBe('b')
    expect(patch.splicedEdge).toEqual({
      id: 'b->c',
      source: 'b',
      sourceHandle: 'new-tab-output-1',
    })
  })

  it('hangs the continuation off the LAST node of a multi-operator chain', () => {
    const patch = appendOperatorChain(
      graph(
        [node('t', 'trigger'), node('b', 'new-tab'), node('c', 'event-click')],
        [edge('t', 'b', 'trigger-output-1'), edge('b', 'c', 'new-tab-output-1')],
      ),
      [
        { blockId: 'delay', data: {}, rationale: '' },
        { blockId: 'event-click', data: { selector: '#x' }, rationale: '' },
      ],
      { anchorNodeId: 'b', newId },
    )
    const first = patch.added[0]!.id
    const last = patch.added[patch.added.length - 1]!.id
    const byId = new Map(patch.edges.map((e) => [e.id, e]))
    // Left on `first`, the borrowed edge would fork the flow the user wired.
    expect(byId.get('b->c')?.source).toBe(last)
    expect(byId.get('b->c')?.sourceHandle).toBe('event-click-output-1')
    expect(patch.edges.filter((e) => e.source === first)).toHaveLength(1)
  })

  it('refuses an anchor that branches, rather than picking a path', () => {
    const patch = appendOperatorChain(
      graph(
        [node('b', 'new-tab'), node('c', 'event-click'), node('d', 'forms')],
        [edge('b', 'c', 'new-tab-output-1'), edge('b', 'd', 'new-tab-output-2')],
      ),
      [{ blockId: 'delay', data: {}, rationale: '' }],
      { anchorNodeId: 'b', newId },
    )
    expect(patch.problem).toBe('branch-anchor')
    expect(patch.added).toEqual([])
    expect(patch.edges).toHaveLength(2)
  })

  it('leaves the error port of the anchor alone', () => {
    const patch = appendOperatorChain(
      graph(
        [node('b', 'new-tab'), node('c', 'event-click'), node('f', 'trigger')],
        [edge('b', 'c', 'new-tab-output-1'), edge('b', 'f', 'new-tab-output-fallback')],
      ),
      [{ blockId: 'delay', data: {}, rationale: '' }],
      { anchorNodeId: 'b', newId },
    )
    expect(patch.problem).toBeUndefined()
    const fallback = patch.edges.find((e) => e.sourceHandle === 'new-tab-output-fallback')
    expect(fallback?.target).toBe('f')
  })

  it('keeps catalog defaults and stamps the provenance the model cannot forge', () => {
    const patch = appendOperatorChain(
      graph([node('t', 'trigger')], []),
      [{ blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' }],
      { newId },
    )
    const added = patch.added[0]!
    expect(added.data['url']).toBe('https://b')
    // A catalog default the model never mentioned still shows through.
    expect(added.data['active']).toBe(true)
    expect(added.data['__workflowAi']).toEqual({ addedBy: 'ai' })
    expect(added.data['blockId']).toBe('new-tab')
    expect(added.label).toBe('New tab')
  })

  it('reports a required parameter the answer left empty', () => {
    const patch = appendOperatorChain(
      graph([node('t', 'trigger')], []),
      [{ blockId: 'new-tab', data: {}, rationale: '' }],
      { newId },
    )
    expect(patch.missing).toEqual([{ blockId: 'new-tab', name: 'New tab', keys: ['url'] }])
  })

  it('skips operators this build cannot run and keeps the rest of the chain', () => {
    const patch = appendOperatorChain(
      graph([node('t', 'trigger')], []),
      [
        { blockId: 'trigger', data: {}, rationale: '' },
        { blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' },
      ],
      { newId },
    )
    expect(patch.skipped).toEqual(['Trigger'])
    expect(patch.added.map((n) => n.data['blockId'])).toEqual(['new-tab'])
    // The surviving step still hangs off the anchor, not off the skipped one.
    expect(patch.edges[0]?.source).toBe('t')
    expect(patch.edges[0]?.sourceHandle).toBe('trigger-output-1')
  })

  it('places each new node clear of what the canvas already holds', () => {
    const patch = appendOperatorChain(
      graph(
        [
          node('t', 'trigger', {}, { x: 0, y: 0 }),
          node('b', 'new-tab', {}, { x: 240, y: 0 }),
          node('s', 'forms', {}, { x: 480, y: 0 }),
        ],
        [edge('t', 'b')],
      ),
      [
        { blockId: 'new-tab', data: { url: 'https://1' }, rationale: '' },
        { blockId: 'new-tab', data: { url: 'https://2' }, rationale: '' },
      ],
      { newId },
    )
    const [first, second] = patch.added
    // A step already sits where the chain would start: it walks down a row.
    expect(first?.position).toEqual({ x: 480, y: 90 })
    expect(second?.position).toEqual({ x: 720, y: 90 })
  })

  it('refuses an unknown anchor and an empty canvas distinctly', () => {
    expect(
      appendOperatorChain(
        graph([node('t', 'trigger')], []),
        [{ blockId: 'new-tab', data: {}, rationale: '' }],
        {
          anchorNodeId: 'gone',
          newId,
        },
      ).problem,
    ).toBe('unknown-anchor')
    expect(
      appendOperatorChain(graph([], []), [{ blockId: 'new-tab', data: {}, rationale: '' }], {
        newId,
      }).problem,
    ).toBe('empty-graph')
  })

  it('changes nothing for an empty batch', () => {
    const patch = appendOperatorChain(graph([node('t', 'trigger')], []), [], { newId })
    expect(patch.added).toEqual([])
    expect(patch.edges).toEqual([])
  })
})

describe('edgesAfterBatchRemoved', () => {
  it('puts a tail append back exactly as it was', () => {
    const base = graph(
      [node('t', 'trigger'), node('b', 'new-tab')],
      [edge('t', 'b', 'trigger-output-1')],
    )
    const patch = appendOperatorChain(base, [{ blockId: 'delay', data: {}, rationale: '' }], {
      newId,
    })
    expect(edgesAfterBatchRemoved(patch.edges, operatorBatchOf(patch))).toEqual(base.edges)
  })

  it('hands a spliced continuation back to its anchor', () => {
    const base = graph(
      [node('t', 'trigger'), node('b', 'new-tab'), node('c', 'event-click')],
      [edge('t', 'b', 'trigger-output-1'), edge('b', 'c', 'new-tab-output-1')],
    )
    const patch = appendOperatorChain(
      base,
      [
        { blockId: 'delay', data: {}, rationale: '' },
        { blockId: 'event-click', data: { selector: '#x' }, rationale: '' },
      ],
      { anchorNodeId: 'b', newId },
    )
    // Undo must not leave the user's own wiring cut — that is the whole point of
    // remembering the edge the batch borrowed.
    expect(edgesAfterBatchRemoved(patch.edges, operatorBatchOf(patch))).toEqual(base.edges)
  })
})
