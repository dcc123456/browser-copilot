// @vitest-environment jsdom
/**
 * The run-log trace offers a "continue from here" action next to Locate.
 * Clicking it must hand the row's node id, the source run id and the row's
 * variables to the caller — and must NOT open the variable inspector, which is
 * the row's own click action.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import RunDetailModal from '../src/workflow-editor/sidebar/RunDetailModal'
import type { RunView } from '../src/workflow-editor/sidebar/log-view'

const START = Date.UTC(2026, 10, 18, 3, 0, 0)

const run: RunView = {
  runId: 'run-continue-1',
  label: '采集数据',
  source: 'manual',
  startedAt: START,
  finishedAt: START + 1200,
  outcome: 'failed',
  steps: [
    {
      at: START,
      kind: 'tool',
      nodeId: 'collect-node',
      label: '采集数据',
      text: '采集数据',
      vars: { rows: [1, 2, 3] },
    },
    { at: START + 10, kind: 'result', nodeId: 'collect-node', text: '采集完成' },
  ],
}

describe('run log continue-from-here', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(onContinueFrom?: (nodeId: string, runId: string, vars?: unknown) => void): void {
    act(() => {
      root.render(
        createElement(
          EditorLocaleContext.Provider,
          { value: makeEditorLocale('en', makeTranslate('en')) },
          createElement(RunDetailModal, {
            run,
            debug: true,
            onClose: () => {},
            onLocateNode: () => {},
            ...(onContinueFrom ? { onContinueFrom } : {}),
            t: makeTranslate('en'),
          }),
        ),
      )
    })
  }

  function continueButton(): HTMLButtonElement | null {
    return document.body.querySelector('button[title="Continue from here"]')
  }

  it('renders the button next to Locate and passes node / run / variables', () => {
    const onContinueFrom = vi.fn()
    render(onContinueFrom)
    expect(continueButton()).not.toBeNull()
    expect(document.body.querySelector('button[title="Locate"]')).not.toBeNull()

    act(() => {
      continueButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onContinueFrom).toHaveBeenCalledTimes(1)
    expect(onContinueFrom).toHaveBeenCalledWith('collect-node', 'run-continue-1', {
      rows: [1, 2, 3],
    })
    // The row's own click opens the inspector; the button must not.
    expect(document.body.querySelector('button[title="Back to log"]')).toBeNull()
  })

  it('does not render the button when no continuation callback is supplied', () => {
    render()
    expect(continueButton()).toBeNull()
  })
})
