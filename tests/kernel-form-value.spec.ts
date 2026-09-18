/**
 * `get_value` — reading ONE form control's live value (kernel).
 *
 * This op is what makes "read the value of an input" expressible without a
 * script, which is the most common reason a generated workflow used to reach
 * for `javascript-code`. The important properties:
 *
 *   - it reads the LIVE value, not the HTML `value` ATTRIBUTE (which stays at
 *     its default and would report stale content);
 *   - the shape follows the control: checkbox → boolean, multi-select → array,
 *     radio → its value only when selected;
 *   - a non-control is a precise error, not an empty string.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import { runOp } from '../src/inpage/kernel'
import type { Op, OpResult, Target } from '../src/lib/ops'

let dom: JSDOM

function cssTarget(selector: string): Target {
  return { primary: { how: 'css', value: selector }, fallbacks: [] }
}

function read(selector: string): OpResult {
  const op: Op = { action: 'get_value', target: cssTarget(selector) }
  return runOp(op)
}

beforeEach(() => {
  dom = new JSDOM(
    `<!DOCTYPE html><body>
      <input id="text" value="from-attribute">
      <textarea id="area">area text</textarea>
      <select id="single"><option value="a">A</option><option value="b" selected>B</option></select>
      <select id="multi" multiple>
        <option value="x" selected>X</option>
        <option value="y">Y</option>
        <option value="z" selected>Z</option>
      </select>
      <input type="checkbox" id="cb-on" checked>
      <input type="checkbox" id="cb-off">
      <input type="radio" name="r" id="r-off" value="off">
      <input type="radio" name="r" id="r-on" value="on" checked>
      <div id="editor" contenteditable="true">  rich  </div>
      <div id="plain">not a control</div>
    </body>`,
    { url: 'https://example.test/form', pretendToBeVisual: true },
  )
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.self = dom.window
  g.top = dom.window
  g.document = dom.window.document
  g.location = dom.window.location
  g.HTMLElement = dom.window.HTMLElement
  g.HTMLInputElement = dom.window.HTMLInputElement
  g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  g.HTMLSelectElement = dom.window.HTMLSelectElement
  g.HTMLOptionElement = dom.window.HTMLOptionElement
  g.Element = dom.window.Element
  g.Node = dom.window.Node
  g.Event = dom.window.Event
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
})

describe('kernel get_value', () => {
  it('reads the live value, not the value attribute', () => {
    const input = dom.window.document.getElementById('text') as HTMLInputElement
    input.value = 'typed just now'

    const result = read('#text')

    expect(result.ok).toBe(true)
    expect(result.data).toBe('typed just now')
    // The attribute is untouched — proving we did not read it by mistake.
    expect(input.getAttribute('value')).toBe('from-attribute')
  })

  it('reads a textarea and a contenteditable element', () => {
    expect(read('#area').data).toBe('area text')
    expect(read('#editor').data).toBe('rich')
  })

  it('reads a single select as its value and a multi select as an array', () => {
    expect(read('#single').data).toBe('b')
    expect(read('#multi').data).toEqual(['x', 'z'])
  })

  it('reads a checkbox as a boolean', () => {
    expect(read('#cb-on').data).toBe(true)
    expect(read('#cb-off').data).toBe(false)
  })

  it('reads a radio as its value only when it is the selected one', () => {
    expect(read('#r-on').data).toBe('on')
    // An unselected radio's value means nothing, so it is empty rather than
    // silently reporting a value the page is not using.
    expect(read('#r-off').data).toBe('')
  })

  it('fails with a precise message on something that has no value', () => {
    const result = read('#plain')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('has no value to read')
    expect(result.data).toBeUndefined()
  })

  it('reports a missing element as not found', () => {
    const result = read('#nope')

    expect(result.ok).toBe(false)
    expect(result.found).toBe(false)
  })
})
