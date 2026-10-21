import { describe, expect, it } from 'vitest'
import { BLOCK_BY_ID } from '../src/lib/workflow/blocks/palette'
import {
  appendOperatorChain,
  applyOperatorAction,
  adviseCandidates,
  buildOperatorAdvisePrompt,
  chainOrderOf,
  edgesAfterBatchRemoved,
  isObservableBlock,
  operatorBatchOf,
  operatorDataOfProposal,
  operatorDigestOf,
  operatorScreenshotRoute,
  OPERATOR_ADVISE_MAX_OPERATORS,
  OPERATOR_SCREENSHOT_NOTE_CAP,
  OPERATOR_SCREENSHOT_QUESTION,
  parseOperatorAdviseReply,
  prependOperatorChain,
  proposalIndexesNeedingPage,
  proposalsNeedingPage,
  selectedOperatorSpecOf,
  tailNodeOf,
  type OperatorAdviseMessage,
  type OperatorCandidate,
  type OperatorPageRead,
  type OperatorProposal,
} from '../src/lib/workflow/operator-advise'
import type { WorkflowEdge, WorkflowNode, WorkflowTrigger } from '../src/lib/workflow/types'

/**
 * The editor's floating assistant, minus the model. Three things carry the
 * design: the model may only ever name an operator from the offer it was given
 * (so a hallucinated id can't reach the canvas), the provenance marker is added
 * by the patcher and stripped from anything the model wrote, and the chain is
 * SPLICED into the flow — whichever side of the anchor it lands on, the one path
 * the batch takes over is remembered and handed back on undo, and an anchor that
 * branches (or joins) is refused rather than guessed.
 */

const node = (
  id: string,
  blockId: string,
  data: Record<string, unknown> = {},
  position = { x: 0, y: 0 },
): WorkflowNode => ({ id, label: blockId, position, data: { blockId, ...data } })

const edge = (
  source: string,
  target: string,
  sourceHandle?: string,
  targetHandle?: string,
): WorkflowEdge => ({ id: `${source}->${target}`, source, target, sourceHandle, targetHandle })

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

  it('grounds the parameters in the page it was shown', () => {
    const page: OperatorPageRead = {
      url: 'https://example.com/form',
      title: 'Sign up',
      elements: [{ ref: 'e3', role: 'combobox', name: 'City', loc: '#city' }],
      forms: [{ selector: 'form#signup', fields: [] }],
    }
    const prompt = buildOperatorAdvisePrompt({ history, graphDigest: '', candidates, page })
    expect(prompt).toContain('## The page the user is looking at — Sign up')
    expect(prompt).toContain('#city')
    expect(prompt).toContain('form#signup')
    expect(prompt).toContain('Never invent a selector')
    // A page read goes before the offer, so the model copies from the page rather
    // than inventing something for the offer to fit.
    expect(prompt.indexOf('## The page')).toBeLessThan(prompt.indexOf('## Operators you may use'))

    const untitled = buildOperatorAdvisePrompt({
      history,
      graphDigest: '',
      candidates,
      page: { ...page, title: '' },
    })
    expect(untitled).toContain('https://example.com/form (read just now, read-only)')
  })

  it('carries the elements the user picked by hand, verbatim and above the offer', () => {
    const prompt = buildOperatorAdvisePrompt({
      history,
      graphDigest: '',
      candidates,
      pickedElements: [
        { selector: '#city', findBy: 'cssSelector' },
        { selector: '//span[text="杭州"]', findBy: 'xpath' },
      ],
    })
    expect(prompt).toContain('## Elements the user picked by hand')
    expect(prompt).toContain('CSS: #city')
    expect(prompt).toContain('XPath: //span[text="杭州"]')
    expect(prompt).toContain('use one VERBATIM')
    // The precedence rule, which is the whole reason a hand pick outranks a read.
    expect(prompt).toContain('this section wins')
    expect(prompt.indexOf('## Elements the user picked')).toBeLessThan(
      prompt.indexOf('## Operators you may use'),
    )
  })

  it('puts the picks after the page read, and skips an empty selector', () => {
    const page: OperatorPageRead = {
      url: 'https://example.com/form',
      title: 'Sign up',
      elements: [{ ref: 'e3', role: 'combobox', name: 'City', loc: '#other' }],
      forms: [],
    }
    const prompt = buildOperatorAdvisePrompt({
      history,
      graphDigest: '',
      candidates,
      page,
      pickedElements: [
        { selector: '', findBy: 'cssSelector' },
        { selector: '#city', findBy: 'cssSelector' },
      ],
    })
    expect(prompt.match(/## Elements the user picked by hand/g)).toHaveLength(1)
    expect(prompt).not.toMatch(/^CSS: $/m)
    // The page still grounds everything else; the pick only overrides what it says.
    expect(prompt.indexOf('## The page')).toBeLessThan(
      prompt.indexOf('## Elements the user picked'),
    )
  })

  it('says nothing about picks when there were none', () => {
    const prompt = buildOperatorAdvisePrompt({
      history,
      graphDigest: '',
      candidates,
      pickedElements: [],
    })
    expect(prompt).not.toContain('## Elements the user picked by hand')
  })

  it('tells the model the screenshot is attached, on the inline route', () => {
    const prompt = buildOperatorAdvisePrompt({
      history,
      graphDigest: '',
      candidates,
      screenshot: { route: 'inline' },
    })
    expect(prompt).toContain('## A screenshot of the page is attached to this request')
    expect(prompt).not.toContain('## What a screenshot of the page shows')
    // Why it is here, and what must not be copied out of it.
    expect(prompt).toContain('missing a parameter only the page can give')
    expect(prompt).toContain('password, token, cookie, phone number')

    const plain = buildOperatorAdvisePrompt({ history, graphDigest: '', candidates })
    expect(plain).not.toContain('screenshot')
  })

  it('quotes the image model, capped, on the described route', () => {
    const note = 'x'.repeat(OPERATOR_SCREENSHOT_NOTE_CAP + 400)
    const prompt = buildOperatorAdvisePrompt({
      history,
      graphDigest: '',
      candidates,
      screenshot: { route: 'described', note },
    })
    expect(prompt).toContain('## What a screenshot of the page shows (read by the image model)')
    expect(prompt).not.toContain('is attached to this request')
    expect(prompt).toContain('x'.repeat(OPERATOR_SCREENSHOT_NOTE_CAP))
    expect(prompt).not.toContain('x'.repeat(OPERATOR_SCREENSHOT_NOTE_CAP + 1))
  })

  it('keeps the screenshot section after the page read and the hand picks', () => {
    const page: OperatorPageRead = {
      url: 'https://example.com/form',
      title: 'Sign up',
      elements: [{ ref: 'e3', role: 'combobox', name: 'City', loc: '#city' }],
      forms: [],
    }
    const prompt = buildOperatorAdvisePrompt({
      history,
      graphDigest: '',
      candidates,
      page,
      pickedElements: [{ selector: '#city', findBy: 'cssSelector' }],
      screenshot: { route: 'described', note: 'A dropdown lists 杭州 and 苏州.' },
    })
    expect(prompt.indexOf('## The page')).toBeLessThan(
      prompt.indexOf('## What a screenshot of the page shows'),
    )
    expect(prompt.indexOf('## Elements the user picked')).toBeLessThan(
      prompt.indexOf('## What a screenshot of the page shows'),
    )
    expect(prompt.indexOf('## What a screenshot of the page shows')).toBeLessThan(
      prompt.indexOf('## Operators you may use'),
    )
    // The DOM read and the screen both speak; nothing is dropped for the image.
    expect(prompt).toContain('#city')
    expect(prompt).toContain('苏州')
  })
})

/**
 * The route is decided from what the user configured, never from a capability
 * probe: no provider record says whether its model reads images. A screenshot may
 * only ride the chat call when the image target IS that call's provider and model
 * — which `resolveVisionTarget`'s fallback makes true of an unset image model.
 */
describe('operatorScreenshotRoute', () => {
  const active = { providerId: 'openai', model: 'gpt-4o' }

  it('sends the image to the chat model when nothing else is configured', () => {
    expect(operatorScreenshotRoute(active, undefined)).toBe('inline')
    expect(operatorScreenshotRoute(active, { providerId: '', model: '' })).toBe('inline')
    // A model with no provider is ignored by the resolver, so it is still the
    // chat model that sees the image.
    expect(operatorScreenshotRoute(active, { providerId: '', model: 'qwen-vl' })).toBe('inline')
  })

  it('sends it inline when the same model was picked for both', () => {
    expect(operatorScreenshotRoute(active, { providerId: 'openai', model: '' })).toBe('inline')
    expect(operatorScreenshotRoute(active, active)).toBe('inline')
  })

  it('routes through the image model when the picture comes from elsewhere', () => {
    expect(operatorScreenshotRoute(active, { providerId: 'qwen', model: 'qwen-vl' })).toBe(
      'described',
    )
    expect(operatorScreenshotRoute(active, { providerId: 'openai', model: 'gpt-4o-mini' })).toBe(
      'described',
    )
    expect(operatorScreenshotRoute(undefined, { providerId: 'qwen', model: 'qwen-vl' })).toBe(
      'described',
    )
  })

  it('asks the image model for the screen, and for nothing that looks like a credential', () => {
    expect(OPERATOR_SCREENSHOT_QUESTION).toContain('dropdown')
    expect(OPERATOR_SCREENSHOT_QUESTION).toContain('password')
    expect(OPERATOR_SCREENSHOT_QUESTION).toContain('Do NOT transcribe')
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
      action: 'append',
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
        [
          edge('t', 'b', 'trigger-output-1'),
          edge('b', 'c', 'new-tab-output-1', 'event-click-input-1'),
        ],
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
      target: 'c',
      targetHandle: 'event-click-input-1',
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

/**
 * The same splice from the other side: the chain takes the place of the ONE path
 * that arrives at the anchor, and the refusals mirror the append's — the anchor
 * is never guessed, and a step several paths arrive at is not ours to rewrite.
 */
describe('prependOperatorChain', () => {
  const line = () =>
    graph(
      [node('t', 'trigger'), node('b', 'new-tab')],
      [edge('t', 'b', 'trigger-output-1', 'new-tab-input-1')],
    )

  it('takes the place of the path that fed the anchor', () => {
    const patch = prependOperatorChain(line(), [{ blockId: 'delay', data: {}, rationale: '' }], {
      anchorNodeId: 'b',
      newId,
    })
    expect(patch.problem).toBeUndefined()
    const inserted = patch.added[0]!.id
    const byId = new Map(patch.edges.map((e) => [e.id, e]))
    expect(byId.get('t->b')?.target).toBe(inserted)
    expect(byId.get('t->b')?.targetHandle).toBe('delay-input-1')
    const arrival = patch.edges.find((e) => e.target === 'b')
    expect(arrival?.source).toBe(inserted)
    expect(arrival?.sourceHandle).toBe('delay-output-1')
    expect(arrival?.targetHandle).toBe('new-tab-input-1')
    expect(patch.splicedEdge).toEqual({
      id: 't->b',
      source: 't',
      sourceHandle: 'trigger-output-1',
      target: 'b',
      targetHandle: 'new-tab-input-1',
    })
  })

  it('wires the FIRST new step to the feed and the LAST to the anchor', () => {
    const patch = prependOperatorChain(
      line(),
      [
        { blockId: 'delay', data: {}, rationale: '' },
        { blockId: 'event-click', data: { selector: '#x' }, rationale: '' },
      ],
      { anchorNodeId: 'b', newId },
    )
    const [first, last] = patch.added
    const byId = new Map(patch.edges.map((e) => [e.id, e]))
    expect(byId.get('t->b')?.target).toBe(first!.id)
    expect(patch.edges.filter((e) => e.target === last!.id)).toHaveLength(1)
    const arrival = patch.edges.find((e) => e.target === 'b')
    expect(arrival?.source).toBe(last!.id)
    expect(arrival?.sourceHandle).toBe('event-click-output-1')
  })

  it('grows the chain to the LEFT of the anchor', () => {
    const patch = prependOperatorChain(
      graph(
        [node('t', 'trigger', {}, { x: -480, y: 0 }), node('b', 'new-tab', {}, { x: 0, y: 0 })],
        [edge('t', 'b')],
      ),
      [{ blockId: 'delay', data: {}, rationale: '' }],
      { anchorNodeId: 'b', newId },
    )
    expect(patch.added[0]?.position).toEqual({ x: -240, y: 0 })
  })

  it('refuses the entry point, an unwired step and a join', () => {
    expect(
      prependOperatorChain(line(), [{ blockId: 'delay', data: {}, rationale: '' }], {
        anchorNodeId: 't',
        newId,
      }).problem,
    ).toBe('prepend-entry-point')
    expect(
      prependOperatorChain(
        graph([node('t', 'trigger'), node('b', 'new-tab')], []),
        [{ blockId: 'delay', data: {}, rationale: '' }],
        { anchorNodeId: 'b', newId },
      ).problem,
    ).toBe('prepend-no-incoming')
    const joined = graph(
      [node('t', 'trigger'), node('s', 'forms'), node('b', 'new-tab')],
      [edge('t', 'b', 'trigger-output-1'), edge('s', 'b', 'forms-output-1')],
    )
    const patch = prependOperatorChain(joined, [{ blockId: 'delay', data: {}, rationale: '' }], {
      anchorNodeId: 'b',
      newId,
    })
    expect(patch.problem).toBe('join-anchor')
    expect(patch.added).toEqual([])
    expect(patch.edges).toEqual(joined.edges)
  })

  it('will not insert into an error path', () => {
    // Only the fallback branch arrives at the step, so its front belongs to the
    // error handling the user wired, not to the main line.
    const patch = prependOperatorChain(
      graph(
        [node('t', 'trigger'), node('b', 'new-tab')],
        [edge('t', 'b', 'trigger-output-fallback')],
      ),
      [{ blockId: 'delay', data: {}, rationale: '' }],
      { anchorNodeId: 'b', newId },
    )
    expect(patch.problem).toBe('prepend-no-incoming')
  })

  it('never falls back to a guessed anchor', () => {
    // Appending without an anchor means the end of the flow; "in front of" has no
    // such reading, so an answer that lost its selection lands nothing.
    const patch = prependOperatorChain(line(), [{ blockId: 'delay', data: {}, rationale: '' }], {
      newId,
    })
    expect(patch.problem).toBe('unknown-anchor')
    expect(patch.added).toEqual([])
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

  it('hands a spliced feed back to the step it used to feed', () => {
    const base = graph(
      [node('t', 'trigger'), node('b', 'new-tab')],
      [edge('t', 'b', 'trigger-output-1', 'new-tab-input-1')],
    )
    const patch = prependOperatorChain(base, [{ blockId: 'delay', data: {}, rationale: '' }], {
      anchorNodeId: 'b',
      newId,
    })
    // Inserting in front moved the TARGET of the user's line, so restoring only its
    // source would leave it pointing at a node that no longer exists.
    expect(edgesAfterBatchRemoved(patch.edges, operatorBatchOf(patch))).toEqual(base.edges)
  })
})

describe('parseOperatorAdviseReply action', () => {
  const offered = ['new-tab', 'forms']

  it('treats a missing action as append, so the original path cannot regress', () => {
    expect(parseOperatorAdviseReply('{"reply":"ok","proposals":[]}', offered)?.action).toBe(
      'append',
    )
  })

  it('keeps an in-place action', () => {
    const parsed = parseOperatorAdviseReply(
      '{"reply":"ok","action":"replace","proposals":[{"blockId":"forms","data":{"selector":"#x"}}]}',
      offered,
    )
    expect(parsed?.action).toBe('replace')
  })

  it('keeps a prepend action, so a chain is not stapled on the wrong side', () => {
    const parsed = parseOperatorAdviseReply(
      '{"reply":"ok","action":"prepend","proposals":[{"blockId":"forms","data":{"selector":"#x"}}]}',
      offered,
    )
    expect(parsed?.action).toBe('prepend')
  })

  it('refuses the whole turn when the action names nothing', () => {
    // Guessing would put a replace answer onto the canvas as new steps.
    expect(parseOperatorAdviseReply('{"reply":"ok","action":"delete"}', offered)).toBeNull()
    expect(parseOperatorAdviseReply('{"reply":"ok","action":7}', offered)).toBeNull()
  })
})

describe('selectedOperatorSpecOf', () => {
  const canvas = graph(
    [
      node('t', 'trigger'),
      node('b', 'forms', { selector: '#login', password: 'hunter2', events: { click: true } }),
    ],
    [],
  )

  it('quotes every parameter, nested ones included, and masks a secret-named value', () => {
    const spec = selectedOperatorSpecOf(canvas, 'b')
    expect(spec).toContain('forms')
    expect(spec).toContain('"selector":"#login"')
    expect(spec).toContain('"click":true')
    expect(spec).toContain('"password":"***"')
    expect(spec).not.toContain('hunter2')
  })

  it('says nothing when nothing is selected or the step is gone', () => {
    expect(selectedOperatorSpecOf(canvas, undefined)).toBe('')
    expect(selectedOperatorSpecOf(canvas, 'zz')).toBe('')
  })
})

describe('buildOperatorAdvisePrompt actions', () => {
  const history: OperatorAdviseMessage[] = [{ role: 'user', content: '改成点击' }]
  const candidates = adviseCandidates('打开百度')

  it('offers the in-place actions only against a selected step', () => {
    const prompt = buildOperatorAdvisePrompt({
      history,
      graphDigest: '1. new-tab << selected',
      candidates,
      selectedSpec: 'new-tab {"url":"https://a"}',
    })
    expect(prompt).toContain('## The step the user selected')
    expect(prompt).toContain('new-tab {"url":"https://a"}')
    expect(prompt).toContain('- "edit"')
    expect(prompt).toContain('- "replace"')
    expect(prompt).toContain('- "prepend"')
    expect(prompt).toContain('Never name a node id')
    expect(prompt).toContain('"action":"append|prepend|edit|replace"')
  })

  it('offers append alone when nothing is selected', () => {
    const prompt = buildOperatorAdvisePrompt({ history, graphDigest: '', candidates })
    expect(prompt).not.toContain('## The step the user selected')
    expect(prompt).not.toContain('- "edit"')
    expect(prompt).not.toContain('- "prepend"')
    expect(prompt).toContain('Only "append" is possible')
  })
})

describe('applyOperatorAction edit', () => {
  const base = () =>
    graph(
      [node('t', 'trigger'), node('b', 'new-tab', { url: 'https://a', active: false })],
      [edge('t', 'b', 'trigger-output-1')],
    )

  it('merges over the node instead of re-authoring it', () => {
    const canvas = base()
    const patch = applyOperatorAction(canvas, 'b', 'edit', [
      { blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' },
    ])
    expect(patch.problem).toBeUndefined()
    expect(patch.nodes.find((n) => n.id === 'b')?.data).toEqual({
      blockId: 'new-tab',
      url: 'https://b',
      active: false,
    })
    expect(patch.edges).toEqual(canvas.edges)
    expect(patch.pruned).toEqual([])
  })

  it('records the node and its lines, deep-copied, for undo', () => {
    const canvas = base()
    const patch = applyOperatorAction(canvas, 'b', 'edit', [
      { blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' },
    ])
    const before = patch.before!
    expect(before.node).toEqual(structuredClone(canvas.nodes[1]))
    expect(before.edges).toEqual([structuredClone(canvas.edges[0]!)])
    // Mutating the patched node must not reach through into the snapshot.
    ;(patch.nodes.find((n) => n.id === 'b') as WorkflowNode).data['url'] = 'https://c'
    expect(before.node.data['url']).toBe('https://a')
  })

  it('reports a required parameter the edit left empty', () => {
    const patch = applyOperatorAction(
      graph([node('b', 'new-tab', { url: 'https://a' })], []),
      'b',
      'edit',
      [{ blockId: 'new-tab', data: { url: '' }, rationale: '' }],
    )
    expect(patch.missing).toEqual([{ blockId: 'new-tab', name: 'New tab', keys: ['url'] }])
  })

  it('refuses a gone node, an empty answer, a multi-operator answer and another block', () => {
    const canvas = base()
    const one = [{ blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' }]
    expect(applyOperatorAction(canvas, 'zz', 'edit', one).problem).toBe('unknown-target')
    expect(applyOperatorAction(canvas, 'b', 'edit', []).problem).toBe('no-proposal')
    expect(applyOperatorAction(canvas, 'b', 'edit', [one[0]!, one[0]!]).problem).toBe(
      'many-proposals',
    )
    expect(
      applyOperatorAction(canvas, 'b', 'edit', [{ blockId: 'forms', data: {}, rationale: '' }])
        .problem,
    ).toBe('edit-other-block')
    // A refusal never touches the canvas.
    expect(applyOperatorAction(canvas, 'zz', 'edit', one).nodes).toEqual(canvas.nodes)
  })
})

describe('applyOperatorAction replace', () => {
  const toEventClick = (data: Record<string, unknown> = {}): OperatorProposal[] => [
    { blockId: 'event-click', data, rationale: '' },
  ]

  it('keeps the node identity, follows the new block, and migrates by key', () => {
    const canvas = graph(
      [
        node('t', 'trigger'),
        node('b', 'new-tab', { url: 'https://a', disableBlock: true }, { x: 240, y: 60 }),
      ],
      [edge('t', 'b', 'trigger-output-1')],
    )
    const patch = applyOperatorAction(canvas, 'b', 'replace', toEventClick({ selector: '#x' }))
    const replaced = patch.nodes.find((n) => n.id === 'b')!
    expect(patch.problem).toBeUndefined()
    expect(replaced.data['blockId']).toBe('event-click')
    expect(replaced.position).toEqual({ x: 240, y: 60 })
    expect(replaced.label).toBe(BLOCK_BY_ID.get('event-click')?.name)
    expect(replaced.data['selector']).toBe('#x')
    // A parameter the new operator has no field for does not ride along, and the
    // node's own policy does.
    expect(replaced.data['url']).toBeUndefined()
    expect(replaced.data['disableBlock']).toBe(true)
    expect(replaced.data['__workflowAi']).toBeUndefined()
    expect(patch.edges.find((e) => e.target === 'b')?.targetHandle).toBe('event-click-input-1')
    expect(patch.edges).toHaveLength(1)
  })

  it('carries the goal contract across the swap, but not the provenance stamp', () => {
    const canvas = graph(
      [
        node('t', 'trigger'),
        node('b', 'new-tab', {
          url: 'https://a',
          __workflowAi: {
            addedBy: 'ai',
            goalContract: {
              version: 1,
              goal: 'reach the dashboard',
              successCriteria: [{ kind: 'urlContains', value: '/dashboard' }],
            },
          },
        }),
      ],
      [edge('t', 'b', 'trigger-output-1')],
    )
    const patch = applyOperatorAction(canvas, 'b', 'replace', toEventClick({ selector: '#x' }))
    const namespace = patch.nodes.find((n) => n.id === 'b')!.data['__workflowAi'] as Record<
      string,
      unknown
    >
    // The goal says what the STEP must achieve and its criteria are page checks, so
    // changing the operator must not delete the user's own target — that is what an
    // optimization that swaps the block is judged against.
    expect(namespace['goalContract']).toEqual({
      version: 1,
      goal: 'reach the dashboard',
      successCriteria: [{ kind: 'urlContains', value: '/dashboard' }],
    })
    // Provenance is about how the NODE got here, and a swap is not a new AI node.
    expect(namespace['addedBy']).toBeUndefined()
  })

  it('does not stamp the swap as an AI-added node', () => {
    const canvas = graph([node('b', 'new-tab', { __workflowAi: { addedBy: 'ai' } })], [])
    const patch = applyOperatorAction(canvas, 'b', 'replace', toEventClick())
    expect(patch.nodes.find((n) => n.id === 'b')?.data['__workflowAi']).toBeUndefined()
  })

  it('carries the error policy over, so the fallback line survives under the new port', () => {
    const canvas = graph(
      [
        node('t', 'trigger'),
        node('b', 'new-tab', { onError: { enable: true, toDo: 'fallback' } }),
        node('f', 'delay'),
      ],
      [edge('t', 'b', 'trigger-output-1'), edge('b', 'f', 'new-tab-output-fallback')],
    )
    const patch = applyOperatorAction(canvas, 'b', 'replace', toEventClick())
    expect(patch.edges.find((e) => e.id === 'b->f')?.sourceHandle).toBe(
      'event-click-output-fallback',
    )
    expect(patch.pruned).toEqual([])
  })

  it("moves the block's own continuation and names every branch it had to cut", () => {
    const canvas = graph(
      [
        node('t', 'trigger'),
        node('c', 'conditions', {
          paths: [
            { id: 'p1', name: 'First', conditions: [] },
            { id: 'p2', name: 'Second', conditions: [] },
          ],
        }),
        node('a', 'delay'),
        node('b', 'delay'),
        node('n', 'delay'),
      ],
      [
        edge('t', 'c', 'trigger-output-1'),
        edge('c', 'a', 'conditions-output-p1'),
        edge('c', 'b', 'conditions-output-p2'),
        edge('c', 'n', 'conditions-output-none'),
      ],
    )
    const patch = applyOperatorAction(canvas, 'c', 'replace', toEventClick({ selector: '#x' }))
    expect(patch.edges.find((e) => e.id === 'c->a')?.sourceHandle).toBe('event-click-output-1')
    expect(patch.edges.filter((e) => e.source === 'c')).toHaveLength(1)
    // Naming is the point: React Flow would otherwise drop these lines silently.
    expect(patch.pruned).toEqual([
      { handle: 'conditions-output-p2', label: 'Second' },
      { handle: 'conditions-output-none', label: 'fallback' },
    ])
  })

  it('re-hangs a legacy edge that names no handle', () => {
    const canvas = graph(
      [node('b', 'new-tab'), node('c', 'delay')],
      [{ id: 'b->c', source: 'b', target: 'c' } as WorkflowEdge],
    )
    const patch = applyOperatorAction(canvas, 'b', 'replace', toEventClick())
    expect(patch.edges.find((e) => e.id === 'b->c')?.sourceHandle).toBe('event-click-output-1')
  })

  it('reports a required parameter the swap left empty', () => {
    const patch = applyOperatorAction(
      graph([node('b', 'new-tab')], []),
      'b',
      'replace',
      toEventClick(),
    )
    expect(patch.missing[0]?.blockId).toBe('event-click')
    expect(patch.missing[0]?.keys.length).toBeGreaterThan(0)
  })

  it('refuses the entry point, the same operator and an id it was not offered', () => {
    const canvas = graph([node('t', 'trigger'), node('b', 'new-tab')], [edge('t', 'b')])
    expect(applyOperatorAction(canvas, 't', 'replace', toEventClick()).problem).toBe(
      'replace-entry-point',
    )
    expect(
      applyOperatorAction(canvas, 'b', 'replace', [{ blockId: 'new-tab', data: {}, rationale: '' }])
        .problem,
    ).toBe('replace-same-block')
    expect(
      applyOperatorAction(canvas, 'b', 'replace', [{ blockId: 'trigger', data: {}, rationale: '' }])
        .problem,
    ).toBe('replace-unofferable')
    expect(
      applyOperatorAction(canvas, 'b', 'replace', [
        { blockId: 'google-sheets', data: {}, rationale: '' },
      ]).problem,
    ).toBe('replace-unofferable')
  })

  it('undoes a swap back to the exact node and lines that were there', () => {
    const canvas = graph(
      [node('t', 'trigger'), node('b', 'new-tab', { url: 'https://a' }), node('c', 'delay')],
      [edge('t', 'b', 'trigger-output-1'), edge('b', 'c', 'new-tab-output-1')],
    )
    const patch = applyOperatorAction(canvas, 'b', 'replace', toEventClick({ selector: '#x' }))
    const before = patch.before!
    const others = new Set(before.edges.map((e) => e.id))
    const nodes = patch.nodes.map((n) => (n.id === before.node.id ? before.node : n))
    const edges = [...patch.edges.filter((e) => !others.has(e.id)), ...before.edges].sort((x, y) =>
      x.id.localeCompare(y.id),
    )
    expect(nodes).toEqual(canvas.nodes)
    expect(edges).toEqual([...canvas.edges].sort((x, y) => x.id.localeCompare(y.id)))
  })
})

describe('isObservableBlock', () => {
  it('acts only with operators that really run against a page', () => {
    expect(isObservableBlock('event-click')).toBe(true)
    expect(isObservableBlock('new-tab')).toBe(true)
    expect(isObservableBlock('forms')).toBe(true)
  })

  it('never acts with the escape hatch, the browser state, or a recorded-only block', () => {
    // The JS gate is not the assistant's to open, and one chat turn must not
    // grant permissions, open or destroy windows, or take a file handle.
    expect(isObservableBlock('javascript-code')).toBe(false)
    expect(isObservableBlock('cookie')).toBe(false)
    expect(isObservableBlock('new-window')).toBe(false)
    expect(isObservableBlock('close-tab')).toBe(false)
    expect(isObservableBlock('upload-file')).toBe(false)
    expect(isObservableBlock('handle-download')).toBe(false)
    // Nothing to observe: these never touch the page when they run.
    expect(isObservableBlock('webhook')).toBe(false)
    expect(isObservableBlock('save-local')).toBe(false)
    expect(isObservableBlock('blocks-group')).toBe(false)
    // And nothing the canvas could not land anyway.
    expect(isObservableBlock('trigger')).toBe(false)
    expect(isObservableBlock('no-such-block')).toBe(false)
  })
})

describe('proposalsNeedingPage', () => {
  it('asks for a page only where the element is still unresolved', () => {
    expect(proposalsNeedingPage([{ blockId: 'event-click', data: {}, rationale: '' }])).toEqual([
      { blockId: 'event-click', name: 'Click element', keys: ['selector'] },
    ])
    expect(
      proposalsNeedingPage([
        { blockId: 'event-click', data: { selector: '#save' }, rationale: '' },
      ]),
    ).toEqual([])
    // A rich target is a locator too — the page has nothing left to teach it.
    expect(
      proposalsNeedingPage([
        {
          blockId: 'event-click',
          data: { target: { primary: { how: 'text', value: 'Save' } } },
          rationale: '',
        },
      ]),
    ).toEqual([])
  })

  it('does not offer to act for a parameter no action can produce', () => {
    // `webhook` cannot run without a URL, and acting would supply no URL: the
    // step reads no element, so there is nothing on the page to learn from it.
    expect(proposalsNeedingPage([{ blockId: 'webhook', data: {}, rationale: '' }])).toEqual([])
  })

  it('names the position of the gap, so a hand pick writes into the right step', () => {
    const batch: OperatorProposal[] = [
      { blockId: 'event-click', data: { selector: '#save' }, rationale: '' },
      { blockId: 'event-click', data: {}, rationale: '' },
      { blockId: 'webhook', data: {}, rationale: '' },
    ]
    // Two steps of the same operator: only the second one is missing its element,
    // and the id alone could not tell the dock where to put the picked selector.
    expect(proposalIndexesNeedingPage(batch)).toEqual([1])
    expect(
      proposalIndexesNeedingPage([
        { blockId: 'event-click', data: { selector: '#a' }, rationale: '' },
      ]),
    ).toEqual([])
    // The two views of the same gate never disagree.
    expect(proposalIndexesNeedingPage(batch).length).toBe(proposalsNeedingPage(batch).length)
  })

  it('judges the data that will land, not the model’s bare parameters', () => {
    const landed = operatorDataOfProposal('new-tab', { url: 'https://b' })
    expect(landed['url']).toBe('https://b')
    expect(landed['blockId']).toBe('new-tab')
    expect(landed['__workflowAi']).toEqual({ addedBy: 'ai' })
    // The catalog defaults the chain patcher would write still show through, so a
    // requirement they satisfy never asks the user to act.
    expect(landed['active']).toBe(true)
    const block = BLOCK_BY_ID.get('event-click')!
    const merged = operatorDataOfProposal('event-click', { selector: '#a' })
    for (const [key, value] of Object.entries(block.data)) {
      if (key === 'description' || key === 'selector') continue
      expect(merged[key]).toEqual(value)
    }
  })
})
