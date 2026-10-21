// @vitest-environment jsdom
/**
 * Acceptance tests for the live fix log the two dialogs share
 * (specs/2026-10-16-live-fix-log-design.md): one event stream, concrete
 * parameters in every step, rendered while the fix runs.
 */
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/sidepanel/i18n'
import { messagesFor } from '../src/lib/i18n'
import { useNodeFixLog } from '../src/sidepanel/hooks/useWorkflowRuntimeEvents'
import { NodeFixBody, type NodeFixBodyProps } from '../src/workflow-editor/sidebar/NodeFixModal'
import { WorkflowReviewDialog } from '../src/sidepanel/WorkflowReviewList'
import { RepairProgressDialog } from '../src/sidepanel/components/RepairProgressDialog'
import type { NodeFixEvent } from '../src/lib/workflow/node-fix'
import type { RepairProgressEvent } from '../src/lib/workflow/repair-events'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom implements neither scrolling API; both log sections auto-tail.
  for (const method of ['scrollTo', 'scrollBy'] as const) {
    Object.defineProperty(Element.prototype, method, { value: () => {}, configurable: true })
  }
})

const roots: Root[] = []

afterEach(() => {
  // jsdom leaks the portal timers of a mounted root otherwise.
  while (roots.length > 0) {
    const root = roots.pop()!
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** The chat's dialog, wired the way ChatTab wires it: it subscribes to the stream. */
function WorkflowDialogWithFixStream(): ReactElement {
  const fixLog = useNodeFixLog({ round: (round) => `R${round + 1}` })
  return createElement(WorkflowReviewDialog, {
    title: 'title',
    steps: [],
    review: null,
    reviewing: false,
    keep: null,
    onToggle: () => undefined,
    onConfirm: () => undefined,
    onCancel: () => undefined,
    fixLog,
  })
}

/** Mount a panel component with a fixed locale. Both dialogs portal into the body. */
function mountPanel(node: React.ReactElement): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => {
    root.render(
      createElement(I18nProvider, { value: { locale: 'en', t: messagesFor('en') } }, node),
    )
  })
}

const markup = () => document.body.innerHTML

const identity = (key: string) => key

function fixEvent(over: Partial<NodeFixEvent> = {}): NodeFixEvent {
  return {
    sessionId: 's1',
    phase: 'diagnosing',
    round: 0,
    message: 'land on the home page',
    status: 'running',
    payload: {
      request: 'block: event-click\nparams: {"selector":"#old"}',
      response: 'rationale: use the test id\nparams: {"selector":"[data-testid=go]"}',
    },
    ...over,
  }
}

describe('V-live-fix-log: one stream, both dialogs', () => {
  it('V-log-1 shows the parameters sent and the parameters the AI returned', () => {
    const body: NodeFixBodyProps = {
      state: 'running',
      hasContract: true,
      suggestion: '',
      errorLog: '',
      events: [fixEvent()],
      onSuggestionChange: () => {},
      onErrorLogChange: () => {},
      t: identity,
    }
    const html = renderToStaticMarkup(createElement(NodeFixBody, body))
    expect(html).toContain('nodeFixLogPayload')
    expect(html).toContain('#old')
    expect(html).toContain('data-testid=go')
  })

  it('V-log-2 pushes the fix stream to every page, not only to panel ports', () => {
    // The editor tab has no panel port: the port broadcast was why its fix
    // dialog never showed a live line.
    const background = readFileSync('src/background/index.ts', 'utf8')
    expect(background).toContain(`broadcastToPages({ type: 'workflows.nodeFixEvent'`)
    expect(background).not.toContain(`broadcastPanels({ type: 'workflows.nodeFixEvent'`)
  })

  it('V-log-3 mirrors the fix stream into the workflow dialog', () => {
    mountPanel(
      createElement(WorkflowReviewDialog, {
        title: 'title',
        steps: [],
        review: null,
        reviewing: false,
        keep: null,
        onToggle: () => undefined,
        onConfirm: () => undefined,
        onCancel: () => undefined,
        log: ['review line'],
        fixLog: ['R1 · block: event-click | params: {"selector":"#old"}'],
      }),
    )
    const html = markup()
    // Both streams keep their own section: the fix log does not replace the
    // review log the same dialog already shows.
    expect(html).toContain('AI optimization log')
    expect(html).toContain('#old')
    expect(html).toContain('Review log')
    expect(html).toContain('review line')
  })

  it('V-log-4 reports the concrete repair steps, not only canned labels', () => {
    const events: RepairProgressEvent[] = [
      { type: 'repair.started', sessionId: 's1', workflowId: 'wf-1', runId: 'r1' },
      { type: 'repair.diagnosing', sessionId: 's1', strategy: 'relocate', attempt: 2 },
      { type: 'repair.applying', sessionId: 's1', strategy: 'relocate', changedNodeIds: ['n-7'] },
      {
        type: 'repair.attempt-failed',
        sessionId: 's1',
        attempt: 2,
        reason: 'postcondition did not hold',
      },
    ]
    mountPanel(
      createElement(RepairProgressDialog, {
        open: true,
        workflowId: 'wf-1',
        events,
        onClose: () => undefined,
        onHumanTakeover: () => undefined,
      }),
    )
    const html = markup()
    expect(html).toContain('relocate')
    expect(html).toContain('#2')
    expect(html).toContain('n-7')
    expect(html).toContain('postcondition did not hold')
  })

  it('V-log-5 delivers the stream over runtime messages into the workflow dialog', async () => {
    // The chat's review dialog subscribes the same way the editor's fix dialog
    // does, so an event pushed by the background lands in both without a port.
    const listeners: ((message: unknown) => void)[] = []
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: (fn: (message: unknown) => void) => listeners.push(fn),
          removeListener: (fn: (message: unknown) => void) => {
            const index = listeners.indexOf(fn)
            if (index >= 0) listeners.splice(index, 1)
          },
        },
      },
    })

    mountPanel(createElement(WorkflowDialogWithFixStream))
    expect(markup()).not.toContain('AI optimization log')

    await act(async () => {
      for (const listener of listeners) {
        listener({ type: 'workflows.nodeFixEvent', event: fixEvent() })
      }
    })

    const html = markup()
    expect(html).toContain('AI optimization log')
    expect(html).toContain('R1 · land on the home page')
    expect(html).toContain('#old')
    expect(html).toContain('data-testid=go')
  })
})
