/**
 * Workflow IR tests (计划 T01.1).
 *
 * Pins the IR vocabulary (semantic actions, steps, edges), the structural
 * validator for untrusted IR, and the minimal IR → Workflow compiler.
 * The compiler here proves the chain exists; full capability-driven compilation
 * (params, readiness, goal evidence) arrives in T02.5.
 */
import { describe, expect, it } from 'vitest'

import {
  IR_VERSION,
  compileIR,
  isWorkflowIR,
  normalizeIR,
  workflowIRFromJSON,
} from '../src/lib/workflow/ir'

import type { SemanticAction, WorkflowIR } from '../src/lib/workflow/ir'

function minimalIR(overrides: Partial<WorkflowIR> = {}): WorkflowIR {
  return {
    version: IR_VERSION,
    goal: { summary: 'Click the button' },
    inputs: [],
    steps: [
      {
        id: 's1',
        intent: 'Click the Go button',
        action: { kind: 'click' },
        target: { semantic: { role: 'button', accessibleName: 'Go' } },
        idempotency: 'safe',
        sourceTraceIds: [],
      },
    ],
    edges: [],
    metadata: { originUrl: 'https://shop.example/list' },
    ...overrides,
  }
}

describe('workflow intermediate representation', () => {
  it('exposes the current IR version', () => {
    expect(IR_VERSION).toBe(1)
  })

  it('accepts a well-formed IR through the structural validator', () => {
    expect(isWorkflowIR(minimalIR())).toBe(true)
  })

  it('rejects IR with a wrong version', () => {
    expect(isWorkflowIR(minimalIR({ version: 0 }))).toBe(false)
    expect(isWorkflowIR({ ...minimalIR(), version: 2 })).toBe(false)
  })

  it('rejects IR without a goal summary or any steps', () => {
    expect(isWorkflowIR(minimalIR({ goal: { summary: '' } }))).toBe(false)
    expect(isWorkflowIR(minimalIR({ steps: [] }))).toBe(false)
  })

  it('rejects IR with unknown actions or duplicate step ids', () => {
    const badAction = minimalIR({
      steps: [
        {
          id: 's1',
          intent: 'x',
          action: { kind: 'not-an-action' } as unknown as SemanticAction,
          idempotency: 'safe',
          sourceTraceIds: [],
        },
      ],
    })
    expect(isWorkflowIR(badAction)).toBe(false)

    const dupes = minimalIR({
      steps: [
        {
          id: 's1',
          intent: 'a',
          action: { kind: 'click' },
          idempotency: 'safe',
          sourceTraceIds: [],
        },
        {
          id: 's1',
          intent: 'b',
          action: { kind: 'click' },
          idempotency: 'safe',
          sourceTraceIds: [],
        },
      ],
    })
    expect(isWorkflowIR(dupes)).toBe(false)
  })

  it('rejects edges that reference missing steps', () => {
    expect(
      isWorkflowIR(
        minimalIR({
          edges: [{ id: 'e1', source: 's1', target: 'missing' }],
        }),
      ),
    ).toBe(false)
  })

  it('parses untrusted JSON into an IR or returns null', () => {
    expect(workflowIRFromJSON(JSON.stringify(minimalIR()))).not.toBeNull()
    expect(workflowIRFromJSON('{not json')).toBeNull()
    expect(workflowIRFromJSON('null')).toBeNull()
  })

  it('normalizes an IR by dropping unknown optional fields without changing semantics', () => {
    const ir = normalizeIR(minimalIR())
    expect(ir.steps).toHaveLength(1)
    expect(ir.steps[0]!.id).toBe('s1')
  })

  it('compiles an IR into a structurally valid workflow with a trigger head', () => {
    const workflow = compileIR(minimalIR())
    const ids = workflow.drawflow.nodes.map((n) => n.id)
    expect(ids).toContain('trigger')
    expect(ids).toContain('s1')
    // Linear edges connect the trigger to the only step.
    expect(workflow.drawflow.edges).toHaveLength(1)
    expect(workflow.drawflow.edges[0]!.source).toBe('trigger')
    expect(workflow.drawflow.edges[0]!.target).toBe('s1')
    // Block id carried by the compiled node comes from the semantic action.
    const node = workflow.drawflow.nodes.find((n) => n.id === 's1')!
    expect(node.data['blockId']).toBe('event-click')
    // Semantic identity survives compilation.
    expect(node.data['target']).toMatchObject({
      primary: { how: 'role', role: 'button', value: 'Go' },
    })
    // Provenance + origin travel with the generated workflow.
    expect(workflow.settings.provenance).toBe('chat-generate')
    expect(workflow.settings.generationOriginUrl).toBe('https://shop.example/list')
  })

  it('compiles multi-step IR in declared order with chained edges', () => {
    const ir = minimalIR({
      steps: [
        {
          id: 'a',
          intent: 'fill',
          action: { kind: 'fill' },
          target: { semantic: { role: 'textbox', accessibleName: 'Email' } },
          inputs: [{ ref: 'email' }],
          idempotency: 'conditional',
          sourceTraceIds: [],
        },
        {
          id: 'b',
          intent: 'submit',
          action: { kind: 'submit' },
          target: { semantic: { role: 'button', accessibleName: 'Submit' } },
          idempotency: 'unsafe',
          sourceTraceIds: [],
        },
      ],
    })
    const workflow = compileIR(ir)
    const order = workflow.drawflow.nodes.map((n) => n.id)
    expect(order).toEqual(['trigger', 'a', 'b'])
    const edgePairs = workflow.drawflow.edges.map((e) => [e.source, e.target])
    expect(edgePairs).toEqual([
      ['trigger', 'a'],
      ['a', 'b'],
    ])
    const submit = workflow.drawflow.nodes.find((n) => n.id === 'b')!
    expect(submit.data['blockId']).toBe('forms')
  })
})
