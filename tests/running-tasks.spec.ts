import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetRunningForTests,
  addStep,
  cancelRun,
  finishRun,
  getRun,
  listFinished,
  listRunning,
  recordSnapshot,
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

/**
 * Debug mode hands the registry the whole variable bag after every block. The
 * board is polled by the editor every 800 ms, so anything kept here is both
 * retained and re-cloned continuously — the shape that exhausted the renderer.
 */
describe('run board memory bounds', () => {
  it('attaches bounded variables to the block step instead of a second snapshot array', () => {
    const run = startRun({ label: 'x', source: 'manual' })
    addStep(run.runId, 'tool', 'cover', { nodeId: 'n1', label: 'cover' })
    const image = `data:image/png;base64,${'A'.repeat(9000)}`
    recordSnapshot(run.runId, 'n1', { cover: image, note: 'ok', body: 'B'.repeat(9000) })

    const tracked = getRun(run.runId)!
    const step = tracked.steps[0]!
    expect(step.vars?.cover).toBe(`[data URL dropped: ${image.length} chars]`)
    expect(step.vars?.note).toBe('ok')
    expect(String(step.vars?.body)).toContain('9000 chars, truncated')
    expect(tracked).not.toHaveProperty('snapshots')
  })

  it('omits a variable that alone exceeds the block budget', () => {
    const run = startRun({ label: 'x', source: 'manual' })
    addStep(run.runId, 'tool', 'rows', { nodeId: 'n1' })
    recordSnapshot(run.runId, 'n1', { rows: new Array(50_000).fill(1), kept: 'yes' })

    const vars = getRun(run.runId)!.steps[0]!.vars!
    expect(vars.kept).toBe('yes')
    expect(String(vars.rows)).toContain('value omitted from the run log')
  })

  it('caps a long step line and keeps only the newest steps', () => {
    const run = startRun({ label: 'x', source: 'manual' })
    addStep(run.runId, 'result', 'x'.repeat(9000))
    const long = getRun(run.runId)!.steps[0]!
    expect(long.text).toContain('9000 chars, truncated')
    expect(long.text.length).toBeLessThan(1000)

    for (let index = 0; index < 600; index += 1) addStep(run.runId, 'status', `line ${index}`)
    const steps = getRun(run.runId)!.steps
    expect(steps).toHaveLength(500)
    expect(steps[steps.length - 1]!.text).toBe('line 599')
  })

  it('keeps debug variables only on the newest finished runs', () => {
    for (let index = 0; index < 4; index += 1) {
      const run = startRun({ label: `run ${index}`, source: 'manual' })
      addStep(run.runId, 'tool', 'block', { nodeId: 'n1' })
      recordSnapshot(run.runId, 'n1', { value: index })
      finishRun(run.runId, { outcome: 'ok' })
    }
    expect(listFinished().map((run) => run.steps[0]?.vars)).toEqual([
      { value: 3 },
      { value: 2 },
      { value: 1 },
      undefined,
    ])
  })

  it('caps the summary and error text on a finished run', () => {
    const run = startRun({ label: 'x', source: 'manual' })
    finishRun(run.runId, {
      outcome: 'failed',
      summary: 's'.repeat(50),
      error: 'e'.repeat(20_000),
    })
    const done = listFinished()[0]!
    expect(done.summary).toBe('s'.repeat(50))
    expect(done.error!.length).toBeLessThan(1000)
    expect(done.error).toContain('20000 chars, truncated')
  })
})
