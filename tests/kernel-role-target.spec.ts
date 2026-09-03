/**
 * `role` locator resolution (kernel).
 *
 * Kernel-built role specs carry the ARIA role in `role` and the accessible
 * name in `value`. But targets authored by a model (and persisted into
 * workflows saved from a conversation) sometimes carry ONLY the role name in
 * `value` — the observed replay failure was "No element matched. Tried:
 * role|textbox". These tests pin both readings:
 *
 *  - `value` naming a known role with no `role` field → match by role;
 *  - `value` naming an accessible name with `role` set → match by name+role;
 *  - `value` naming an accessible name with no `role` field → match by name
 *    (the role check must not skip every element when `role` is absent).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import { runOp } from '../src/inpage/kernel'
import type { Op, Target } from '../src/lib/ops'

let dom: JSDOM
let input: HTMLInputElement

function makePage(): void {
  dom = new JSDOM(
    `<!DOCTYPE html><body>
       <input id="captcha" type="text" />
       <button id="login">Login</button>
     </body>`,
    { url: 'https://test.example/form', pretendToBeVisual: true },
  )
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.self = dom.window
  g.top = dom.window
  g.document = dom.window.document
  g.location = dom.window.location
  g.HTMLElement = dom.window.HTMLElement
  g.HTMLInputElement = dom.window.HTMLInputElement
  g.HTMLButtonElement = dom.window.HTMLButtonElement
  g.HTMLAnchorElement = dom.window.HTMLAnchorElement
  g.HTMLSelectElement = dom.window.HTMLSelectElement
  g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  g.HTMLFormElement = dom.window.HTMLElement
  g.ShadowRoot = dom.window.ShadowRoot
  g.DocumentFragment = dom.window.DocumentFragment
  g.MouseEvent = dom.window.MouseEvent
  g.PointerEvent = dom.window.PointerEvent
  g.Event = dom.window.Event
  g.KeyboardEvent = dom.window.KeyboardEvent
  g.InputEvent = dom.window.InputEvent
  g.CustomEvent = dom.window.CustomEvent
  g.Node = dom.window.Node
  g.Element = dom.window.Element
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  input = dom.window.document.getElementById('captcha') as HTMLInputElement
}

function roleTarget(primary: Target['primary'], ...fallbacks: Target['fallbacks']): Target {
  return { primary, fallbacks }
}

describe('kernel role locator', () => {
  beforeEach(makePage)

  it('resolves a model-authored "role|textbox" spec (role name in value, no role field)', () => {
    const op: Op = {
      action: 'fill',
      target: roleTarget({ how: 'role', value: 'textbox' }),
      value: 'AB12',
    }
    const result = runOp(op)
    expect(result.ok).toBe(true)
    expect(input.value).toBe('AB12')
  })

  it('resolves a value-as-role spec even among other fields, honoring nth', () => {
    const second = dom.window.document.createElement('input')
    second.type = 'text'
    second.id = 'second'
    dom.window.document.body.appendChild(second)

    const fill: Op = {
      action: 'fill',
      target: roleTarget({ how: 'role', value: 'textbox', nth: 1 }),
      value: 'x',
    }
    const result = runOp(fill)
    expect(result.ok).toBe(true)
    expect((dom.window.document.getElementById('second') as HTMLInputElement).value).toBe('x')
  })

  it('still matches accessible name + role for kernel-built specs', () => {
    const op: Op = {
      action: 'click',
      target: roleTarget({ how: 'role', value: 'Login', role: 'button' }),
    }
    const result = runOp(op)
    expect(result.ok).toBe(true)
    expect(result.usedSpec).toBe('role|Login|role=button')
  })

  it('matches by accessible name when no role field and value is not a role token', () => {
    const op: Op = {
      action: 'click',
      target: roleTarget({ how: 'role', value: 'Login' }),
    }
    const result = runOp(op)
    expect(result.ok).toBe(true)
  })

  it('still fails when nothing matches', () => {
    const op: Op = {
      action: 'fill',
      target: roleTarget({ how: 'role', value: 'no-such-thing' }),
      value: 'x',
    }
    const result = runOp(op)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No element matched')
  })
})
