// @vitest-environment jsdom
/**
 * The run-detail header's "Copy logs" action. The clipboard itself is mocked
 * (jsdom has no `execCommand('copy')`), but the click → formatted text → button
 * confirmation path is the user-visible half and must not regress.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../src/lib/clipboard'
import { makeTranslate } from '../src/workflow-editor/i18n'
import RunDetailModal from '../src/workflow-editor/sidebar/RunDetailModal'
import type { RunView } from '../src/workflow-editor/sidebar/log-view'

vi.mock('../src/lib/clipboard', () => ({ copyText: vi.fn(async () => {}) }))

const START = Date.UTC(2026, 10, 6, 1, 2, 3)

const run: RunView = {
  runId: 'run-7',
  label: '抓取标题',
  source: 'manual',
  startedAt: START,
  finishedAt: START + 1_500,
  outcome: 'failed',
  steps: [
    { at: START, kind: 'tool', nodeId: 'n1', label: '打开页面', text: '打开页面' },
    { at: START + 100, kind: 'result', text: '已打开', nodeId: 'n1' },
    { at: START + 200, kind: 'error', text: '点击失败', nodeId: 'n1' },
  ],
}

describe('run-detail copy action', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true
    vi.mocked(copyText).mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(): void {
    act(() => {
      root.render(
        createElement(RunDetailModal, {
          run,
          debug: false,
          onClose: () => {},
          t: makeTranslate('en'),
        }),
      )
    })
  }

  function buttonByText(text: string): HTMLButtonElement | undefined {
    return [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(text),
    )
  }

  it('copies the formatted trace and confirms on the button', async () => {
    render()
    const button = buttonByText('Copy logs')
    expect(button).toBeDefined()

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(copyText).toHaveBeenCalledTimes(1)
    const text = vi.mocked(copyText).mock.calls[0]![0]
    expect(text).toContain('抓取标题 (run-7)')
    expect(text).toContain('打开页面')
    expect(text).toContain('已打开')
    expect(text).toContain('! 点击失败')
    expect(buttonByText('Logs copied')).toBeDefined()
  })
})
