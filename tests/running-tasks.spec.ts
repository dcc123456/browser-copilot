import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetRunningForTests,
  addStep,
  cancelRun,
  finishRun,
  getRun,
  listRunning,
  startRun,
} from '../src/background/running-tasks'

afterEach(() => _resetRunningForTests())

describe('running-tasks registry', () => {
  it('tracks a run, records steps, and removes it on finish', () => {
    const run = startRun({ label: 'do thing', source: 'feishu', feishuChatId: 'oc_1' })
    expect(run.runId).toBeTruthy()
    addStep(run.runId, 'tool', '→ open_tab')
    addStep(run.runId, 'result', '← done')
    const listed = listRunning()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.steps).toHaveLength(2)
    expect(listed[0]!.feishuChatId).toBe('oc_1')
    finishRun(run.runId)
    expect(listRunning()).toHaveLength(0)
  })

  it('cancels a run via its abort signal', () => {
    const run = startRun({ label: 'x', source: 'chat' })
    expect(run.controller.signal.aborted).toBe(false)
    expect(cancelRun(run.runId)).toBe(true)
    expect(run.controller.signal.aborted).toBe(true)
  })

  it('cancel returns false for an unknown run', () => {
    expect(cancelRun('nope')).toBe(false)
  })

  it('addStep is a no-op after finish', () => {
    const run = startRun({ label: 'x', source: 'manual' })
    finishRun(run.runId)
    addStep(run.runId, 'status', 'late')
    expect(getRun(run.runId)).toBeUndefined()
  })

  it('uses an externally provided controller', () => {
    const controller = new AbortController()
    const run = startRun({ label: 'x', source: 'chat', controller })
    expect(run.controller).toBe(controller)
  })
})
