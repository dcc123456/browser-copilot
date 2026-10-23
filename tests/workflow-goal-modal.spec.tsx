// @vitest-environment jsdom
/**
 * The workflow goal the L3 gate checks: the modal must let the operator fix the
 * summary and success conditions that produce 「目标未达成」, keep terminal-state
 * conditions it does not expose, refuse to save a half-filled row, and delete
 * the goal only after a second, explicit click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import WorkflowGoalModal from '../src/workflow-editor/sidebar/WorkflowGoalModal'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import type { WorkflowGoalSpec } from '../src/lib/workflow/reliability'
import type { WorkflowSettings } from '../src/lib/workflow/types'

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

const baseSettings: WorkflowSettings = {
  saveLog: false,
  debugMode: false,
  notification: false,
  reuseLastState: false,
}

const t = (key: string) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key

function mount({
  settings,
  onSave,
  onClose = () => {},
}: {
  settings: WorkflowSettings
  onSave: (goalSpec: WorkflowGoalSpec | null) => void
  onClose?: () => void
}) {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() =>
    root.render(
      createElement(
        EditorLocaleContext.Provider,
        { value: makeEditorLocale('en', t) },
        createElement(WorkflowGoalModal, { settings, onSave, onClose, t }),
      ),
    ),
  )
  // The modal portals to <body>, so the rendered tree is not under `container`.
  return document.body
}

const buttonByText = (scope: ParentNode, text: string) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent === text,
  )

const summaryBox = (scope: ParentNode) =>
  scope.querySelector<HTMLTextAreaElement>('textarea[aria-label="Goal summary"]')

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    // React installs its own tracking `value` setter, so a plain assignment reads
    // as "no change"; write through the prototype setter the way a keystroke does.
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setValue?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('WorkflowGoalModal', () => {
  it('saves a trimmed summary with one complete element condition', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    const scope = mount({ settings: baseSettings, onSave, onClose })

    // Nothing to verify yet: the save button refuses until the draft is real.
    expect(buttonByText(scope, 'Save')?.disabled).toBe(true)

    typeInto(summaryBox(scope)!, '  发布一条笔记  ')
    click(buttonByText(scope, 'Add condition')!)
    typeInto(
      scope.querySelector<HTMLInputElement>(
        `input[placeholder="${EDITOR_STRINGS.en.nodeConditionElementName}"]`,
      )!,
      '草稿箱',
    )

    const save = buttonByText(scope, 'Save')!
    expect(save.disabled).toBe(false)
    click(save)

    expect(onSave).toHaveBeenCalledWith({
      summary: '发布一条笔记',
      successConditions: [{ kind: 'elementVisible', target: { accessibleName: '草稿箱' } }],
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('carries terminal-state conditions through an edit it does not expose', () => {
    const existing: WorkflowGoalSpec = {
      summary: '旧目标',
      successConditions: [{ kind: 'urlContains', value: '/publish/done' }],
      terminalStateConditions: [{ kind: 'elementExists', target: { accessibleName: '已登录' } }],
    }
    const onSave = vi.fn()
    const scope = mount({
      settings: { ...baseSettings, goalSpec: existing },
      onSave,
    })

    expect(summaryBox(scope)?.value).toBe('旧目标')
    expect(scope.textContent).toContain(EDITOR_STRINGS.en.workflowGoalTerminalKept)

    typeInto(summaryBox(scope)!, '新目标')
    click(buttonByText(scope, 'Save')!)

    expect(onSave).toHaveBeenCalledWith({
      summary: '新目标',
      successConditions: existing.successConditions,
      terminalStateConditions: existing.terminalStateConditions,
    })
  })

  it('keeps save disabled while an added row has no element name', () => {
    const onSave = vi.fn()
    const scope = mount({
      settings: {
        ...baseSettings,
        goalSpec: {
          summary: '目标',
          successConditions: [{ kind: 'urlContains', value: '/done' }],
        },
      },
      onSave,
    })

    expect(buttonByText(scope, 'Save')?.disabled).toBe(false)
    click(buttonByText(scope, 'Add condition')!)
    expect(buttonByText(scope, 'Save')?.disabled).toBe(true)
    expect(scope.textContent).toContain(EDITOR_STRINGS.en.workflowGoalIncomplete)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('removes the goal only on the second click', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    const scope = mount({
      settings: {
        ...baseSettings,
        goalSpec: {
          summary: '目标',
          successConditions: [{ kind: 'urlContains', value: '/done' }],
        },
      },
      onSave,
      onClose,
    })

    click(buttonByText(scope, 'Remove goal')!)
    expect(onSave).not.toHaveBeenCalled()
    expect(scope.textContent).toContain(EDITOR_STRINGS.en.workflowGoalDeleteWarning)

    click(buttonByText(scope, 'Confirm removal')!)
    expect(onSave).toHaveBeenCalledWith(null)
    expect(onClose).toHaveBeenCalled()
  })

  it('offers no removal when the workflow has no goal', () => {
    const scope = mount({ settings: baseSettings, onSave: vi.fn() })
    expect(buttonByText(scope, 'Remove goal')).toBeUndefined()
  })

  it('registers the goal copy in en and zh', () => {
    const keys = [
      'workflowGoalTab',
      'workflowGoalTitle',
      'workflowGoalHint',
      'workflowGoalSummary',
      'workflowGoalSummaryPlaceholder',
      'workflowGoalConditions',
      'workflowGoalIncomplete',
      'workflowGoalTerminalKept',
      'workflowGoalDelete',
      'workflowGoalDeleteWarning',
      'workflowGoalDeleteConfirm',
    ] as const
    for (const key of keys) {
      expect(EDITOR_STRINGS.en[key]).toBeTruthy()
      expect(EDITOR_STRINGS.zh[key]).toBeTruthy()
    }
  })
})
