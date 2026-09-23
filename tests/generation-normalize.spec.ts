import { describe, expect, it } from 'vitest'
import { normalizeWorkflowDraft } from '../src/background/workflow-engine/generation/normalize'
import type { WorkflowDraft } from '../src/lib/workflow/draft-types'
import type { WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

let seq = 0
function nid(): string {
  seq += 1
  return `n${seq}`
}

function node(blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: nid(),
    label: blockId,
    position: { x: 0, y: 0 },
    data: { blockId, ...data },
  }
}

/** Build a draft with an auto-chained trigger → given nodes. */
function draftOf(nodes: WorkflowNode[]): WorkflowDraft {
  const trigger: WorkflowNode = {
    id: 't',
    label: 'trigger',
    position: { x: 0, y: 0 },
    data: { blockId: 'trigger', type: 'manual' },
  }
  const all = [trigger, ...nodes]
  const edges: WorkflowEdge[] = []
  for (let i = 0; i < all.length - 1; i += 1) {
    edges.push({ id: `e${i}`, source: all[i]!.id, target: all[i + 1]!.id })
  }
  return {
    conversationId: 'c1',
    name: 'test',
    nodes: all,
    edges,
    tail: all.at(-1)!.id,
    source: 'chat-generate',
    goalText: 'do the business task',
  }
}

describe('workflow generation normalization', () => {
  it('collapses consecutive duplicate clicks on the same selector', () => {
    const result = normalizeWorkflowDraft(
      draftOf([
        node('event-click', { selector: '.buy' }),
        node('event-click', { selector: '.buy' }),
        node('event-click', { selector: '.confirm' }),
      ]),
    )
    const clicks = result.draft.nodes.filter((n) => n.label === 'event-click')
    expect(clicks).toHaveLength(2)
    expect(result.removedNodeIds).toHaveLength(1)
    expect(result.notes.some((x) => x.code === 'DUPLICATE_CLICK')).toBe(true)
  })

  it('collapses consecutive duplicate navigation to the same url', () => {
    const result = normalizeWorkflowDraft(
      draftOf([
        node('new-tab', { url: 'https://a.com' }),
        node('new-tab', { url: 'https://a.com' }),
      ]),
    )
    expect(result.draft.nodes.filter((n) => n.label === 'new-tab')).toHaveLength(1)
    expect(result.notes.some((x) => x.code === 'DUPLICATE_NAVIGATION')).toBe(true)
  })

  it('keeps navigation to different urls', () => {
    const result = normalizeWorkflowDraft(
      draftOf([
        node('new-tab', { url: 'https://a.com' }),
        node('new-tab', { url: 'https://b.com' }),
      ]),
    )
    expect(result.draft.nodes.filter((n) => n.label === 'new-tab')).toHaveLength(2)
    expect(result.removedNodeIds).toHaveLength(0)
  })

  it('drops a small fixed delay before a readiness-protected action', () => {
    const result = normalizeWorkflowDraft(
      draftOf([node('delay', { time: 300 }), node('event-click', { selector: '.go' })]),
    )
    expect(result.draft.nodes.some((n) => n.label === 'delay')).toBe(false)
    expect(result.notes.some((x) => x.code === 'REDUNDANT_DELAY')).toBe(true)
  })

  it('keeps a long delay (readiness cannot replace it)', () => {
    const result = normalizeWorkflowDraft(
      draftOf([node('delay', { time: 3000 }), node('event-click', { selector: '.go' })]),
    )
    expect(result.draft.nodes.some((n) => n.label === 'delay')).toBe(true)
  })

  it('removes an exploratory hover that is not a same-element precondition', () => {
    const result = normalizeWorkflowDraft(
      draftOf([
        node('hover-element', { selector: '.menu' }),
        node('event-click', { selector: '.item' }),
      ]),
    )
    expect(result.draft.nodes.some((n) => n.label === 'hover-element')).toBe(false)
    expect(result.notes.some((x) => x.code === 'EXPLORATORY_ACTION')).toBe(true)
  })

  it('keeps a hover that is a precondition for the same element', () => {
    const result = normalizeWorkflowDraft(
      draftOf([
        node('hover-element', { selector: '.card' }),
        node('event-click', { selector: '.card' }),
      ]),
    )
    expect(result.draft.nodes.some((n) => n.label === 'hover-element')).toBe(true)
  })

  it('removes a zero-delta exploratory scroll but keeps a real scroll', () => {
    const removed = normalizeWorkflowDraft(
      draftOf([
        node('element-scroll', { selector: 'html', scrollX: 0, scrollY: 0 }),
        node('event-click', { selector: '.go' }),
      ]),
    )
    expect(removed.draft.nodes.some((n) => n.label === 'element-scroll')).toBe(false)

    const kept = normalizeWorkflowDraft(
      draftOf([
        node('element-scroll', { selector: 'html', scrollX: 0, scrollY: 600 }),
        node('event-click', { selector: '.go' }),
      ]),
    )
    expect(kept.draft.nodes.some((n) => n.label === 'element-scroll')).toBe(true)
  })

  it('extracts forms literals as input candidates without rewriting them', () => {
    const result = normalizeWorkflowDraft(
      draftOf([node('forms', { selector: '#q', value: 'iPhone 17 Pro Max' })]),
    )
    expect(result.inputCandidates).toHaveLength(1)
    expect(result.inputCandidates[0]!.value).toBe('iPhone 17 Pro Max')
    // No nodes removed and the literal is still on the node here.
    expect(result.draft.nodes).toHaveLength(2)
    expect(result.notes.some((x) => x.code === 'INPUT_CANDIDATE')).toBe(true)
  })

  it('preserves verified business nodes and the trigger head', () => {
    const result = normalizeWorkflowDraft(
      draftOf([
        node('new-tab', { url: 'https://a.com' }),
        node('forms', { selector: '#q', value: 'iPhone' }),
        node('event-click', { selector: '.search' }),
      ]),
    )
    expect(result.draft.nodes[0]!.label).toBe('trigger')
    expect(result.draft.nodes.some((n) => n.label === 'forms')).toBe(true)
    expect(result.draft.nodes.some((n) => n.label === 'event-click')).toBe(true)
  })

  it('does not change the goal text', () => {
    const result = normalizeWorkflowDraft(
      draftOf([
        node('event-click', { selector: '.buy' }),
        node('event-click', { selector: '.buy' }),
      ]),
    )
    expect(result.draft.goalText).toBe('do the business task')
  })

  it('rewires edges around removed linear nodes (graph stays connected)', () => {
    const result = normalizeWorkflowDraft(
      draftOf([
        node('delay', { time: 200 }),
        node('event-click', { selector: '.go' }),
      ]),
    )
    // trigger directly edges into the click after the delay is removed.
    const edge = result.draft.edges.find((e) => e.source === 't')
    const clickId = result.draft.nodes.find((n) => n.label === 'event-click')!.id
    expect(edge?.target).toBe(clickId)
  })

  it('does not remove branch-scoped nodes', () => {
    // Build a node with two incoming edges (a merge) — never linear-removable.
    const draft = draftOf([
      node('event-click', { selector: '.a' }),
      node('delay', { time: 200 }),
      node('event-click', { selector: '.go' }),
    ])
    const delayNode = draft.nodes.find((n) => n.label === 'delay')!
    // Add a second incoming edge into the delay from the trigger.
    draft.edges.push({ id: 'extra', source: 't', target: delayNode.id })
    const result = normalizeWorkflowDraft(draft)
    expect(result.draft.nodes.some((n) => n.label === 'delay')).toBe(true)
  })
})
