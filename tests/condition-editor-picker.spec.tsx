// @vitest-environment jsdom
/**
 * The success-criterion row the operator edits by hand: naming the element in
 * words, pinning it with the element picker, and asking for a control's value.
 *
 * The row must write the picked selector through the same accessor the observer
 * reads (a rich target ignores a flat `selector`), and the value row must show the
 * two modes the run can actually check — 「只要有值」 and 「等于固定值」.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ConditionEditor from '../src/workflow-editor/sidebar/ConditionEditor'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import { conditionTargetSelector } from '../src/lib/workflow/element-fingerprint'
import type { WorkflowCondition } from '../src/lib/workflow/conditions'

const roots: Root[] = []
let listeners: ((message: unknown) => void)[] = []
const sendMessage = vi.fn()

beforeEach(() => {
  listeners = []
  sendMessage.mockResolvedValue({ ok: true })
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: (fn: (message: unknown) => void) => listeners.push(fn),
        removeListener: (fn: (message: unknown) => void) => {
          listeners = listeners.filter((item) => item !== fn)
        },
      },
    },
    windows: {
      getCurrent: async () => ({ id: 1 }),
      update: async () => undefined,
    },
  })
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  vi.unstubAllGlobals()
})

/**
 * ConditionEditor is controlled, so the harness feeds every edit back in the way
 * `NodeGoalInspector` does: the DOM has to show the row as the operator would see
 * it after the change, not just report it.
 */
function Harness({
  initialRows,
  onEdit,
  t,
}: {
  initialRows: WorkflowCondition[]
  onEdit: (next: WorkflowCondition[]) => void
  t: (key: string) => string
}) {
  const [rows, setRows] = useState(initialRows)
  return createElement(ConditionEditor, {
    conditions: rows,
    t,
    onChange: (next) => {
      onEdit(next)
      setRows(next)
    },
  })
}

function mount(conditions: WorkflowCondition[], onChange: (next: WorkflowCondition[]) => void) {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  const t = (key: string) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() =>
    root.render(
      createElement(
        EditorLocaleContext.Provider,
        { value: makeEditorLocale('en', t) },
        createElement(Harness, { initialRows: conditions, onEdit: onChange, t }),
      ),
    ),
  )
  return container
}

const byPlaceholder = (scope: ParentNode, placeholder: string) =>
  scope.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
const byTitle = (scope: ParentNode, title: string) =>
  scope.querySelector<HTMLButtonElement>(`button[title="${title}"]`)
const kindSelect = (scope: ParentNode) =>
  scope.querySelectorAll<HTMLSelectElement>('select[aria-label="Condition type"]')

function select(el: HTMLSelectElement, value: string) {
  act(() => {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function typeInto(el: HTMLInputElement, value: string) {
  act(() => {
    // React installs its own tracking `value` setter on the node, so a plain
    // assignment reads as "no change"; write through the prototype setter the way
    // a keystroke does.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const visibleRow: WorkflowCondition = {
  kind: 'elementVisible',
  target: { accessibleName: '标题' },
}

describe('the element row', () => {
  it('offers the shared selector control with its pick and verify buttons', () => {
    const container = mount([visibleRow], () => {})
    expect(byPlaceholder(container, '.css-selector')).not.toBeNull()
    expect(byTitle(container, 'Pick element on page')).not.toBeNull()
    expect(byTitle(container, 'Verify selector')).not.toBeNull()
  })

  it('writes the picked element into the row through the observer’s own accessor', () => {
    const received: WorkflowCondition[][] = []
    const container = mount([visibleRow], (next) => received.push(next))
    const pick = byTitle(container, 'Pick element on page')!
    act(() => {
      pick.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const started = sendMessage.mock.calls[0]?.[0] as { pickerId: string; type: string }
    expect(started.type).toBe('picker:start')
    act(() => {
      for (const fn of listeners)
        fn({ type: 'picker:result', pickerId: started.pickerId, selector: '#title' })
    })
    const [row] = received.at(-1) ?? []
    expect(row?.kind).toBe('elementVisible')
    expect(row && 'target' in row ? conditionTargetSelector(row.target) : '').toBe('#title')
  })

  it('shows a selector a generated rich target already carries', () => {
    const generated: WorkflowCondition = {
      kind: 'elementExists',
      target: {
        label: '标题输入框',
        primary: { how: 'css', value: '.note-title' },
        fallbacks: [],
      },
    }
    const container = mount([generated], () => {})
    expect(byPlaceholder(container, '.css-selector')?.value).toBe('.note-title')
  })

  it('keeps every kind with a target nameable, and leaves the others alone', () => {
    const urlRow: WorkflowCondition = { kind: 'urlContains', value: '/publish' }
    const container = mount([urlRow], () => {})
    expect(byPlaceholder(container, EDITOR_STRINGS.en.nodeConditionElementName)).toBeNull()
    expect(byPlaceholder(container, '.css-selector')).toBeNull()
  })
})

describe('the value row', () => {
  it('is offered as a condition type and starts with the has-a-value mode', () => {
    const received: WorkflowCondition[][] = []
    const container = mount([visibleRow], (next) => received.push(next))
    select(kindSelect(container)[0]!, 'elementValue')
    const row = received.at(-1)?.[0]
    expect(row).toEqual({ kind: 'elementValue', target: { accessibleName: '' }, op: 'notEmpty' })
    expect(container.textContent).toContain('Has any value')
  })

  it('asks for the fixed value only once the mode says equals', () => {
    const received: WorkflowCondition[][] = []
    const row: WorkflowCondition = {
      kind: 'elementValue',
      target: { accessibleName: '标题' },
      op: 'notEmpty',
    }
    const container = mount([row], (next) => received.push(next))
    const mode = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Value requirement"]',
    )!
    expect(byPlaceholder(container, EDITOR_STRINGS.en.nodeConditionExpectedValue)).toBeNull()
    select(mode, 'equals')
    expect(received.at(-1)?.[0]).toMatchObject({ op: 'equals' })
    const input = byPlaceholder(container, EDITOR_STRINGS.en.nodeConditionExpectedValue)!
    typeInto(input, '周末去哪玩')
    expect(received.at(-1)?.[0]).toMatchObject({ op: 'equals', expected: '周末去哪玩' })
  })

  it('registers both value modes in en and zh', () => {
    // Literal keys, so a copy that only landed on one side fails the typecheck.
    const keys = [
      'nodeConditionKind_elementValue',
      'nodeConditionValueMode',
      'nodeConditionValueNotEmpty',
      'nodeConditionValueEquals',
    ] as const
    for (const key of keys) {
      expect(EDITOR_STRINGS.en[key]).toBeTruthy()
      expect(EDITOR_STRINGS.zh[key]).toBeTruthy()
    }
  })
})
