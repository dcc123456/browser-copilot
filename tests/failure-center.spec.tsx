// @vitest-environment jsdom
/**
 * Failure Center component test: drives the single-entry recovery flow over a
 * mocked command channel. Pins the two-confirmation contract:
 *
 * 1. opening the dialog sends exactly one START; diagnose → proposal run with
 *    no user choice and the dialog pauses at AWAIT_REPAIR_CONFIRM;
 * 2. Confirm repair sends CONFIRM_REPAIR, then pauses at
 *    AWAIT_OVERWRITE_CONFIRM; the formal workflow is not committed yet;
 * 3. Overwrite sends CONFIRM_OVERWRITE and completes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { sendCommandMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
}))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: sendCommandMock }
})

import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FailureCenterDialog } from '../src/sidepanel/FailureCenter'

function recoveryResult(phase: string, status: string, summary: string, requestId: string) {
  return {
    type: 'workflows.recovery',
    requestId,
    phase,
    status,
    summary,
    timestamp: Date.now(),
  }
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const buttonTexts = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '')

const clickButton = async (container: HTMLElement, label: string): Promise<void> => {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  expect(button, `missing button ${label}`).toBeDefined()
  await act(async () => {
    ;(button as HTMLButtonElement).click()
  })
  await flush()
}

describe('FailureCenter single-entry AI repair', () => {
  let container: HTMLElement
  let root: Root

  beforeAll(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    sendCommandMock.mockReset()
    act(() => root?.unmount())
  })

  const mount = async (): Promise<void> => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(FailureCenterDialog, {
          runId: 'run1',
          workflowId: 'wf1',
          onClose: () => {},
        }),
      )
    })
    await flush()
  }

  it('sends START on open and pauses at repair confirmation', async () => {
    sendCommandMock.mockImplementationOnce(async (command: { requestId: string }) =>
      recoveryResult('AWAIT_REPAIR_CONFIRM', 'waiting', 'proposal ready', command.requestId),
    )
    await mount()

    expect(sendCommandMock).toHaveBeenCalledTimes(1)
    expect(sendCommandMock.mock.calls[0]![0]).toMatchObject({
      type: 'workflows.recovery',
      action: 'START',
      workflowId: 'wf1',
      runId: 'run1',
    })
    expect(container.textContent).toContain('AWAIT_REPAIR_CONFIRM')
    expect(container.textContent).toContain('proposal ready')
    expect(buttonTexts(container)).toContain('Confirm repair')
  })

  it('pauses at overwrite after confirm-repair, without committing', async () => {
    const captured = { requestId: '' }
    sendCommandMock
      .mockImplementationOnce(async (command: { requestId: string }) => {
        captured.requestId = command.requestId
        return recoveryResult('AWAIT_REPAIR_CONFIRM', 'waiting', 'proposal', command.requestId)
      })
      .mockImplementationOnce(async () =>
        recoveryResult('AWAIT_OVERWRITE_CONFIRM', 'waiting', 'verified', captured.requestId),
      )

    await mount()
    await clickButton(container, 'Confirm repair')

    expect(container.textContent).toContain('AWAIT_OVERWRITE_CONFIRM')
    expect(sendCommandMock).toHaveBeenCalledTimes(2)
    expect(sendCommandMock.mock.calls[1]![0]).toMatchObject({ action: 'CONFIRM_REPAIR' })
    expect(buttonTexts(container)).toContain('Overwrite workflow')
  })

  it('commits only after overwrite confirmation', async () => {
    const captured = { requestId: '' }
    sendCommandMock
      .mockImplementationOnce(async (command: { requestId: string }) => {
        captured.requestId = command.requestId
        return recoveryResult('AWAIT_REPAIR_CONFIRM', 'waiting', 'p', command.requestId)
      })
      .mockImplementationOnce(async () =>
        recoveryResult('AWAIT_OVERWRITE_CONFIRM', 'waiting', 'v', captured.requestId),
      )
      .mockImplementationOnce(async () =>
        recoveryResult('DONE', 'done', 'updated', captured.requestId),
      )

    await mount()
    await clickButton(container, 'Confirm repair')
    await clickButton(container, 'Overwrite workflow')

    expect(container.textContent).toContain('DONE')
    expect(sendCommandMock).toHaveBeenCalledTimes(3)
    expect(sendCommandMock.mock.calls[2]![0]).toMatchObject({ action: 'CONFIRM_OVERWRITE' })
  })

  it('reports human takeover when no patch is available', async () => {
    sendCommandMock.mockImplementationOnce(async (command: { requestId: string }) =>
      recoveryResult('HUMAN_TAKEOVER', 'failed', 'no patch proposed', command.requestId),
    )
    await mount()
    expect(container.textContent).toContain('HUMAN_TAKEOVER')
  })

  it('renders the per-node before/after, risk and verification plan', async () => {
    sendCommandMock.mockImplementationOnce(async (command: { requestId: string }) => ({
      ...recoveryResult('AWAIT_REPAIR_CONFIRM', 'waiting', 'proposal ready', command.requestId),
      operations: [
        {
          operationId: 'o1',
          nodeId: 'n5',
          kind: 'REPLACE_TARGET',
          before: '.stale',
          after: '.fresh',
          reason: 'old selector missed',
          evidenceIds: ['ev1'],
        },
      ],
    }))
    await mount()

    expect(container.textContent).toContain('.stale')
    expect(container.textContent).toContain('.fresh')
    expect(container.textContent).toContain('old selector missed')
    expect(container.textContent).toContain('MEDIUM')
    expect(container.textContent).toContain('ev1')
  })
})
