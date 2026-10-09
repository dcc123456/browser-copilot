/**
 * The background adapter owns the last word on a repair session: whatever
 * happens — even an unexpected throw out of the orchestrator — the panel must
 * receive a terminal event and the active-repair registry must be released.
 * Otherwise the dialog spins forever and every later repair for the same
 * workflow is refused as "already running".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/background/workflow-engine/auto-repair/orchestrator', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/background/workflow-engine/auto-repair/orchestrator')
    >()
  return { ...actual, runAutoRepair: vi.fn() }
})

import {
  autoRepairRunning,
  cancelAutoRepair,
  startBackgroundAutoRepair,
} from '../src/background/workflow-engine/auto-repair/background-adapter'
import { runAutoRepair } from '../src/background/workflow-engine/auto-repair/orchestrator'
import type { RepairProgressEvent } from '../src/lib/workflow/repair-events'
import type { Workflow } from '../src/lib/workflow/types'

const workflow = {
  id: 'wf-1',
  name: 'wf',
  nodes: [],
  edges: [],
  settings: {},
} as unknown as Workflow

const forward = vi.fn()

const start = (): Promise<unknown> =>
  startBackgroundAutoRepair({
    workflow,
    runId: 'r1',
    failure: {} as never,
    save: {
      saveWorkflow: vi.fn(async () => undefined),
      getWorkflow: vi.fn(async () => undefined),
    },
    forward,
  })

beforeEach(() => {
  forward.mockReset()
  vi.mocked(runAutoRepair).mockReset()
})

const forwardedTypes = (): RepairProgressEvent['type'][] =>
  forward.mock.calls.map((call) => (call[0] as RepairProgressEvent).type)

type Emit = (event: RepairProgressEvent) => void
const emitOf = (args: unknown): Emit => (args as { deps: { emit: Emit } }).deps.emit

type RunResult = Awaited<ReturnType<typeof runAutoRepair>>
/** A session result the adapter only reads `final` from. */
const finished = (final: unknown): RunResult => ({ final }) as unknown as RunResult

describe('startBackgroundAutoRepair · settle guarantees', () => {
  it('broadcasts a terminal event and frees the registry on an unexpected error', async () => {
    vi.mocked(runAutoRepair).mockImplementation(async (args) => {
      emitOf(args)({ type: 'repair.started', sessionId: 's1', workflowId: 'wf-1', runId: 'r1' })
      throw new Error('model replied with garbage')
    })

    const outcome = (await start()) as { status: string; reason?: string }

    expect(outcome.status).toBe('blocked')
    expect(outcome.reason).toBe('model replied with garbage')
    expect(forwardedTypes()).toContain('repair.blocked')
    expect(autoRepairRunning('wf-1')).toBe(false)
  })

  it('lets a later repair start after such a failure', async () => {
    vi.mocked(runAutoRepair)
      .mockImplementationOnce(async (args) => {
        emitOf(args)({ type: 'repair.started', sessionId: 's1', workflowId: 'wf-1', runId: 'r1' })
        throw new Error('boom')
      })
      .mockImplementationOnce(async (args) => {
        emitOf(args)({ type: 'repair.started', sessionId: 's2', workflowId: 'wf-1', runId: 'r2' })
        emitOf(args)({ type: 'repair.success', sessionId: 's2', revision: 3 })
        return finished({ status: 'success', attempts: 1, durationMs: 5, committed: true })
      })

    await start()
    const second = (await start()) as { status: string; committed: boolean }

    expect(second.status).toBe('success')
    expect(second.committed).toBe(true)
    expect(forwardedTypes()).toContain('repair.success')
  })

  it('still cancels an in-flight repair', async () => {
    let resolveRun: ((value: RunResult) => void) | undefined
    vi.mocked(runAutoRepair).mockImplementation(
      (args) =>
        new Promise<RunResult>((resolve) => {
          emitOf(args)({ type: 'repair.started', sessionId: 's1', workflowId: 'wf-1', runId: 'r1' })
          resolveRun = resolve
        }),
    )

    const running = start()
    await Promise.resolve()
    expect(autoRepairRunning('wf-1')).toBe(true)
    expect(cancelAutoRepair('wf-1')).toBe(true)

    resolveRun?.(finished({ status: 'blocked', attempts: 0, durationMs: 1, committed: false }))
    const outcome = (await running) as { status: string }
    expect(outcome.status).toBe('blocked')
    expect(autoRepairRunning('wf-1')).toBe(false)
  })
})
