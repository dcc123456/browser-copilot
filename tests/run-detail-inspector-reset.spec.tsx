// @vitest-environment jsdom
/**
 * Reopening a run's log must show the trace — not the variable inspector the
 * user happened to leave open last time. The detail modal stays mounted while
 * the list polls and swaps `run`, so the inspector state has to be reset by the
 * run's identity, and only then: a poll tick rebuilds the run object without
 * changing the run, and closing the inspector under the user's cursor would be
 * its own bug.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '../src/workflow-editor/i18n'
import RunDetailModal from '../src/workflow-editor/sidebar/RunDetailModal'
import type { RunView } from '../src/workflow-editor/sidebar/log-view'

const START = Date.UTC(2026, 10, 6, 2, 0, 0)

const run: RunView = {
  runId: 'run-9',
  label: '读取列表',
  source: 'manual',
  startedAt: START,
  finishedAt: START + 900,
  outcome: 'ok',
  steps: [
    { at: START, kind: 'tool', nodeId: 'n1', label: '读取列表', text: '读取列表' },
    { at: START + 10, kind: 'result', nodeId: 'n1', text: '读取完成' },
  ],
  snapshots: [{ nodeId: 'n1', label: '读取列表', at: START + 10, variables: { rows: [{ a: 1 }] } }],
}

describe('run detail opens on the trace', () => {
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

  function render(view: RunView | null): void {
    act(() => {
      root.render(
        createElement(RunDetailModal, {
          run: view,
          debug: true,
          onClose: () => {},
          t: makeTranslate('en'),
        }),
      )
    })
  }

  function inspect(): boolean {
    return document.body.querySelector('button[title="Back to log"]') !== null
  }

  it('forgets the open inspector when the modal is closed and reopened', () => {
    render(run)
    const row = document.body.querySelector('.wf-console-row')
    expect(row).not.toBeNull()
    act(() => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(inspect()).toBe(true)

    render(null)
    render(run)
    expect(inspect()).toBe(false)
    expect(document.body.textContent).toContain('读取完成')
  })

  it('does not close the inspector on a poll tick for the same run', () => {
    render(run)
    act(() => {
      document.body
        .querySelector('.wf-console-row')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(inspect()).toBe(true)

    // The logs list rebuilds its rows every poll; same run id means same view.
    render({ ...run })
    expect(inspect()).toBe(true)
  })
})
