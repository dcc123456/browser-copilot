// @vitest-environment jsdom
/**
 * The shared enable/disable switch.
 *
 * Every surface that turns a capability on or off renders this one component,
 * so the two things worth pinning down are that it announces itself as a
 * switch (not a checkbox) and that it reports the flipped value.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Switch } from '../src/ui/Switch'

const roots: Root[] = []
const containers: HTMLElement[] = []

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  for (const container of containers) container.remove()
  roots.length = 0
  containers.length = 0
})

function render(node: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(node))
  roots.push(root)
  containers.push(container)
  return container
}

describe('Switch', () => {
  it('exposes the state as a switch, not a checkbox', () => {
    const container = render(createElement(Switch, { checked: true, onChange: () => {} }))
    const control = container.querySelector('[role="switch"]')
    expect(control).not.toBeNull()
    expect(control?.getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
  })

  it('reports the flipped value on click', () => {
    const onChange = vi.fn()
    const container = render(createElement(Switch, { checked: false, onChange }))
    const control = container.querySelector('[role="switch"]') as HTMLElement
    act(() => control.click())
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('does not report while disabled', () => {
    const onChange = vi.fn()
    const container = render(createElement(Switch, { checked: false, onChange, disabled: true }))
    const control = container.querySelector('[role="switch"]') as HTMLButtonElement
    expect(control.disabled).toBe(true)
    act(() => control.click())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('labels the control through the associated text', () => {
    const container = render(
      createElement(Switch, { checked: false, onChange: () => {}, label: 'Enabled' }),
    )
    const control = container.querySelector('[role="switch"]') as HTMLElement
    const label = container.querySelector('[aria-labelledby="true"], [id]') as HTMLElement
    expect(control.getAttribute('aria-labelledby')).toBe(label.id)
    expect(label.textContent).toContain('Enabled')
  })

  it('toggles when the label text is clicked', () => {
    const onChange = vi.fn()
    const container = render(createElement(Switch, { checked: false, onChange, label: 'Enabled' }))
    const control = container.querySelector('[role="switch"]') as HTMLElement
    const text = container.querySelector(
      `#${CSS.escape(control.getAttribute('aria-labelledby') ?? '')}`,
    ) as HTMLElement
    act(() => text.click())
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
