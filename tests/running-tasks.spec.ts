import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetRunningForTests,
  addStep,
  cancelRun,
  finishRun,
  getRun,
  listFinished,
  listRunning,
  setRunWindow,
  startRun,
} from '../src/background/running-tasks'

afterEach(() => _resetRunningForTests())

describe('running-tasks registry', () => {
  it('tracks a run, records steps, and moves it to finished on finish', () => {
    const run = startRun({ label: 'do thing', source: 'feishu', feishuChatId: 'oc_1' })
    expect(run.runId).toBeTruthy()
    addStep(run.runId, 'tool', '→ open_tab')
    addStep(run.runId, 'result', '← done')
    const listed = listRunning()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.steps).toHaveLength(2)
    expect(listed[0]!.feishuChatId).toBe('oc_1')
    finishRun(run.runId, { outcome: 'ok', summary: 'done' })
    expect(listRunning()).toHaveLength(0)
    const done = listFinished()
    expect(done).toHaveLength(1)
    expect(done[0]!.outcome).toBe('ok')
    expect(done[0]!.summary).toBe('done')
    expect(done[0]!.steps).toHaveLength(2)
  })

  it('infers cancelled outcome from an aborted controller when none given', () => {
    const run = startRun({ label: 'x', source: 'chat' })
    run.controller.abort()
    finishRun(run.runId)
    expect(listFinished()[0]!.outcome).toBe('cancelled')
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

  it('carries the run window onto the finished entry for the board badge', () => {
    const run = startRun({ label: 'x', source: 'schedule' })
    expect(getRun(run.runId)?.windowId).toBeUndefined()
    expect(listFinished()[0]?.runWindowKind).toBeUndefined()

    setRunWindow(run.runId, 500, 'dedicated')
    expect(getRun(run.runId)).toMatchObject({ windowId: 500, runWindowKind: 'dedicated' })

    finishRun(run.runId, { outcome: 'ok', summary: 'done' })
    expect(listFinished()[0]).toMatchObject({ windowId: 500, runWindowKind: 'dedicated' })
  })

  it('ignores a window recorded for an unknown or finished run', () => {
    setRunWindow('nope', 500, 'shared')
    const run = startRun({ label: 'x', source: 'schedule' })
    setRunWindow(run.runId, 501, 'shared')
    finishRun(run.runId, { outcome: 'ok' })
    setRunWindow(run.runId, 502, 'dedicated')
    expect(listFinished()[0]).toMatchObject({ windowId: 501, runWindowKind: 'shared' })
  })
})
