// @vitest-environment jsdom
/**
 * Behavior tests for the blur-validating NumberInput (src/ui/NumberInput).
 *
 * Pins the interaction contract that fixes the "can't clear a required input"
 * UX bug: the field must stay clearable while typing, only valid numbers are
 * committed live, and an empty/invalid draft is normalized on blur by writing
 * back the default (fallback → min → 0).
 *
 * The input is mounted through a stateful host so commits round-trip through
 * the parent like a real form (controlled value ← onChange).
 */
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

import { act, useState } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import NumberInput from '../src/ui/NumberInput'

let container: HTMLElement
let root: Root

interface HostProps {
  initial: number | string
  fallback?: number
  min?: number
  max?: number
}

/** Mount NumberInput under a stateful parent that records onChange calls. */
const renderInput = (opts: HostProps): { input: HTMLInputElement; onChange: ReturnType<typeof vi.fn> } => {
  const onChange = vi.fn()
  const Host = (): ReturnType<typeof NumberInput> => {
    const [value, setValue] = useState<number | string>(opts.initial)
    return createElement(NumberInput, {
      value,
      fallback: opts.fallback,
      min: opts.min,
      max: opts.max,
      onChange: (n: number) => {
        onChange(n)
        setValue(n)
      },
    })
  }
  act(() => {
    root.render(createElement(Host))
  })
  return { input: container.querySelector('input') as HTMLInputElement, onChange }
}

/** Simulate user typing: set the value through the native setter so React's
 *  change tracker picks it up, then dispatch a bubbling input event. */
const type = (input: HTMLInputElement, text: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const blur = (input: HTMLInputElement) => {
  act(() => {
    // React delegates focus/blur through the bubbling focusout event.
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

describe('NumberInput blur validation', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('commits valid numbers live while typing', () => {
    const { input, onChange } = renderInput({ initial: 5000, fallback: 5000 })
    type(input, '7')
    expect(onChange).toHaveBeenCalledWith(7)
  })

  it('stays empty when cleared — no snap-back to the default while typing', () => {
    const { input, onChange } = renderInput({ initial: 5000, fallback: 5000 })
    type(input, '')
    // The committed value must not be touched while the field is empty.
    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('')
  })

  it('backfills the fallback on blur when left empty', () => {
    const { input, onChange } = renderInput({ initial: 6000, fallback: 5000 })
    type(input, '')
    blur(input)
    expect(onChange).toHaveBeenCalledWith(5000)
    expect(input.value).toBe('5000')
  })

  it('falls back to min when no fallback is given and the field is cleared', () => {
    const { input, onChange } = renderInput({ initial: 20, min: 1, max: 100 })
    type(input, '')
    blur(input)
    expect(onChange).toHaveBeenCalledWith(1)
  })

  it('replaces garbage with the fallback on blur', () => {
    const { input, onChange } = renderInput({ initial: 10, fallback: 3 })
    type(input, '-')
    expect(onChange).not.toHaveBeenCalled()
    blur(input)
    expect(onChange).toHaveBeenCalledWith(3)
    expect(input.value).toBe('3')
  })

  it('clamps the committed value to [min, max] on blur', () => {
    const { input, onChange } = renderInput({ initial: 20, min: 1, max: 50 })
    type(input, '999')
    blur(input)
    expect(onChange).toHaveBeenLastCalledWith(50)
    expect(input.value).toBe('50')
  })

  it('does not patch again on blur when the committed value is unchanged', () => {
    const { input, onChange } = renderInput({ initial: 5 })
    type(input, '8')
    blur(input)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('selects the whole value on focus so a backfilled default can be typed over', () => {
    const { input } = renderInput({ initial: 1 })
    // jsdom returns null selectionStart for number inputs, so observe the
    // select() call itself (real browsers then highlight the full value).
    const select = vi.spyOn(input, 'select')
    act(() => {
      // React delegates focus through the bubbling focusin event.
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(select).toHaveBeenCalled()
    select.mockRestore()
  })
})
