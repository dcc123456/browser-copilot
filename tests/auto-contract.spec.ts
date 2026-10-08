import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  autoCompleteReliability,
  inferIdempotency,
} from '../src/lib/workflow/auto-contract'
import { runOperatorTool, composeWorkflowFromDraft } from '../src/background/operator-tool-handler'
import { goalSpecOf } from '../src/lib/workflow/reliability'
import { validateWorkflowForRun } from '../src/lib/workflow/validation'
import { validateGeneratedWorkflow } from '../src/lib/workflow/generated-validation'
import type { NodeReliabilitySpec } from '../src/lib/workflow/reliability'

/** In-memory `chrome.storage.local` double. */
function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const key of wanted) if (store.has(key)) out[key] = store.get(key)
          return out
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          for (const key of wanted) store.delete(key)
        }),
      },
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('chrome', makeChromeMock())
})

describe('auto reliability completion (generation must always succeed)', () => {
  it('infers idempotency from the action semantics', () => {
    expect(inferIdempotency('forms', { action: 'submit' })).toBe('unsafe')
    expect(inferIdempotency('event-click', {})).toBe('safe')
    expect(inferIdempotency('webhook', {})).toBe('unsafe')
  })

  it('a forms node with no action is a fill, not a submit', () => {
    // The executor sends `{action:'fill'}` when no verb is given, so reading the
    // missing verb as a submit invented an `idempotency: 'unsafe'` on a title
    // field — and since the trial never replays past an unsafe step, that cut a
    // generated graph off eight steps in and left the rest unproven.
    expect(inferIdempotency('forms', {})).toBe('conditional')
    const nodes: Array<{ data: Record<string, unknown> }> = [
      { data: { blockId: 'forms', selector: '#title', value: 'note title' } },
    ]
    autoCompleteReliability(nodes)
    const spec = (nodes[0]!.data!['__reliability'] ?? {}) as Record<string, unknown>
    expect(spec['idempotency']).toBeUndefined()
  })

  it('never overrides a model-written contract, only fills gaps', () => {
    const nodes = [
      {
        data: {
          blockId: 'forms',
          action: 'submit',
          __reliability: {
            idempotency: 'unsafe',
            postconditions: [{ kind: 'urlContains', value: '/done' }],
          },
        },
      },
    ]
    // Only the missing readiness is filled; idempotency/postconditions stay.
    expect(autoCompleteReliability(nodes)).toBe(1)
    const spec = nodes[0]!.data!['__reliability'] as Record<string, unknown>
    expect(spec['idempotency']).toBe('unsafe')
    expect(spec['postconditions']).toEqual([{ kind: 'urlContains', value: '/done' }])
    expect(spec['readiness']).toBeDefined()
  })

  it('attaches a block-default readiness to a key element action', () => {
    const nodes: Array<{ data: Record<string, unknown> }> = [
      { data: { blockId: 'event-click', selector: '.go' } },
    ]
    expect(autoCompleteReliability(nodes)).toBe(1)
    const spec = nodes[0]!.data!['__reliability'] as Record<string, unknown>
    expect(spec['readiness']).toMatchObject({
      before: expect.arrayContaining([expect.objectContaining({ state: 'present' })]),
    })
    // A safe plain click gets no invented idempotency/postcondition.
    expect(spec['idempotency']).toBeUndefined()
    expect(spec['postconditions']).toBeUndefined()
  })

  it('does not attach readiness to blocks without a default', () => {
    const nodes: Array<{ data: Record<string, unknown> }> = [
      { data: { blockId: 'delay', time: 500 } },
    ]
    expect(autoCompleteReliability(nodes)).toBe(0)
  })

  it('fills both idempotency and postcondition when the model omits everything', () => {
    const nodes: Array<{ data: Record<string, unknown> }> = [{ data: { blockId: 'forms', action: 'submit', selector: '#pay' } }]
    expect(autoCompleteReliability(nodes)).toBe(1)
    expect(nodes[0]!.data!['__reliability']).toMatchObject({
      idempotency: 'unsafe',
      postconditions: [{ kind: 'elementExists', target: { stableAttributes: { 'data-css': '#pay' } } }],
    })
  })

  it('end-to-end: a model that writes NO contract still produces a validated workflow', async () => {
    const conversation = 'c-auto'
    await runOperatorTool({ name: 'wf_op_trigger', args: { goalText: '提交订单' }, conversationId: conversation })
    // Minimal submit node — no __reliability at all (the failure case the user hit).
    await runOperatorTool({
      name: 'wf_op_forms',
      args: { action: 'submit', selector: '#pay', type: 'text-field', value: '{{orderId}}' },
      conversationId: conversation,
    })
    const out = await composeWorkflowFromDraft(conversation, { save: false })
    if ('error' in out) throw new Error(`generation failed: ${out.error}`)
    // The workflow exists, passes the runnability check, and has a verifiable goal.
    expect(validateWorkflowForRun(out.workflow).errors).toEqual([])
    expect(goalSpecOf(out.workflow)?.successConditions.length).toBeGreaterThan(0)
  })

  it('end-to-end: key element actions carry readiness and generated-strict validation passes', async () => {
    const conversation = 'c-ready'
    await runOperatorTool({ name: 'wf_op_trigger', args: { goalText: '提交订单' }, conversationId: conversation })
    await runOperatorTool({
      name: 'wf_op_event-click',
      args: { selector: '.checkout' },
      conversationId: conversation,
    })
    await runOperatorTool({
      name: 'wf_op_forms',
      args: { action: 'submit', selector: '#pay', type: 'text-field', value: '{{orderId}}' },
      conversationId: conversation,
    })
    const out = await composeWorkflowFromDraft(conversation, { save: false })
    if ('error' in out) throw new Error(`generation failed: ${out.error}`)

    const reliability = out.workflow.drawflow.nodes
      .map((n): NodeReliabilitySpec | undefined =>
        (n.data?.['__reliability'] as NodeReliabilitySpec | undefined),
      )
      .filter((spec): spec is NodeReliabilitySpec => Boolean(spec))
    expect(reliability.some((spec) => spec.readiness)).toBe(true)
    const report = validateGeneratedWorkflow(out.workflow)
    expect(report.errors).toEqual([])
  })
})
