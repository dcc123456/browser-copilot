/**
 * The engine has to hand the run's VARIABLES to the readiness gates.
 *
 * A generated graph stores its readiness contract at generation time, with the
 * `{{token}}` still in it — the contract says "the value of `noteTitle` must be
 * in this control", and the fill that produces that value is resolved per run.
 * The unit-level gate resolves the template when it is given the variables; this
 * suite pins the wiring above it, because a gate that compares the literal text
 * `{{noteTitle}}` against the page fails a step that demonstrably worked, and
 * every test of the resolver alone stays green while that happens.
 */
import { describe, expect, it } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import type { ReadinessProbe } from '../src/background/workflow-engine/readiness-engine'
import type { ReadinessRequirement } from '../src/lib/workflow/readiness'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

const TITLE = '手搓脚本太累 3步搞定浏览器自动化'

function fillWorkflow(readiness: Record<string, ReadinessRequirement[]>): Workflow {
  const node: WorkflowNode = {
    id: 'a',
    label: 'forms',
    position: { x: 0, y: 0 },
    data: {
      blockId: 'forms',
      selector: '#title',
      params: { action: 'fill', value: TITLE },
      __reliability: { readiness },
    },
  }
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes: [node], edges: [] },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
      reliabilityMode: 'generated-strict',
    },
  }
}

/** A probe that records every requirement it is asked about and always agrees. */
function recordingProbe(seen: ReadinessRequirement[]): ReadinessProbe {
  return async (requirement) => {
    seen.push(requirement)
    return { satisfied: true }
  }
}

describe('readiness gates see the run variables', () => {
  const executor = { forms: async () => null }

  it('resolves a stored {{token}} in the post-action gate', async () => {
    const seen: ReadinessRequirement[] = []
    const result = await runWorkflow(
      fillWorkflow({ after: [{ state: 'value-committed', value: '{{noteTitle}}' }] }),
      {
        executors: executor,
        variables: { noteTitle: TITLE },
        readinessProbe: recordingProbe(seen),
      },
    )
    expect(result.outcome).toBe('ok')
    expect(seen.map((requirement) => requirement.value)).toEqual([TITLE])
  })

  it('resolves it in the pre-action gate too', async () => {
    const seen: ReadinessRequirement[] = []
    const result = await runWorkflow(
      fillWorkflow({ before: [{ state: 'value-committed', value: '{{noteTitle}}' }] }),
      {
        executors: executor,
        variables: { noteTitle: TITLE },
        readinessProbe: recordingProbe(seen),
      },
    )
    expect(result.outcome).toBe('ok')
    expect(seen.map((requirement) => requirement.value)).toEqual([TITLE])
  })

  it('never lets a token the run never produced reach the page', async () => {
    // The readiness resolver leaves an unknown `{{missing}}` as written — and
    // the engine's unresolved-input guard then stops the step. That is the right
    // order: a gate comparing the page against a literal template would report a
    // broken data flow as "the control did not commit its value", sending the
    // repair loop after the wrong thing.
    const seen: ReadinessRequirement[] = []
    const result = await runWorkflow(
      fillWorkflow({ after: [{ state: 'value-committed', value: '{{missing}}' }] }),
      {
        executors: executor,
        variables: { other: TITLE },
        readinessProbe: recordingProbe(seen),
      },
    )
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('UNRESOLVED_INPUT')
    expect(seen).toEqual([])
  })
})
