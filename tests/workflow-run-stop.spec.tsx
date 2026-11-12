// @vitest-environment jsdom
/**
 * Editor run controls: while a run is in flight the toolbar's Run button IS the
 * Stop button — clicking it cancels the run through the same `tasks.cancel` the
 * panel's terminate uses. Also pins the button's states: idle shows Run, running
 * shows Stop, a requested stop locks the button until the run settles.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

import TopToolbar from '../src/workflow-editor/toolbar/TopToolbar'

/** Key passthrough, so labels in the DOM are the i18n key names. */
const t = (key: string) => key

let container: HTMLElement
const roots: Root[] = []

afterEach(() => {
  while (roots.length > 0) {
    const mounted = roots.pop()!
    act(() => mounted.unmount())
  }
  document.body.innerHTML = ''
})

function renderToolbar(overrides: Record<string, unknown> = {}): void {
  // A fresh host per render — React forbids a second createRoot on one node.
  container = document.body.appendChild(document.createElement('div'))
  const props = {
    paletteOpen: false,
    onTogglePalette: () => {},
    debugMode: false,
    onToggleDebug: () => {},
    testingMode: false,
    onToggleTesting: () => {},
    saving: false,
    dirty: false,
    running: false,
    recording: false,
    onSave: () => {},
    onRun: () => {},
    onStop: () => {},
    stoppingRun: false,
    onOpenLogs: () => {},
    onOpenGoal: () => {},
    onOpenDataTable: () => {},
    parameterCount: 0,
    onOpenParameters: () => {},
    onToggleRecording: () => {},
    selectedCount: 0,
    onPackSelection: () => {},
    t,
    ...overrides,
  }
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(createElement(TopToolbar, props))
  })
}

const runButton = (): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((button) =>
    button.title.toLowerCase().includes('run'),
  )!

describe('the editor run/stop button', () => {
  it('runs when idle', () => {
    const onRun = vi.fn()
    renderToolbar({ onRun })
    const button = runButton()
    expect(button.disabled).toBe(false)
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onRun).toHaveBeenCalledOnce()
  })

  it('stops the run while it is running', () => {
    const onRun = vi.fn()
    const onStop = vi.fn()
    renderToolbar({ running: true, onRun, onStop })
    const button = runButton()
    expect(button.disabled).toBe(false)
    expect(button.title).toBe('stopRun')
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onStop).toHaveBeenCalledOnce()
    expect(onRun).not.toHaveBeenCalled()
  })

  it('locks while a stop was requested, then returns to Run', () => {
    renderToolbar({ running: true, stoppingRun: true })
    expect(runButton().disabled).toBe(true)
    renderToolbar({ running: false, stoppingRun: false })
    expect(runButton().disabled).toBe(false)
    expect(runButton().title.toLowerCase()).not.toBe('stoprun')
  })
})
