/** Page-side routing of prompt broadcasts to the run this page started. */
import { afterEach, describe, expect, it } from 'vitest'
import {
  beginRunInputSession,
  endRunInputSession,
  isOwnRunInput,
} from '../src/ui/run-input-session'
import type { RunInputRequest } from '../src/lib/workflow/run-input'

function request(promptToken: string): RunInputRequest {
  return {
    requestId: 'req-1',
    promptToken,
    runId: 'run-1',
    workflowId: 'wf-1',
    workflowName: 'Demo',
    fields: [],
    timeoutMs: 1000,
    at: Date.now(),
  }
}

describe('run-input session routing', () => {
  afterEach(() => {
    // Leave module state clean for the next test.
    const token = beginRunInputSession()
    endRunInputSession(token)
  })

  it('claims only the prompts tagged with this page’s token', () => {
    const token = beginRunInputSession()
    expect(isOwnRunInput(request(token))).toBe(true)
    expect(isOwnRunInput(request('someone-else'))).toBe(false)
  })

  it('claims nothing before a run starts or after it ends', () => {
    const token = beginRunInputSession()
    endRunInputSession(token)
    expect(isOwnRunInput(request(token))).toBe(false)
  })

  it('a stale end call does not clear a newer run', () => {
    const first = beginRunInputSession()
    const second = beginRunInputSession()
    endRunInputSession(first)
    expect(isOwnRunInput(request(second))).toBe(true)
  })
})
