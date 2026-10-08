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

/**
 * The pre-save trial replay as the compose path uses it (first-run-success D2).
 *
 * The one property worth a worker-restart-grade test: the trial is evidence,
 * so a graph it dislikes must still end up in storage. The other is that
 * reviewing a draft never replays it — the user's page is not the review card's
 * to drive.
 */
describe('the pre-save trial in the compose path', () => {
  async function draftWithOneClick() {
    const handler = await freshHandler()
    await handler.runOperatorTool({
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
    return handler
  }

  const failedRecord = {
    outcome: 'failed' as const,
    at: 1,
    full: false,
    coveredSteps: 1,
    totalSteps: 2,
    failureCode: 'LOCATOR_NOT_FOUND',
  }

  it('saves the workflow even when the trial says it is broken', async () => {
    const handler = await draftWithOneClick()
    const composed = await handler.composeWorkflowFromDraft('conv', {
      save: true,
      trial: async (workflow) => ({ workflow, record: failedRecord }),
    })
    expect('error' in composed).toBe(false)
    if ('error' in composed) throw new Error(composed.error)
    expect(composed.saved).toBe(true)

    const { getWorkflow } = await import('../src/lib/workflow/storage')
    const stored = await getWorkflow(composed.workflow.id)
    expect(stored?.settings.trialRun).toMatchObject({ outcome: 'failed' })
    expect(
      stored?.settings.generationStages?.find((stage) => stage.stage === 'INDEPENDENT_VERIFY'),
    ).toMatchObject({ status: 'warn' })
  })

  it('saves the graph the trial healed, not the one it started from', async () => {
    const handler = await draftWithOneClick()
    const composed = await handler.composeWorkflowFromDraft('conv', {
      save: true,
      trial: async (workflow) => {
        const healed = structuredClone(workflow)
        const click = healed.drawflow.nodes.find((n) => n.data['blockId'] === 'event-click')!
        click.data['selector'] = '#healed'
        return {
          workflow: healed,
          record: { ...failedRecord, outcome: 'partial' as const, degradedSteps: 1 },
        }
      },
    })
    if ('error' in composed) throw new Error(composed.error)
    const { getWorkflow } = await import('../src/lib/workflow/storage')
    const stored = await getWorkflow(composed.workflow.id)
    expect(
      stored?.drawflow.nodes.find((n) => n.data['blockId'] === 'event-click')?.data['selector'],
    ).toBe('#healed')
  })

  it('does not replay a draft that is only being reviewed', async () => {
    const handler = await draftWithOneClick()
    let calls = 0
    await handler.composeWorkflowFromDraft('conv', {
      save: false,
      trial: async (workflow) => {
        calls += 1
        return { workflow, record: failedRecord }
      },
    })
    expect(calls).toBe(0)
  })
})
