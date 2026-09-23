import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Draft durability across an MV3 service-worker restart.
 *
 * The handler keeps a module-level cache, and the worker can be evicted between
 * any two tool calls of a long workflow-generation run. These tests reset the
 * module registry to simulate that eviction for real: after the reset, the
 * only surviving state is what reached `chrome.storage.local`.
 *
 * Deliberately a separate file — `vi.resetModules()` would otherwise leak a
 * second copy of the handler into the other draft specs.
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

let chromeMock = makeChromeMock()

beforeEach(() => {
  chromeMock = makeChromeMock()
  vi.stubGlobal('chrome', chromeMock)
  vi.resetModules()
})

/**
 * Import a FRESH handler instance, so any state left over from a previous
 * import is gone — exactly what a worker restart does to the module cache.
 * The reset has to happen immediately before the import: it only affects
 * modules loaded after it.
 */
async function freshHandler() {
  vi.resetModules()
  return import('../src/background/operator-tool-handler')
}

describe('workflow draft survives a service-worker restart', () => {
  it('mirrors every append to storage and rehydrates the whole chain', async () => {
    const before = await freshHandler()
    await before.runOperatorTool({
      name: 'wf_op_new-tab',
      args: { url: 'https://example.com' },
      conversationId: 'conv',
    })
    await before.runOperatorTool({
      name: 'wf_op_event-click',
      args: { selector: '#go' },
      conversationId: 'conv',
    })

    // --- worker evicted ---
    const after = await freshHandler()
    expect(after.getDraftSnapshot('conv')).toBeUndefined()

    const rehydrated = await after.hydrateDraft('conv')
    expect(rehydrated.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'new-tab',
      'event-click',
    ])
    expect(rehydrated.edges.map((e) => e.sourceHandle)).toEqual([
      'trigger-output-1',
      'new-tab-output-1',
    ])
    expect(rehydrated.tail).toBe(rehydrated.nodes[2]!.id)
  })

  it('keeps appending onto the recovered graph instead of starting over', async () => {
    const before = await freshHandler()
    await before.runOperatorTool({
      name: 'wf_op_event-click',
      args: { selector: '#first' },
      conversationId: 'conv',
    })

    const after = await freshHandler()
    const out = await after.runOperatorTool({
      name: 'wf_op_press-key',
      args: { key: 'Enter' },
      conversationId: 'conv',
    })
    expect(out.ok).toBe(true)

    const draft = after.getDraftSnapshot('conv')!
    expect(draft.nodes.map((n) => n.data.blockId)).toEqual(['trigger', 'event-click', 'press-key'])
    // The new node hangs off the recovered tail, not off a fresh trigger.
    const inbound = draft.edges.find((e) => e.target === draft.nodes[2]!.id)
    expect(inbound?.sourceHandle).toBe('event-click-output-1')
  })

  it('preserves a pending branch across the restart', async () => {
    const before = await freshHandler()
    await before.runOperatorTool({
      name: 'wf_op_element-exists',
      args: { selector: '#maybe', next: 'notExists' },
      conversationId: 'conv',
    })

    const after = await freshHandler()
    await after.runOperatorTool({
      name: 'wf_op_event-click',
      args: { selector: '#fallback' },
      conversationId: 'conv',
    })

    const draft = after.getDraftSnapshot('conv')!
    const click = draft.nodes[2]!
    expect(draft.edges.find((e) => e.target === click.id)?.sourceHandle).toBe(
      'element-exists-output-2',
    )
  })

  it('forgets a draft entirely once it is cleared', async () => {
    const before = await freshHandler()
    await before.runOperatorTool({
      name: 'wf_op_event-click',
      args: { selector: '#x' },
      conversationId: 'conv',
    })
    await before.clearDraft('conv')

    const after = await freshHandler()
    const fresh = await after.hydrateDraft('conv')
    expect(after.actionNodesOf(fresh)).toHaveLength(0)
    expect(fresh.nodes).toHaveLength(1)
  })

  it('drops the persisted mirror when a draft is composed and saved', async () => {
    const before = await freshHandler()
    // The click node carries the reliability contract (spec §9 save gate:
    // a generated-strict workflow without postconditions does not save).
    await before.runOperatorTool({
      name: 'wf_op_event-click',
      args: {
        selector: '#x',
        __reliability: {
          intent: '点击目标元素',
          idempotency: 'safe',
          postconditions: [{ kind: 'elementExists', target: { testId: 'x' } }],
        },
      },
      conversationId: 'conv',
    })
    const composed = await before.composeWorkflowFromDraft('conv', { save: true })
    expect('error' in composed).toBe(false)

    const after = await freshHandler()
    const fresh = await after.hydrateDraft('conv')
    expect(after.actionNodesOf(fresh)).toHaveLength(0)
  })
})
