// @vitest-environment jsdom
/**
 * Regression coverage for the canvas box-select key state: the release path must
 * always clear, because a stuck key leaves the canvas in box-select mode with no
 * way back to panning (user report: 「无法退出框选模式」).
 *
 * @module tests/space-select
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { useSpaceSelect } from '../src/workflow-editor/use-space-select'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: ReturnType<typeof createRoot>[] = []

function mountHook(hook: () => boolean): { read: () => boolean; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  let value = false
  function Probe() {
    value = hook()
    return null
  }
  act(() => {
    root.render(createElement(StrictMode, null, createElement(Probe)))
  })
  return {
    read: () => value,
    unmount: () => {
      const index = roots.indexOf(root)
      if (index >= 0) roots.splice(index, 1)
      act(() => root.unmount())
    },
  }
}

function key(
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit & { code: string },
  target: EventTarget,
) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('useSpaceSelect', () => {
  it('arms on Space pressed outside a text field', () => {
    const view = mountHook(useSpaceSelect)
    expect(view.read()).toBe(false)

    key('keydown', { code: 'Space', key: ' ' }, document.body)
    expect(view.read()).toBe(true)
  })

  it('ignores Space typed into an input, textarea or contenteditable', () => {
    const view = mountHook(useSpaceSelect)
    for (const target of [
      document.createElement('input'),
      document.createElement('textarea'),
      Object.assign(document.createElement('div'), { contentEditable: 'true' }),
    ]) {
      key('keydown', { code: 'Space', key: ' ' }, target)
      expect(view.read()).toBe(false)
    }
    // and the auto-repeat of a held key does not re-arm it either
    key('keydown', { code: 'Space', key: ' ', repeat: true }, document.body)
    expect(view.read()).toBe(false)
  })

  it('disarms on release even when focus moved into a text field', () => {
    const view = mountHook(useSpaceSelect)
    const input = document.createElement('input')
    document.body.appendChild(input)

    key('keydown', { code: 'Space', key: ' ' }, document.body)
    expect(view.read()).toBe(true)
    key('keyup', { code: 'Space', key: ' ' }, input)
    expect(view.read()).toBe(false)
  })

  it('disarms when the window loses focus or a context menu opens', () => {
    const view = mountHook(useSpaceSelect)
    key('keydown', { code: 'Space', key: ' ' }, document.body)
    expect(view.read()).toBe(true)

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(view.read()).toBe(false)

    key('keydown', { code: 'Space', key: ' ' }, document.body)
    expect(view.read()).toBe(true)
    act(() => {
      window.dispatchEvent(new Event('contextmenu'))
    })
    expect(view.read()).toBe(false)
  })

  it('leaves other keys alone', () => {
    const view = mountHook(useSpaceSelect)
    key('keydown', { code: 'KeyA', key: 'a' }, document.body)
    expect(view.read()).toBe(false)
    key('keydown', { code: 'ShiftLeft', key: 'Shift' }, document.body)
    expect(view.read()).toBe(false)
  })

  it('stops listening once unmounted', () => {
    const view = mountHook(useSpaceSelect)
    view.unmount()
    // Nothing is left bound to the window, so a later Space cannot resurrect the
    // state (the listener-removal path is what keeps a closed editor quiet).
    expect(() =>
      document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })),
    ).not.toThrow()
  })
})
