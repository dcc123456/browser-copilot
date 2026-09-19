/**
 * Loop folding: turning a linearly recorded graph into loops.
 *
 * Two folds, two very different risk profiles:
 * - `repeat-task` repeats the body verbatim, so the rewrite is behaviour-
 *   preserving and needs no page knowledge.
 * - `loop-elements` hands each iteration its own element, so the whole fold
 *   rests on ONE selector matching the recorded elements. It is therefore only
 *   applied with a probe-verified selector; every other input must leave the
 *   workflow untouched.
 */
import { describe, expect, it } from 'vitest'
import {
  applyLoopElementsFold,
  applyRepeatTaskFold,
  collapseAdjacentDuplicates,
  detectRepeatRuns,
  nodeSignature,
} from '../src/lib/workflow/loop-collapse'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

function node(id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, label: blockId, position: { x: 0, y: 0 }, data: { blockId, ...data } }
}

function click(id: string, selector: string): WorkflowNode {
  return node(id, 'event-click', { selector })
}

function fill(id: string, selector: string, value: string): WorkflowNode {
  return node(id, 'forms', { selector, value, type: 'text-field' })
}

/** A straight chain: trigger → `nodes`, in the given order. */
function workflow(nodes: WorkflowNode[]): Workflow {
  const all = [node('t', 'trigger', { type: 'manual' }), ...nodes]
  const edges: WorkflowEdge[] = []
  for (let i = 0; i < all.length - 1; i += 1) {
    edges.push({
      id: `e${i}`,
      source: all[i]!.id,
      target: all[i + 1]!.id,
      sourceHandle: `${all[i]!.label}-output-1`,
      targetHandle: `${all[i + 1]!.label}-input-1`,
    })
  }
  return {
    id: 'wf-1',
    name: 'test',
    createdAt: 0,
    updatedAt: 0,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes: all, edges },
    trigger: { type: 'manual', enabled: true },
  }
}

/** Edge lookup by (source, target), for readable assertions. */
function hasEdge(wf: Workflow, source: string, target: string, handle?: string): boolean {
  return wf.drawflow.edges.some(
    (edge) =>
      edge.source === source &&
      edge.target === target &&
      (handle === undefined || edge.sourceHandle === handle),
  )
}

/** The same lookup over a bare edge list (the dedupe helpers return one). */
function links(edges: readonly WorkflowEdge[], source: string, target: string): boolean {
  return edges.some((edge) => edge.source === source && edge.target === target)
}

function loopNodeOf(wf: Workflow, blockId: string): WorkflowNode | undefined {
  return wf.drawflow.nodes.find((n) => n.data?.['blockId'] === blockId)
}

describe('nodeSignature', () => {
  it('ignores presentation-only fields', () => {
    // The model writes a different `description` for every call; treating that
    // as part of the identity would hide every repeat run.
    const a = node('a', 'event-click', { selector: '#go', description: 'click go' })
    const b = node('b', 'event-click', { selector: '#go', description: 'press the button' })
    expect(nodeSignature(a)).toBe(nodeSignature(b))
  })

  it('separates the same action on different elements', () => {
    expect(nodeSignature(click('a', '#x'))).not.toBe(nodeSignature(click('b', '#y')))
  })

  it('separates the same target with a different value', () => {
    expect(nodeSignature(fill('a', '#q', 'one'))).not.toBe(nodeSignature(fill('b', '#q', 'two')))
  })
})

describe('collapseAdjacentDuplicates', () => {
  it('collapses a repeated fill of the same field with the same value', () => {
    // One fill arrives as a debounced input + Enter + blur flush.
    const out = collapseAdjacentDuplicates(
      [fill('a', '#q', 'hello'), fill('b', '#q', 'hello'), fill('c', '#q', 'hello')],
      [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
    )
    expect(out.removed).toEqual(['b', 'c'])
    expect(out.nodes.map((n) => n.id)).toEqual(['a'])
  })

  it('keeps a genuine sequence of different values', () => {
    const out = collapseAdjacentDuplicates(
      [fill('a', '#q', 'one'), fill('b', '#q', 'two')],
      [{ id: 'e1', source: 'a', target: 'b' }],
    )
    expect(out.removed).toEqual([])
  })

  it('keeps two clicks on the same button', () => {
    // A repeat click is a real action, not a capture artefact — only fills are
    // deduped (the rule `record-convert` uses).
    const out = collapseAdjacentDuplicates(
      [click('a', '#go'), click('b', '#go')],
      [{ id: 'e1', source: 'a', target: 'b' }],
    )
    expect(out.removed).toEqual([])
  })

  it('re-links around the dropped nodes', () => {
    const out = collapseAdjacentDuplicates(
      [click('a', '#go'), fill('b', '#q', 'x'), fill('c', '#q', 'x'), click('d', '#next')],
      [
        { id: 'e1', source: 'a', target: 'b', sourceHandle: 'event-click-output-1' },
        { id: 'e2', source: 'b', target: 'c' },
        { id: 'e3', source: 'c', target: 'd' },
      ],
    )
    // Only the DUPLICATE is dropped; the first occurrence stays.
    expect(out.removed).toEqual(['c'])
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b', 'd'])
    expect(links(out.edges, 'a', 'b')).toBe(true)
    // `b` now points past the dropped `c` at `d`, keeping its own out-handle.
    expect(out.edges.find((e) => e.source === 'b')?.target).toBe('d')
    expect(out.edges.some((e) => e.source === 'c' || e.target === 'c')).toBe(false)
  })
})

describe('detectRepeatRuns', () => {
  it('finds an identical run', () => {
    const wf = workflow([click('a', '#add'), click('b', '#add'), click('c', '#add')])
    const [suggestion, ...rest] = detectRepeatRuns(wf)

    expect(rest).toEqual([])
    expect(suggestion).toMatchObject({
      kind: 'identical',
      blockId: 'event-click',
      repeat: 3,
      runIds: ['a', 'b', 'c'],
      bodyIds: ['a'],
    })
  })

  it('finds a varying run', () => {
    const wf = workflow([click('a', '#row-1'), click('b', '#row-2'), click('c', '#row-3')])
    const [suggestion] = detectRepeatRuns(wf)

    expect(suggestion).toMatchObject({
      kind: 'varying',
      repeat: 3,
      selectors: ['#row-1', '#row-2', '#row-3'],
      bodyIds: ['a'],
    })
  })

  it('ignores a run of one', () => {
    expect(detectRepeatRuns(workflow([click('a', '#only')]))).toEqual([])
  })

  it('ignores a same-target run whose difference is the value', () => {
    // `loop-elements` iterates elements, so it cannot express "the same field
    // with a different value" — offering the fold would offer a no-op.
    const wf = workflow([fill('a', '#q', 'one'), fill('b', '#q', 'two')])
    expect(detectRepeatRuns(wf)).toEqual([])
  })

  it('ignores a run that shares a block but not a shape', () => {
    const wf = workflow([
      node('a', 'forms', { selector: '#x', value: '1', type: 'text-field' }),
      node('b', 'forms', { selector: '#y', value: '2', type: 'select' }),
    ])
    expect(detectRepeatRuns(wf)).toEqual([])
  })

  it('never folds the trigger', () => {
    // Two manual triggers would be nonsense; the chain starts after the head.
    expect(detectRepeatRuns(workflow([]))).toEqual([])
  })

  it('bails out on a branched graph', () => {
    // A fork means the recorded order is not one straight sequence, and folding
    // it would need real reachability analysis rather than a linear scan.
    const wf = workflow([click('a', '#x'), click('b', '#x'), click('c', '#x')])
    wf.drawflow.edges.push({
      id: 'branch',
      source: 'a',
      target: 'c',
      sourceHandle: 'event-click-output-2',
    })
    expect(detectRepeatRuns(wf)).toEqual([])
  })
})

describe('applyRepeatTaskFold', () => {
  it('replaces an identical run with a repeat-task loop', () => {
    const wf = workflow([
      click('a', '#add'),
      click('b', '#add'),
      click('c', '#add'),
      click('d', '#checkout'),
    ])
    const [suggestion] = detectRepeatRuns(wf)
    const out = applyRepeatTaskFold(wf, suggestion!)

    const loop = loopNodeOf(out, 'repeat-task')
    expect(loop?.data['repeatFor']).toBe(3)

    // The run collapses to ONE body node; the other two are gone.
    expect(out.drawflow.nodes.map((n) => n.id).sort()).toEqual(['a', 'd', 't', loop!.id].sort())

    // trigger → loop → body, body → loop (one iteration), loop → after-loop.
    expect(hasEdge(out, 't', loop!.id)).toBe(true)
    expect(hasEdge(out, loop!.id, 'a', 'repeat-task-output-1')).toBe(true)
    expect(hasEdge(out, 'a', loop!.id)).toBe(true)
    expect(hasEdge(out, loop!.id, 'd', 'repeat-task-output-2')).toBe(true)
  })

  it('leaves no edge pointing at a removed node', () => {
    const wf = workflow([click('a', '#add'), click('b', '#add'), click('c', '#next')])
    const [suggestion] = detectRepeatRuns(wf)
    const out = applyRepeatTaskFold(wf, suggestion!)
    const ids = new Set(out.drawflow.nodes.map((n) => n.id))
    for (const edge of out.drawflow.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
    }
  })

  it('refuses a suggestion of the other kind', () => {
    const wf = workflow([click('a', '#x'), click('b', '#y')])
    const [suggestion] = detectRepeatRuns(wf)
    expect(applyRepeatTaskFold(wf, suggestion!)).toBe(wf)
  })

  it('keeps the node array in flow order', () => {
    // The editor lays nodes out in array order, so a loop appended at the end
    // would jump to the right of the graph.
    const wf = workflow([click('a', '#add'), click('b', '#add'), click('c', '#next')])
    const [suggestion] = detectRepeatRuns(wf)
    const out = applyRepeatTaskFold(wf, suggestion!)
    const ids = out.drawflow.nodes.map((n) => n.id)
    expect(ids[0]).toBe('t')
    expect(ids[1]).toMatch(/^repeat-task-/)
    // The surviving iteration follows the loop that drives it.
    expect(ids[2]).toBe('a')
    expect(ids[3]).toBe('c')
  })
})

describe('applyLoopElementsFold', () => {
  const run = () => workflow([click('a', '#row-1'), click('b', '#row-2'), click('c', '#row-3')])

  it('rewrites the body to target the loop element', () => {
    const wf = run()
    const [suggestion] = detectRepeatRuns(wf)
    const out = applyLoopElementsFold(wf, suggestion!, '.row')

    const loop = loopNodeOf(out, 'loop-elements')
    expect(loop?.data['selector']).toBe('.row')
    const body = out.drawflow.nodes.find((n) => n.id === 'a')
    expect(body?.data['selector']).toBe('{{loopElementSelector}}')
    // The recorded rich locator would pin every iteration to element #1.
    expect(body?.data['target']).toBeUndefined()
  })

  it('wires the loop body and the after-loop port', () => {
    const wf = run()
    const [suggestion] = detectRepeatRuns(wf)
    const out = applyLoopElementsFold(wf, suggestion!, '.row')
    const loop = loopNodeOf(out, 'loop-elements')!

    expect(hasEdge(out, loop.id, 'a', 'loop-elements-output-1')).toBe(true)
    expect(hasEdge(out, 'a', loop.id)).toBe(true)
    // Nothing follows the run, so there is no after-loop edge to add.
    expect(out.drawflow.edges.some((e) => e.sourceHandle === 'loop-elements-output-2')).toBe(false)
  })

  it('refuses without a verified selector', () => {
    // The whole fold rests on that one selector matching the recorded elements;
    // guessing it would make the loop iterate the wrong set.
    const wf = run()
    const [suggestion] = detectRepeatRuns(wf)
    expect(applyLoopElementsFold(wf, suggestion!, null)).toBe(wf)
    expect(applyLoopElementsFold(wf, suggestion!, '   ')).toBe(wf)
  })

  it('refuses a suggestion of the other kind', () => {
    const wf = workflow([click('a', '#add'), click('b', '#add')])
    const [suggestion] = detectRepeatRuns(wf)
    expect(applyLoopElementsFold(wf, suggestion!, '.row')).toBe(wf)
  })
})

describe('compound period detection (list → detail → back)', () => {
  /**
   * The natural recording of "collect every entry's details": per item, open
   * the card, read two fields on the detail page, go back to the list.
   */
  function bossChain(items: number, extra: WorkflowNode[] = []): Workflow {
    const nodes: WorkflowNode[] = []
    for (let i = 0; i < items; i += 1) {
      nodes.push(click(`card-${i}`, `.job-list > li:nth-child(${i + 1}) .job-name`))
      nodes.push(node(`title-${i}`, 'get-text', { selector: '.job-detail .name', saveData: true }))
      nodes.push(node(`req-${i}`, 'get-text', { selector: '.job-detail .req', saveData: true }))
      nodes.push(node(`back-${i}`, 'go-back', {}))
    }
    return workflow([...nodes, ...extra])
  }

  it('detects the open → read → go-back period and folds it into one loop', () => {
    const wf = bossChain(3)
    const suggestions = detectRepeatRuns(wf)
    // No same-block run exists here — the blocks alternate. The compound scan
    // is what sees the period.
    const [suggestion] = suggestions
    expect(suggestion).toBeDefined()
    expect(suggestion!.kind).toBe('varying')
    expect(suggestion!.repeat).toBe(3)
    // One full period survives as the body: click + two reads + go-back.
    expect(suggestion!.bodyIds).toEqual(['card-0', 'title-0', 'req-0', 'back-0'])
    // The per-item selectors the probe must verify, in recorded order.
    expect(suggestion!.selectors).toHaveLength(3)

    const out = applyLoopElementsFold(wf, suggestion!, '.job-list > li')
    const loop = loopNodeOf(out, 'loop-elements')!
    expect(loop.data['selector']).toBe('.job-list > li')
    // Only the head acts on the loop element; the detail reads and the go-back
    // keep their own targets.
    const bodyHead = out.drawflow.nodes.find((n) => n.id === 'card-0')!
    expect(bodyHead.data['selector']).toBe('{{loopElementSelector}}')
    expect(out.drawflow.nodes.find((n) => n.id === 'title-0')!.data['selector']).toBe(
      '.job-detail .name',
    )
    // Body cycle: head … body tail back into the loop; iterations 2-3 dropped.
    expect(hasEdge(out, loop.id, 'card-0', 'loop-elements-output-1')).toBe(true)
    expect(hasEdge(out, 'back-0', loop.id)).toBe(true)
    const ids = new Set(out.drawflow.nodes.map((n) => n.id))
    expect(ids.has('card-1')).toBe(false)
    expect(ids.has('back-2')).toBe(false)
  })

  it('leaves a partial trailing period linear', () => {
    // Two full periods plus a bare card click: the fold covers the periods and
    // nothing else — inventing a body for the tail would fabricate behaviour.
    const wf = bossChain(2, [click('card-2', '.job-list > li:nth-child(3) .job-name')])
    const [suggestion] = detectRepeatRuns(wf)
    expect(suggestion!.repeat).toBe(2)
    const out = applyLoopElementsFold(wf, suggestion!, '.job-list > li')
    const ids = new Set(out.drawflow.nodes.map((n) => n.id))
    expect(ids.has('card-2')).toBe(true)
    // The tail hangs off the loop's after-loop port.
    const loop = loopNodeOf(out, 'loop-elements')!
    expect(hasEdge(out, loop.id, 'card-2', 'loop-elements-output-2')).toBe(true)
  })

  it('does not fold when the head varies by value, not by target', () => {
    // A per-item form fill with a DIFFERENT text each period cannot be folded:
    // the rewrite replaces the selector only, so one recorded value would run
    // for every iteration.
    const wf = workflow([
      fill('f-0', '.search input', '前端'),
      node('r-0', 'get-text', { selector: '.count' }),
      fill('f-1', '.search input', '上海'),
      node('r-1', 'get-text', { selector: '.count' }),
    ])
    expect(detectRepeatRuns(wf)).toEqual([])
  })

  it('does not fold when a body step drifts between periods', () => {
    // The second read's selector differs per item — that is a different read,
    // not an iteration; folding it would replay one page's layout for all.
    const wf = workflow([
      click('card-0', '.list li:nth-child(1)'),
      node('a-0', 'get-text', { selector: '.detail .name' }),
      node('b-0', 'get-text', { selector: '.detail .req-1' }),
      click('card-1', '.list li:nth-child(2)'),
      node('a-1', 'get-text', { selector: '.detail .name' }),
      node('b-1', 'get-text', { selector: '.detail .req-2' }),
    ])
    // The block-level scan may still offer its own (pre-existing) fold for the
    // adjacent reads; the point is that no COMPOUND period is reported — every
    // block-level suggestion carries a single-node body.
    expect(detectRepeatRuns(wf).filter((s) => s.bodyIds.length > 1)).toEqual([])
  })

  it('does not double-report a period that overlaps a same-block run', () => {
    // [click, click, read] × 2: the block scan claims the clicks; the compound
    // scan must not also offer a fold over the same nodes.
    const wf = workflow([
      click('c-0', '.row:nth-child(1)'),
      click('d-0', '.row:nth-child(1) .btn'),
      node('r-0', 'get-text', { selector: '.status' }),
      click('c-1', '.row:nth-child(2)'),
      click('d-1', '.row:nth-child(2) .btn'),
      node('r-1', 'get-text', { selector: '.status' }),
    ])
    const suggestions = detectRepeatRuns(wf)
    const seen = new Set<string>()
    for (const run of suggestions) {
      for (const id of run.runIds) {
        expect(seen.has(id), `node ${id} claimed twice`).toBe(false)
        seen.add(id)
      }
    }
    // The block-level click run is still there — it covers more iterations.
    expect(suggestions.some((s) => s.blockId === 'event-click' && s.repeat === 2)).toBe(true)
  })
})
