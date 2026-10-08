// @vitest-environment jsdom
/**
 * The repair dialog must settle when the repair settles: a failed (exhausted /
 * blocked) session may leave no step looking in-flight, or the spinner reads as
 * "the AI is still working" forever. While it IS running, cancel must be
 * reachable.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/sidepanel/i18n'
import { messagesFor } from '../src/lib/i18n'
import { RepairProgressDialog } from '../src/sidepanel/components/RepairProgressDialog'
import type { RepairProgressEvent } from '../src/lib/workflow/repair-events'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const started: RepairProgressEvent = {
  type: 'repair.started',
  sessionId: 's1',
  workflowId: 'wf-1',
  runId: 'r1',
}
const diagnosing: RepairProgressEvent = {
  type: 'repair.diagnosing',
  sessionId: 's1',
  strategy: 'relocate',
  attempt: 1,
}
const verifying: RepairProgressEvent = { type: 'repair.verifying', sessionId: 's1' }

function render(events: RepairProgressEvent[], onCancelRepair?: () => void): string {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(
      createElement(
        I18nProvider,
        { value: { locale: 'en', t: messagesFor('en') } },
        createElement(RepairProgressDialog, {
          open: true,
          workflowId: 'wf-1',
          events,
          onClose: () => undefined,
          onHumanTakeover: () => undefined,
          ...(onCancelRepair ? { onCancelRepair } : {}),
        }),
      ),
    )
  })
  // The dialog portals itself onto document.body.
  return document.body.innerHTML
}

const clickCancel = (): void => {
  const button = Array.from(document.querySelectorAll('button')).find((node) =>
    (node.textContent ?? '').includes('Cancel repair'),
  )
  act(() => {
    button?.click()
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('RepairProgressDialog · terminal states', () => {
  it('stops every spinner when the repair is exhausted', () => {
    const html = render([
      started,
      diagnosing,
      verifying,
      { type: 'repair.exhausted', sessionId: 's1', reason: 'no strategy worked' },
    ])
    expect(html).not.toContain('animate-spin')
    expect(html).toContain('exhausted')
  })

  it('stops every spinner when the repair is blocked', () => {
    const html = render([
      started,
      verifying,
      { type: 'repair.blocked', sessionId: 's1', reason: 'needs a login' },
    ])
    expect(html).not.toContain('animate-spin')
  })

  it('marks the verifying step done on success', () => {
    const html = render([started, verifying, { type: 'repair.success', sessionId: 's1' }])
    expect(html).not.toContain('animate-spin')
    expect(html).toContain('Workflow auto-repaired')
  })

  it('shows a failed row for an attempt that did not fix the step', () => {
    const html = render([
      started,
      diagnosing,
      { type: 'repair.attempt-failed', sessionId: 's1', attempt: 1, reason: 'still failing' },
      verifying,
      { type: 'repair.exhausted', sessionId: 's1', reason: 'gave up' },
    ])
    expect(html).toContain('This repair attempt failed')
    expect(html).not.toContain('animate-spin')
  })

  it('keeps a spinner and offers cancel while running', () => {
    const cancel = vi.fn()
    const html = render([started, diagnosing, verifying], cancel)
    expect(html).toContain('animate-spin')
    expect(html).toContain('Cancel repair')
    clickCancel()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('stops offering cancel once the repair has settled', () => {
    const html = render(
      [started, verifying, { type: 'repair.exhausted', sessionId: 's1', reason: 'gave up' }],
      () => undefined,
    )
    expect(html).not.toContain('Cancel repair')
  })
})
