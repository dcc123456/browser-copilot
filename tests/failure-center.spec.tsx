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

  // Route workflows.get to nothing and serve recovery responses from a queue.
  const mockRecovery = (responses: unknown[]) => {
    const queue = responses.slice()
    sendCommandMock.mockImplementation((command: { type: string }) => {
      if (command.type === 'workflows.get') {
        return Promise.resolve({ type: 'workflows.get' })
      }
      return Promise.resolve(queue.shift())
    })
  }

  it('sends START on open and pauses at repair confirmation', async () => {
    mockRecovery([recoveryResult('AWAIT_REPAIR_CONFIRM', 'waiting', 'proposal ready', 'r1')])
    await mount()

    const recoveryCalls = sendCommandMock.mock.calls
      .map((call) => call[0])
      .filter((command) => (command as { type: string }).type === 'workflows.recovery')
    expect(recoveryCalls).toHaveLength(1)
    expect(recoveryCalls[0]).toMatchObject({
      type: 'workflows.recovery',
      action: 'START',
      workflowId: 'wf1',
      runId: 'run1',
    })
    expect(container.textContent).toContain('Review the proposed repair')
    expect(container.textContent).toContain('proposal ready')
    expect(buttonTexts(container)).toContain('Confirm repair')
  })

  it('pauses at overwrite after confirm-repair, without committing', async () => {
    mockRecovery([
      recoveryResult('AWAIT_REPAIR_CONFIRM', 'waiting', 'proposal', 'r1'),
      recoveryResult('AWAIT_OVERWRITE_CONFIRM', 'waiting', 'verified', 'r1'),
    ])

    await mount()
    await clickButton(container, 'Confirm repair')

    expect(container.textContent).toContain('Review and overwrite')
    const recoveryCalls = sendCommandMock.mock.calls
      .map((call) => call[0])
      .filter((command) => (command as { type: string }).type === 'workflows.recovery')
    expect(recoveryCalls).toHaveLength(2)
    expect(recoveryCalls[1]).toMatchObject({ action: 'CONFIRM_REPAIR' })
    expect(buttonTexts(container)).toContain('Overwrite workflow')
  })

  it('commits only after overwrite confirmation', async () => {
    mockRecovery([
      recoveryResult('AWAIT_REPAIR_CONFIRM', 'waiting', 'p', 'r1'),
      recoveryResult('AWAIT_OVERWRITE_CONFIRM', 'waiting', 'v', 'r1'),
      recoveryResult('DONE', 'done', 'updated', 'r1'),
    ])

    await mount()
    await clickButton(container, 'Confirm repair')
    await clickButton(container, 'Overwrite workflow')

    expect(container.textContent).toContain('Recovery completed')
    const recoveryCalls = sendCommandMock.mock.calls
      .map((call) => call[0])
      .filter((command) => (command as { type: string }).type === 'workflows.recovery')
    expect(recoveryCalls).toHaveLength(3)
    expect(recoveryCalls[2]).toMatchObject({ action: 'CONFIRM_OVERWRITE' })
  })

  it('reports human takeover when no patch is available', async () => {
    mockRecovery([recoveryResult('HUMAN_TAKEOVER', 'failed', 'no patch proposed', 'r1')])
    await mount()
    expect(container.textContent).toContain('Manual takeover needed')
  })

  it('renders the per-node before/after, risk and verification plan', async () => {
    mockRecovery([
      {
        ...recoveryResult('AWAIT_REPAIR_CONFIRM', 'waiting', 'proposal ready', 'r1'),
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
      },
    ])
    await mount()

    expect(container.textContent).toContain('.stale')
    expect(container.textContent).toContain('.fresh')
    expect(container.textContent).toContain('old selector missed')
    expect(container.textContent).toContain('MEDIUM')
    expect(container.textContent).toContain('ev1')
  })
})
