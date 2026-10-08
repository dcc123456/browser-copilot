/**
 * An `{{token}}` nobody answered for must fail the NODE, not the page.
 *
 * Generation replaces business literals with `{{references}}`. When the graph
 * never produces that value and the trigger default is missing, the run used to
 * type the literal braces into the search box: the step "succeeded", the search
 * was for `{{keyword}}`, and every later step inherited the wrong page. These
 * tests pin the two halves of the fix — the interpolation pass reports what it
 * could not resolve, and a page-acting node turns that report into one
 * node-scoped `UNRESOLVED_INPUT` failure while everything else keeps running.
 */
import { describe, expect, it } from 'vitest'
import {
  interpolateParams,
  EMPTY_INTERP_KEY,
  UNRESOLVED_INTERP_KEY,
} from '../src/lib/workflow/interpolate'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

const node = (id: string, label: string, data: Record<string, unknown>): WorkflowNode => ({
  id,
  label,
  position: { x: 0, y: 0 },
  data: { blockId: label, ...data },
})

describe('interpolateParams unresolved-token report', () => {
  it('names a token that no variable answered for', () => {
    const out = interpolateParams({ selector: '.x', value: '{{keyword}}' }, {})
    expect(out[UNRESOLVED_INTERP_KEY]).toEqual(['keyword'])
  })

  it('catches a hole in the middle of a longer value, and inside nested params', () => {
    const out = interpolateParams(
      { selector: '{{root}} .price', conditions: [{ right: '{{loopIndex}}' }] },
      { root: 'a' },
    )
    expect(out['selector']).toBe('a .price')
    expect(out[UNRESOLVED_INTERP_KEY]).toEqual(['loopIndex'])
  })

  it('reports each token once', () => {
    const out = interpolateParams({ a: '{{x}}', b: '{{x}} and {{x}}' }, {})
    expect(out[UNRESOLVED_INTERP_KEY]).toEqual(['x'])
  })

  it('says nothing when every token resolved — including one that resolved to empty', () => {
    const resolved = interpolateParams({ value: '{{x}}' }, { x: 'v' })
    expect(resolved[UNRESOLVED_INTERP_KEY]).toBeUndefined()
    expect(resolved).toBe(resolved)

    // An empty answer is a different diagnosis (the variable exists and is
    // blank) and belongs to EMPTY_INTERP_KEY, not this one.
    const blank = interpolateParams({ value: '{{x}}' }, { x: '   ' })
    expect(blank[UNRESOLVED_INTERP_KEY]).toBeUndefined()
    expect(blank[EMPTY_INTERP_KEY]).toEqual(['value'])
  })

  it('returns the caller object untouched when there is nothing to report', () => {
    const data = { value: 'plain' }
    expect(interpolateParams(data, {})).toBe(data)
  })
})

describe('engine UNRESOLVED_INPUT gate', () => {
  it('fails the page-acting node with the missing token, without touching the page', async () => {
    let reachedThePage = false
    const result = await runWorkflow(
      makeWorkflow([node('a', 'forms', { selector: '#q', value: '{{keyword}}' })]),
      {
        executors: {
          forms: async () => {
            reachedThePage = true
            return null
          },
        },
      },
    )
    expect(reachedThePage).toBe(false)
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('UNRESOLVED_INPUT')
    expect(result.error).toContain('keyword')
  })

  it('does not fire when the run scope carries the value', async () => {
    // This is the normal generated case: the recorder declared `keyword` as an
    // input with the observed literal as its default, and `seedFromTrigger`
    // (run-workflow) puts that default in the scope before the first node.
    const result = await runWorkflow(
      makeWorkflow([node('a', 'forms', { selector: '#q', value: '{{keyword}}' })]),
      {
        variables: { keyword: 'harness' },
        executors: {
          forms: async (params) => {
            expect(params['value']).toBe('harness')
            return null
          },
        },
      },
    )
    expect(result.outcome).toBe('ok')
  })

  it('leaves a non-page node that quotes a missing variable alone', async () => {
    // `set-variable` is where generated glue reads like `{{a}}{{b}}`; failing it
    // would lower the success rate without protecting the page from anything.
    const result = await runWorkflow(
      makeWorkflow([node('a', 'set-variable', { name: 'x', value: '{{keyword}}' })]),
      {
        executors: {
          'set-variable': async (params) => {
            expect(params['value']).toBe('{{keyword}}')
            return null
          },
        },
      },
    )
    expect(result.outcome).toBe('ok')
  })

  it('is an ordinary node failure: onError continue flows past it', async () => {
    // The hole is in ONE node. A graph that declares the step recoverable must
    // keep going — this must never become a run-level veto.
    const first: WorkflowNode = {
      id: 'a',
      label: 'forms',
      position: { x: 0, y: 0 },
      data: {
        blockId: 'forms',
        selector: '#q',
        value: '{{keyword}}',
        onError: { enable: true, toDo: 'continue' },
      },
    }
    const second = node('b', 'event-click', {})
    let laterRan = false
    const result = await runWorkflow(
      makeWorkflow([first, second], [{ id: 'e1', source: 'a', target: 'b' }]),
      {
        executors: {
          forms: async () => {
            throw new Error('executor must not run')
          },
          'event-click': async () => {
            laterRan = true
            return null
          },
        },
      },
    )
    expect(laterRan).toBe(true)
    expect(result.steps?.some((line) => line.text.includes('UNRESOLVED_INPUT'))).toBe(true)
  })
})
