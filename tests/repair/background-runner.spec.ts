import { describe, expect, it } from 'vitest'
import {
  createBackgroundRunner,
  type ExecuteWorkflowCall,
} from '../../src/background/workflow-engine/repair/background-runner'
import { makeWorkflow, node } from './helpers'
import type { Workflow } from '../../src/lib/workflow/types'

function wf(): Workflow {
  return makeWorkflow([node('t', 'trigger'), node('n1', 'event-click', { selector: '#x' })], [])
}

interface Call {
  workflowId: string
  options: Record<string, unknown>
}

function callLog(): { calls: Call[]; executeWorkflow: ExecuteWorkflowCall } {
  const calls: Call[] = []
  const executeWorkflow: ExecuteWorkflowCall = async (workflow, options) => {
    calls.push({ workflowId: workflow.id, options: { ...options } })
    return { runId: 'run-1', outcome: 'ok' }
  }
  return { calls, executeWorkflow }
}

describe('createBackgroundRunner', () => {
  it('threads the replay subset (startAt + variables) through to executeWorkflow', async () => {
    const { calls, executeWorkflow } = callLog()
    const runner = createBackgroundRunner({ executeWorkflow })
    await runner.run(wf(), {
      startAt: 'n1',
      variables: { captcha: 'ok' },
      allowAiTakeover: false,
      entry: 'REPLAY',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.options).toMatchObject({
      source: 'manual',
      traceEntry: 'REPLAY',
      startAt: 'n1',
      variables: { captcha: 'ok' },
    })
  })

  it('omits startAt and variables when the caller did not pass them', async () => {
    const { calls, executeWorkflow } = callLog()
    const runner = createBackgroundRunner({ executeWorkflow })
    await runner.run(wf(), { allowAiTakeover: false, entry: 'VERIFY' })

    expect(calls[0]!.options).not.toHaveProperty('startAt')
    expect(calls[0]!.options).not.toHaveProperty('variables')
  })

  it('maps outcome, summary and error back to the runner outcome', async () => {
    const executeWorkflow: ExecuteWorkflowCall = async () => ({
      runId: 'run-2',
      outcome: 'failed',
      summary: 'click failed',
      error: 'TARGET_NOT_FOUND',
    })
    const runner = createBackgroundRunner({ executeWorkflow })
    const outcome = await runner.run(wf(), { allowAiTakeover: false, entry: 'REPLAY' })

    expect(outcome.outcome).toBe('failed')
    expect(outcome.summary).toBe('click failed')
    expect(outcome.error).toBe('TARGET_NOT_FOUND')
  })
})