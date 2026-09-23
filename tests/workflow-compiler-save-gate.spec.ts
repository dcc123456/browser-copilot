import { describe, expect, it } from 'vitest'
import {
  attachGoalSpec,
  recordActionFinished,
  recordActionStarted,
  startGenerationSession,
  transitionGeneration,
} from '../src/lib/workflow/generation-session'
import { compileWorkflowFromTrace } from '../src/lib/workflow/workflow-compiler'
import { validateGeneratedWorkflowForSave } from '../src/lib/workflow/save-gate'
import type { Workflow } from '../src/lib/workflow/types'

/** Build a generation session with N successful open-url/click traces. */
function sessionWithActions(count: number) {
  let { session } = transitionGeneration(
    startGenerationSession({
      conversationId: 'c1',
      userGoal: 'open dashboard and verify',
      id: 'g1',
      originUrl: 'https://example.com/',
      startedAt: 100,
    }).session,
    'understanding',
  )
  session = attachGoalSpec(session, {
    summary: 'dashboard visible',
    successConditions: [{ kind: 'urlContains', value: 'example.com' }],
  })
  session = transitionGeneration(session, 'executing').session

  for (let index = 0; index < count; index += 1) {
    session = recordActionStarted(session, {
      blockId: index === 0 ? 'open-url' : 'wait',
      intent: index === 0 ? 'open the dashboard' : 'wait for the panel',
      params: index === 0 ? { url: 'https://example.com/' } : {},
      at: 200 + index * 10,
    }).session
    session = recordActionFinished(session, {
      passed: true,
      nodeId: `n-gen-${index}`,
      ...(index === count - 1
        ? { verification: { kind: 'goal', passed: true } }
        : {}),
      at: 210 + index * 10,
    }).session
  }
  return session
}

describe('workflow compiler', () => {
  it('compiles successful traces into a generated-strict workflow', () => {
    const session = sessionWithActions(2)
    const result = compileWorkflowFromTrace({
      session,
      name: 'Dashboard',
      workflowId: 'wf-new',
      at: 500,
    })
    const workflow: Workflow = result.workflow
    expect(workflow.id).toBe('wf-new')
    expect(workflow.name).toBe('Dashboard')
    // trigger + two actions.
    expect(workflow.drawflow.nodes).toHaveLength(3)
    expect(workflow.drawflow.edges).toHaveLength(2)
    expect(workflow.settings.reliabilityMode).toBe('generated-strict')
    expect(workflow.settings.provenance).toBe('chat-generate')
    expect(workflow.settings.generationOriginUrl).toBe('https://example.com/')
    expect(workflow.settings.goalSpec).toBeDefined()
    expect(result.excludedFailures).toBe(0)
  })

  it('refuses to compile an empty session', () => {
    const { session } = transitionGeneration(
      startGenerationSession({ conversationId: 'c', userGoal: 'x' }).session,
      'understanding',
    )
    const executing = transitionGeneration(session, 'executing').session
    expect(() => compileWorkflowFromTrace({ session: executing })).toThrow()
  })

  it('excludes failed actions from the compiled graph', () => {
    let session = sessionWithActions(1)
    // One extra failed action.
    session = recordActionStarted(session, {
      blockId: 'click',
      intent: 'click missing thing',
    }).session
    session = recordActionFinished(session, { passed: false }).session

    const result = compileWorkflowFromTrace({ session, at: 900 })
    expect(result.excludedFailures).toBe(1)
    expect(result.workflow.drawflow.nodes).toHaveLength(2)
  })
})

describe('save gate', () => {
  it('passes a well-formed compiled workflow', async () => {
    const session = sessionWithActions(1)
    const { workflow } = compileWorkflowFromTrace({ session, at: 600 })
    const result = await validateGeneratedWorkflowForSave({ workflow })
    // Goal must be present and satisfied through graph validity; goal
    // conditions evaluate structurally here (no live probe).
    const goalBlockers = result.blockers.filter((issue) => issue.code.startsWith('GOAL'))
    expect(goalBlockers).toEqual([])
    expect(result.blockers).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('blocks a strict workflow without a goal spec', async () => {
    // Compile then strip the goal.
    let session = transitionGeneration(
      startGenerationSession({ conversationId: 'c', userGoal: 'do thing' }).session,
      'understanding',
    ).session
    session = transitionGeneration(session, 'executing').session
    session = recordActionStarted(session, {
      blockId: 'wait',
      intent: 'wait a second',
    }).session
    session = recordActionFinished(session, {
      passed: true,
      nodeId: 'n-gen-x',
    }).session
    const { workflow } = compileWorkflowFromTrace({ session })
    // Remove goal that compiler may not have (none attached).
    const result = await validateGeneratedWorkflowForSave({ workflow })
    expect(result.blockers.some((issue) => issue.code === 'GOAL_MISSING')).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('hardens via the supplied probe', async () => {
    const session = sessionWithActions(1)
    const { workflow } = compileWorkflowFromTrace({ session, name: 'Dashboard', at: 700 })
    const result = await validateGeneratedWorkflowForSave({
      workflow,
      probe: {
        harden: async (input) => ({
          workflow: { ...input, name: `${input.name} [hardened]` },
        }),
      },
    })
    expect(result.hardenedWorkflow.name).toBe('Dashboard [hardened]')
  })
})
