// @vitest-environment jsdom
/**
 * The editor's repair chip must reflect the streamed session for the workflow
 * it has open — and only that workflow's session.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useRepairEvents } from '../src/workflow-editor/use-repair-events'
import type { EditorRepairStatus } from '../src/workflow-editor/use-repair-events'
import type { RepairProgressEvent } from '../src/lib/workflow/repair-events'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const listeners: ((message: unknown) => void)[] = []
const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(async () => ({})) }))
const sendCommand = mocks.sendCommand

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: {
    runtime: {
      onMessage: {
        addListener: (fn: (message: unknown) => void) => listeners.push(fn),
        removeListener: (fn: (message: unknown) => void) => {
          const index = listeners.indexOf(fn)
          if (index >= 0) listeners.splice(index, 1)
        },
      },
    },
  },
})

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

type HookResult = ReturnType<typeof useRepairEvents>

function mount(workflowId?: string): { status: EditorRepairStatus; cancel: () => void; unmount: () => void } {
  let latest: HookResult = { status: { state: 'idle' }, cancel: () => undefined }
  function Probe(): null {
    latest = useRepairEvents(workflowId)
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(createElement(Probe))
  })
  return {
    get status() {
      return latest.status
    },
    cancel: () => act(() => latest.cancel()),
    unmount: () => act(() => root.unmount()),
  }
}

const send = (event: RepairProgressEvent): void => {
  act(() => {
    for (const listener of [...listeners]) listener({ type: 'workflows.repairEvent', event })
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  listeners.length = 0
  sendCommand.mockClear()
})

describe('useRepairEvents (editor)', () => {
  it('tracks its own workflow from running to failed', () => {
    const handle = mount('wf-1')
    send({ type: 'repair.started', sessionId: 's1', workflowId: 'wf-1', runId: 'r1' })
    expect(handle.status.state).toBe('running')
    send({ type: 'repair.blocked', sessionId: 's1', reason: 'no model configured' })
    expect(handle.status.state).toBe('failed')
    expect(handle.status.reason).toBe('no model configured')
    handle.unmount()
  })

  it('ignores sessions of other workflows', () => {
    const handle = mount('wf-1')
    send({ type: 'repair.started', sessionId: 's9', workflowId: 'wf-other', runId: 'r9' })
    expect(handle.status.state).toBe('idle')
    send({ type: 'repair.blocked', sessionId: 's9', reason: 'not mine' })
    expect(handle.status.state).toBe('idle')
    handle.unmount()
  })

  it('reports success and can cancel the running session', () => {
    const handle = mount('wf-1')
    send({ type: 'repair.started', sessionId: 's1', workflowId: 'wf-1', runId: 'r1' })
    handle.cancel()
    expect(sendCommand).toHaveBeenCalledWith({ type: 'workflows.autoRepairCancel', id: 'wf-1' })
    send({ type: 'repair.success', sessionId: 's1', revision: 4 })
    expect(handle.status.state).toBe('success')
    handle.unmount()
  })
})
