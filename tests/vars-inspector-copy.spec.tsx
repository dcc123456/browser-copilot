// @vitest-environment jsdom
/**
 * The GUI tab of the run's variable inspector: every card carries its own copy
 * icon, so a user can lift one value (a URL, a title, a JSON blob) without
 * exporting the whole trace. The clipboard is mocked — jsdom has no
 * `execCommand('copy')` — but the click → value → per-card confirmation path
 * is exactly what the user sees.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../src/lib/clipboard'
import { valueText, VariablesInspector } from '../src/workflow-editor/sidebar/log-view'

vi.mock('../src/lib/clipboard', () => ({ copyText: vi.fn(async () => {}) }))

const vars = {
  title: '页面标题',
  payload: { id: 7, tags: ['a', 'b'] },
  empty: null,
}

describe('variable cards copy their own value', () => {
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
    vi.useRealTimers()
  })

  function render(): void {
    act(() => {
      root.render(createElement(VariablesInspector, { vars, onBack: () => {} }))
    })
  }

  function card(name: string): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>('.wf-var-card')].find(
      (element) => element.querySelector('label')?.textContent === name,
    )
    expect(found, `card for ${name}`).toBeTruthy()
    return found!
  }

  function copyButton(name: string): HTMLButtonElement {
    const button = card(name).querySelector('button')
    expect(button, `copy button for ${name}`).toBeTruthy()
    return button as HTMLButtonElement
  }

  it('copies the raw string shown in the card', async () => {
    render()
    await act(async () => {
      copyButton('title').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(copyText).toHaveBeenCalledWith('页面标题')
  })

  it('copies structured values as JSON', async () => {
    render()
    await act(async () => {
      copyButton('payload').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(copyText).toHaveBeenCalledWith(JSON.stringify(vars.payload))
  })

  it('confirms on the clicked card only, then reverts', async () => {
    vi.useFakeTimers()
    render()
    const clicked = copyButton('title')
    await act(async () => {
      clicked.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(clicked.getAttribute('aria-label')).toBe('Copied')
    // The other cards keep advertising the action, so there is no doubt which
    // value was copied.
    expect(copyButton('payload').getAttribute('aria-label')).toBe('Copy value')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(clicked.getAttribute('aria-label')).toBe('Copy value')
  })

  it('reports a refused copy without pretending it worked', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('clipboard refused'))
    render()
    const button = copyButton('title')
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(button.getAttribute('aria-label')).toBe('Copy failed')
  })

  it('shows a list of objects as JSON, never [object Object]', () => {
    const list = [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }]
    act(() => {
      root.render(createElement(VariablesInspector, { vars: { rows: list }, onBack: () => {} }))
    })
    const input = card('rows').querySelector('input')!
    expect(input.value).toBe(JSON.stringify(list))
    expect(input.value).not.toContain('[object Object]')
  })

  it('opens the full value when the card is clicked, without copying', async () => {
    render()
    await act(async () => {
      card('title').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-label')).toBe('title')
    // A long value arrives in full, with its newlines intact.
    expect(dialog?.querySelector('pre')?.textContent).toBe('页面标题')
    expect(copyText).not.toHaveBeenCalled()
  })

  it('keeps copying separate from opening the dialog', async () => {
    render()
    await act(async () => {
      copyButton('title').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(copyText).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('valueText', () => {
  it('keeps strings verbatim and serializes the rest', () => {
    expect(valueText('a\nb')).toBe('a\nb')
    expect(valueText(7)).toBe('7')
    expect(valueText(null)).toBe('null')
    expect(valueText({ a: 1 })).toBe('{"a":1}')
    expect(valueText([{ a: 1 }, { b: 2 }])).toBe('[{"a":1},{"b":2}]')
    expect(valueText(10n)).toBe('10n')
  })

  it('renders a cycle instead of throwing or degenerating', () => {
    const ring: unknown[] = [{ a: 1 }]
    ring.push(ring)
    const text = valueText(ring)
    expect(text).toContain('[Circular]')
    expect(text).not.toContain('[object Object]')
  })

  it('pretty-prints with indentation for the dialog', () => {
    expect(valueText({ a: 1 }, true)).toBe('{\n  "a": 1\n}')
  })
})
