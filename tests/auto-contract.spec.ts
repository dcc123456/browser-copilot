import { describe, expect, it } from 'vitest'
import {
  autoCompleteReliability,
  inferIdempotency,
} from '../src/lib/workflow/auto-contract'
import { runOperatorTool, composeWorkflowFromDraft } from '../src/background/operator-tool-handler'
import { goalSpecOf } from '../src/lib/workflow/reliability'
import { validateWorkflowForRun } from '../src/lib/workflow/validation'

describe('auto reliability completion (generation must always succeed)', () => {
  it('infers idempotency from the action semantics', () => {
    expect(inferIdempotency('forms', { action: 'submit' })).toBe('unsafe')
    expect(inferIdempotency('forms', {})).toBe('unsafe')
    expect(inferIdempotency('event-click', {})).toBe('safe')
    expect(inferIdempotency('webhook', {})).toBe('unsafe')
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
    expect(autoCompleteReliability(nodes)).toBe(0)
    expect(nodes[0]!.data!['__reliability']).toEqual({
      idempotency: 'unsafe',
      postconditions: [{ kind: 'urlContains', value: '/done' }],
    })
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
})
