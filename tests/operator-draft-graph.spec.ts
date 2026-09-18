import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * In-memory `chrome.storage.local` double. The draft is mirrored to durable
 * storage on every append, so the tests need a storage that actually persists
 * (`fs-store` resolves `chrome` lazily, so stubbing per test is enough).
 */
function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    store,
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const key of wanted) {
            if (store.has(key)) out[key] = store.get(key)
          }
          return out
        },
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        },
        remove: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          for (const key of wanted) store.delete(key)
        },
      },
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('chrome', makeChromeMock())
})

import {
  actionNodesOf,
  clearDraft,
  composeWorkflowFromDraft,
  ensureTriggerHead,
  getDraftSnapshot,
  loadDraftFromWorkflow,
  outputSuffixOf,
  runOperatorTool,
} from '../src/background/operator-tool-handler'
import type { WorkflowDraft } from '../src/background/operator-tool-handler'
import type { Workflow } from '../src/lib/workflow/types'

/** Append one operator node and return the resulting draft. */
async function append(
  conversationId: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<WorkflowDraft> {
  const out = await runOperatorTool({ name: tool, args, conversationId })
  if (!out.ok) throw new Error(out.error)
  const draft = getDraftSnapshot(conversationId)
  if (!draft) throw new Error('draft missing')
  return draft
}

/** Edge `sourceHandle` for the edge arriving at the newest node. */
function inboundHandle(draft: WorkflowDraft, nodeId: string): string | undefined {
  return draft.edges.find((e) => e.target === nodeId)?.sourceHandle
}

describe('operator draft graph', () => {
  it('starts every draft at a trigger head node', async () => {
    const draft = await append('c-trigger', 'wf_op_event-click', { selector: '#go' })

    expect(draft.nodes).toHaveLength(2)
    expect(draft.nodes[0]!.data.blockId).toBe('trigger')
    expect(draft.nodes[0]!.data.type).toBe('manual')
    // The trigger is the head: nothing feeds it, and it feeds the first action.
    expect(draft.edges.every((e) => e.target !== draft.nodes[0]!.id)).toBe(true)

    const first = draft.nodes[1]!
    expect(first.data.blockId).toBe('event-click')
    expect(inboundHandle(draft, first.id)).toBe('trigger-output-1')
  })

  it('wires linear appends with canonical block-keyed handles', async () => {
    const conversation = 'c-linear'
    await append(conversation, 'wf_op_event-click', { selector: '#go' })
    const draft = await append(conversation, 'wf_op_forms', { selector: '#q', value: 'hi' })

    const click = draft.nodes[1]!
    const forms = draft.nodes[2]!
    expect(inboundHandle(draft, click.id)).toBe('trigger-output-1')
    expect(inboundHandle(draft, forms.id)).toBe('event-click-output-1')
    // Never the bare `next` the engine's branch resolution cannot map.
    expect(draft.edges.some((e) => e.sourceHandle === 'next')).toBe(false)
    // Target handles are block-keyed too, so the canvas can heal them.
    expect(draft.edges.find((e) => e.target === forms.id)?.targetHandle).toBe('forms-input-1')
  })

  it('records the blockId on the node so the engine never reads a label', async () => {
    const draft = await append('c-blockid', 'wf_op_press-key', { key: 'Enter' })
    expect(draft.nodes[1]!.data.blockId).toBe('press-key')
    expect(draft.nodes[1]!.label).toBe('press-key')
  })

  it('routes the next node onto the output the branch actually took', async () => {
    const conversation = 'c-branch'
    await append(conversation, 'wf_op_element-exists', { selector: '#maybe', next: 'notExists' })
    const draft = await append(conversation, 'wf_op_event-click', { selector: '#fallback' })

    const branch = draft.nodes[1]!
    const click = draft.nodes[2]!
    expect(inboundHandle(draft, branch.id)).toBe('trigger-output-1')
    expect(inboundHandle(draft, click.id)).toBe('element-exists-output-2')
  })

  it('consumes a pending branch only once', async () => {
    const conversation = 'c-branch-once'
    await append(conversation, 'wf_op_conditions', { code: 'vars.n > 1', next: 'false' })
    await append(conversation, 'wf_op_event-click', { selector: '#a' })
    const draft = await append(conversation, 'wf_op_event-click', { selector: '#b' })

    const first = draft.nodes[2]!
    const second = draft.nodes[3]!
    expect(inboundHandle(draft, first.id)).toBe('conditions-output-2')
    // Back to the linear tail once the branch is spent.
    expect(inboundHandle(draft, second.id)).toBe('event-click-output-1')
  })

  it('strips the model-only next/workflowName affordances from node data', async () => {
    const draft = await append('c-strip', 'wf_op_delay', {
      time: 500,
      next: 'output-1',
      workflowName: 'my flow',
    })
    expect(draft.nodes[1]!.data).not.toHaveProperty('next')
    expect(draft.nodes[1]!.data).not.toHaveProperty('workflowName')
    expect(draft.name).toBe('my flow')
  })

  it('normalises every semantic branch key to a port suffix', () => {
    expect(outputSuffixOf('true')).toBe('output-1')
    expect(outputSuffixOf('exists')).toBe('output-1')
    expect(outputSuffixOf('loop')).toBe('output-1')
    expect(outputSuffixOf('false')).toBe('output-2')
    expect(outputSuffixOf('notExists')).toBe('output-2')
    expect(outputSuffixOf('end')).toBe('output-2')
    expect(outputSuffixOf('output-3')).toBe('output-3')
    expect(outputSuffixOf('fallback')).toBe('output-fallback')
    expect(outputSuffixOf('nonsense')).toBeNull()
    expect(outputSuffixOf(42)).toBeNull()
  })
})

describe('composeWorkflowFromDraft', () => {
  it('refuses to compose a draft that only has its trigger', async () => {
    const conversation = 'c-empty'
    // Touch the draft so it exists, then remove the action node's reason to be.
    const draft = await append(conversation, 'wf_op_event-click', { selector: '#x' })
    draft.nodes = draft.nodes.filter((n) => n.data.blockId === 'trigger')
    draft.edges = []

    expect(actionNodesOf(draft)).toHaveLength(0)
    const out = await composeWorkflowFromDraft(conversation, { save: false })
    expect(out).toEqual({ error: 'No draft to compose. Call wf_op_* tools first.' })
  })

  it('derives the top-level trigger mirror from the graph trigger node', async () => {
    const conversation = 'c-compose'
    const draft = await append(conversation, 'wf_op_event-click', { selector: '#x' })
    // Simulate the user picking a schedule in the save card.
    const triggerNode = draft.nodes.find((n) => n.data.blockId === 'trigger')!
    triggerNode.data.type = 'interval'
    triggerNode.data.interval = 15

    const out = await composeWorkflowFromDraft(conversation, { save: false })
    if ('error' in out) throw new Error(out.error)

    expect(out.saved).toBe(false)
    expect(out.workflow.trigger).toEqual({ type: 'interval', enabled: true })
    expect(out.workflow.drawflow.nodes[0]!.data.blockId).toBe('trigger')
  })

  it('leaves the draft in place when composing without saving', async () => {
    const conversation = 'c-keep'
    await append(conversation, 'wf_op_event-click', { selector: '#x' })
    await composeWorkflowFromDraft(conversation, { save: false })
    expect(getDraftSnapshot(conversation)).toBeDefined()
    await clearDraft(conversation)
    expect(getDraftSnapshot(conversation)).toBeUndefined()
  })
})

describe('ensureTriggerHead', () => {
  it('prepends a trigger and wires it to the graph head when one is missing', () => {
    const draft: WorkflowDraft = {
      conversationId: 'c-heal',
      name: 'heal',
      nodes: [
        {
          id: 'a',
          label: 'event-click',
          position: { x: 0, y: 0 },
          data: { blockId: 'event-click' },
        },
        { id: 'b', label: 'forms', position: { x: 220, y: 0 }, data: { blockId: 'forms' } },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'event-click-output-1' }],
      tail: 'b',
      source: 'chat-history',
    }

    const triggerId = ensureTriggerHead(draft)
    expect(draft.nodes[0]!.id).toBe(triggerId)
    expect(draft.nodes[0]!.data.blockId).toBe('trigger')
    // `a` had no inbound edge, so the trigger takes it over.
    const inbound = draft.edges.find((e) => e.target === 'a')
    expect(inbound?.source).toBe(triggerId)
    expect(inbound?.sourceHandle).toBe('trigger-output-1')
    expect(inbound?.targetHandle).toBe('event-click-input-1')
  })

  it('is idempotent when a trigger node already exists', () => {
    const draft: WorkflowDraft = {
      conversationId: 'c-idem',
      name: 'idem',
      nodes: [
        { id: 't', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
      ],
      edges: [],
      tail: 't',
      source: 'chat-generate',
    }
    expect(ensureTriggerHead(draft)).toBe('t')
    expect(draft.nodes).toHaveLength(1)
  })
})

describe('loadDraftFromWorkflow', () => {
  it('heals a history-derived workflow that lacks a trigger node', async () => {
    const workflow = {
      name: 'from history',
      drawflow: {
        nodes: [
          {
            id: 'n1',
            label: 'event-click',
            position: { x: 0, y: 0 },
            data: { blockId: 'event-click' },
          },
        ],
        edges: [],
      },
    } as unknown as Pick<Workflow, 'name' | 'drawflow'>

    const draft = await loadDraftFromWorkflow('c-history', workflow)
    expect(draft).not.toBeNull()
    expect(draft!.nodes[0]!.data.blockId).toBe('trigger')
    expect(draft!.source).toBe('chat-history')
    await clearDraft('c-history')
  })

  it('returns null for an empty graph', async () => {
    const empty = { name: 'x', drawflow: { nodes: [], edges: [] } } as unknown as Pick<
      Workflow,
      'name' | 'drawflow'
    >
    expect(await loadDraftFromWorkflow('c-none', empty)).toBeNull()
  })
})
