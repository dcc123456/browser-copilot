import { describe, expect, it } from 'vitest'
import { checkWorkflowIntegrity, integrityIsClean } from '../src/lib/workflow/integrity'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

/**
 * The save-time integrity pass. The user's requirement is "the saved workflow
 * must be runnable — no node lost, no variable lost", and this is the half that
 * page inspection cannot see: a node nothing points at, and a `{{reference}}`
 * nothing can produce.
 *
 * The bar for putting a red line on the card is high, so the tests below pin
 * both directions: it must catch the two real failure shapes, and it must NOT
 * cry wolf on the graphs that run perfectly well (engine-provided aliases,
 * property access, trigger-held literals).
 */

function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

const trigger = (
  id = 't',
  parameters?: { name: string; defaultValue: string }[],
): WorkflowNode => ({
  id,
  label: 'trigger',
  position: { x: 0, y: 0 },
  data: {
    blockId: 'trigger',
    type: 'manual',
    ...(parameters ? { parameters: parameters.map((p) => ({ ...p, type: 'string' })) } : {}),
  },
})

const node = (id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label: blockId,
  position: { x: 0, y: 0 },
  data: { blockId, ...data },
})

const edge = (source: string, target: string): WorkflowEdge => ({
  id: `${source}->${target}`,
  source,
  target,
})

describe('checkWorkflowIntegrity — dangling references', () => {
  it('flags a reference nothing in the graph can produce', () => {
    const wf = workflow([trigger(), node('a', 'forms', { selector: '#q', value: '{{keyword}}' })])
    const integrity = checkWorkflowIntegrity(wf)

    expect(integrity.danglingVars).toEqual([
      { nodeId: 'a', blockId: 'forms', param: 'value', reference: 'keyword' },
    ])
    expect(integrityIsClean(integrity)).toBe(false)
  })

  it('accepts a reference the trigger declares as an input', () => {
    // This is the normal shape of a generated workflow: the observed literal
    // lives in the trigger's `defaultValue`, so the graph runs out of the box
    // and stays editable.
    const wf = workflow(
      [
        trigger('t', [{ name: 'keyword', defaultValue: 'iPhone' }]),
        node('a', 'forms', { selector: '#q', value: '{{keyword}}' }),
      ],
      [edge('t', 'a')],
    )
    expect(checkWorkflowIntegrity(wf).danglingVars).toEqual([])
  })

  it('accepts a reference the trigger declares on its top-level mirror only', () => {
    // The trigger's state is duplicated (node vs `workflow.trigger`), and both
    // are legitimate places to find the declaration.
    const wf = workflow([trigger(), node('a', 'forms', { value: '{{keyword}}' })])
    wf.trigger = {
      type: 'manual',
      parameters: [{ name: 'keyword', type: 'string', defaultValue: 'iPhone' }],
    }
    expect(checkWorkflowIntegrity(wf).danglingVars).toEqual([])
  })

  it('accepts a reference an upstream block produces via variableName', () => {
    const wf = workflow(
      [
        trigger(),
        node('read', 'get-text', { selector: '.title', variableName: 'lastTitle' }),
        node('write', 'save-local', { value: '{{lastTitle}}', filename: 't.txt' }),
      ],
      [edge('t', 'read'), edge('read', 'write')],
    )
    expect(checkWorkflowIntegrity(wf).danglingVars).toEqual([])
  })

  it('accepts the engine-provided aliases that have no producing node', () => {
    // Written by the executors as fixed aliases (`refData`, `dataTable`, …), so
    // a producer search alone would report them missing on graphs that run.
    const wf = workflow([
      trigger(),
      node('a', 'export-data', { filename: '{{dataTable}}.csv', value: '{{refData}}' }),
      node('b', 'log-data', { value: '{{lastText}} {{loopIndex}}' }),
    ])
    expect(checkWorkflowIntegrity(wf).danglingVars).toEqual([])
  })

  it('compares only the root of a dotted path', () => {
    // `{{formsValue.foo}}` reads a property, so `formsValue` is what must exist;
    // comparing whole paths would flag every property access.
    const wf = workflow([
      trigger(),
      node('read', 'forms', { selector: '#x', getValue: true, variableName: 'formsValue' }),
      node('use', 'save-local', { value: '{{formsValue.foo}}' }),
    ])
    expect(checkWorkflowIntegrity(wf).danglingVars).toEqual([])
  })

  it('reports each dangling reference with the param that carries it', () => {
    const wf = workflow([
      trigger(),
      node('a', 'forms', {
        selector: '#q',
        value: '{{missing}}',
        params: { nested: '{{alsoMissing}}' },
      }),
    ])
    const found = checkWorkflowIntegrity(wf).danglingVars.map((d) => `${d.param}=${d.reference}`)
    expect(found.sort()).toEqual(['params.nested=alsoMissing', 'value=missing'])
  })

  it('never inspects the trigger’s own default values', () => {
    // The declaration site holds the literal captured during generation, which
    // may itself look like a reference the user typed. Reporting it would blame
    // the one place that is correct.
    const wf = workflow([trigger('t', [{ name: 'a', defaultValue: '{{notAProducer}}' }])], [])
    expect(checkWorkflowIntegrity(wf).danglingVars).toEqual([])
  })
})

describe('checkWorkflowIntegrity — structure', () => {
  it('flags a node with no incoming edge', () => {
    const wf = workflow(
      [trigger(), node('a', 'event-click', { selector: '#a' }), node('b', 'event-click', {})],
      [edge('t', 'a')],
    )
    const integrity = checkWorkflowIntegrity(wf)
    expect(integrity.orphanNodes).toEqual(['b'])
    expect(integrity.unreachable).toEqual(['b'])
  })

  it('flags a cluster the trigger cannot reach even when it has edges', () => {
    // Not an orphan (it has an incoming edge) but still unreachable — the shape
    // a bad merge leaves behind.
    const wf = workflow(
      [trigger(), node('a', 'event-click', {}), node('b', 'event-click', {})],
      [edge('t', 'a'), edge('b', 'a')],
    )
    const integrity = checkWorkflowIntegrity(wf)
    expect(integrity.orphanNodes).toEqual(['b'])
    expect(integrity.unreachable).toEqual(['b'])
  })

  it('accepts a clean linear chain', () => {
    const wf = workflow(
      [
        trigger(),
        node('a', 'new-tab', { url: 'https://x.test' }),
        node('b', 'event-click', { selector: '#go' }),
      ],
      [edge('t', 'a'), edge('a', 'b')],
    )
    const integrity = checkWorkflowIntegrity(wf)
    expect(integrityIsClean(integrity)).toBe(true)
  })

  it('reports every node as unreachable when there is no trigger head', () => {
    // Never throws: the card still has to render, and "no entry point" is a
    // fact worth showing rather than an exception.
    const wf = workflow([node('a', 'event-click', {}), node('b', 'event-click', {})])
    const integrity = checkWorkflowIntegrity(wf)
    expect(integrity.unreachable).toEqual(['a', 'b'])
  })

  it('does not treat a branching graph as unreachable', () => {
    const wf = workflow(
      [
        trigger(),
        node('cond', 'element-exists', { selector: '#x' }),
        node('yes', 'event-click', {}),
        node('no', 'event-click', {}),
      ],
      [edge('t', 'cond'), edge('cond', 'yes'), edge('cond', 'no')],
    )
    expect(integrityIsClean(checkWorkflowIntegrity(wf))).toBe(true)
  })

  it('survives a cycle without hanging', () => {
    const wf = workflow(
      [trigger(), node('a', 'event-click', {}), node('b', 'event-click', {})],
      [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')],
    )
    expect(integrityIsClean(checkWorkflowIntegrity(wf))).toBe(true)
  })
})
