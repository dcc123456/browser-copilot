// @vitest-environment jsdom
/**
 * The picker's press interception, driven by the REAL injected function.
 *
 * The reported bug: on a popover that closes when you click outside it, the
 * picker's own click closed the popover first — click-outside runs on
 * pointerdown/mousedown, which precede any click-level guard. So these rows
 * pin the three halves of the fix: the page never sees the press, the lock
 * comes from pointerdown (not the trailing click), and Enter commits without
 * pressing at all.
 *
 * jsdom keeps one document per file, so every row tears the picker down with
 * Escape (its own `cleanup` is what unbinds the window listeners) and removes
 * its control listeners explicitly.
 *
 * @module tests/element-picker
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startPicker, type PickerArgs } from '../src/inpage/element-picker'

const PAGE = `
  <div id="shop">
    <button id="buy" class="cta">Buy</button>
    <div id="blank"></div>
  </div>
`

let sent: Record<string, unknown>[] = []

beforeAll(() => {
  // The injected body reports back through chrome.runtime; the test only needs
  // to see which messages it sent, in order.
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: (message: Record<string, unknown>) => {
        sent.push(message)
        return Promise.resolve()
      },
    },
  }
})

/** Control listeners, so the page's side of every assertion is torn down too. */
const bound: { target: EventTarget; type: string; fn: EventListener; capture: boolean }[] = []
function onPage(target: EventTarget, type: string, fn: EventListener, capture = true): void {
  target.addEventListener(type, fn, capture)
  bound.push({ target, type, fn, capture })
}

async function mount(args: Partial<PickerArgs> = {}): Promise<void> {
  await startPicker({ pickerId: 'p1', mode: 'select', ...args })
}

const card = () => document.getElementById('bc-element-picker')?.shadowRoot
const field = (sel: string) => card()?.querySelector(sel) as HTMLElement
const selectorText = () => field('[data-role="selector"]').textContent
const hintText = () => field('[data-role="hint"]').textContent
const hintShown = () => field('[data-role="hint"]').style.display === 'block'
const confirmBtn = () => field('[data-act="confirm"]') as HTMLButtonElement

function dispatchPointer(el: Element): PointerEvent {
  const event = new PointerEvent('pointerdown', {
    bubbles: true,
    composed: true,
    cancelable: true,
    clientX: 5,
    clientY: 5,
  })
  el.dispatchEvent(event)
  return event
}
function dispatchMouse(el: Element, type: 'mousedown' | 'mouseup' | 'click' | 'mousemove') {
  const event = new MouseEvent(type, {
    bubbles: true,
    composed: true,
    cancelable: true,
    clientX: 5,
    clientY: 5,
  })
  el.dispatchEvent(event)
  return event
}
function dispatchKey(key: string, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    composed: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
  return event
}
/** The full gesture one real click produces, in DOM order. */
function clickGesture(el: Element): MouseEvent {
  dispatchPointer(el)
  dispatchMouse(el, 'mousedown')
  dispatchMouse(el, 'mouseup')
  return dispatchMouse(el, 'click')
}

const results = () => sent.filter((message) => message.type === 'picker:result')

beforeEach(() => {
  document.body.innerHTML = PAGE
  sent = []
})

afterEach(() => {
  dispatchKey('Escape')
  for (const entry of bound.splice(0)) {
    entry.target.removeEventListener(entry.type, entry.fn, entry.capture)
  }
  document.getElementById('bc-element-picker')?.remove()
  document.body.innerHTML = ''
})

describe('element picker: the page never sees the pick', () => {
  it('swallows pointerdown, mousedown and click before any page handler', async () => {
    await mount()
    const pageSaw: string[] = []
    // Registered AFTER the picker on purpose: window capture precedes these
    // nodes on the path, so nothing here runs regardless of bind order.
    onPage(document, 'pointerdown', () => pageSaw.push('pointerdown'))
    onPage(document, 'mousedown', () => pageSaw.push('mousedown'))
    onPage(document, 'click', () => pageSaw.push('click'))
    onPage(document.getElementById('buy')!, 'click', () => pageSaw.push('target'), false)

    const click = clickGesture(document.getElementById('buy')!)

    expect(pageSaw).toEqual([])
    expect(click.defaultPrevented).toBe(true)
    expect(selectorText()).toBe('#buy')
  })

  it('leaves mousemove and mouseup to the page, as the card drag needs them', async () => {
    await mount()
    const pageSaw: string[] = []
    onPage(document, 'mousemove', () => pageSaw.push('mousemove'))
    onPage(document, 'mouseup', () => pageSaw.push('mouseup'))
    const buy = document.getElementById('buy')!

    dispatchMouse(buy, 'mousemove')
    dispatchPointer(buy)
    dispatchMouse(buy, 'mouseup')

    expect(pageSaw).toEqual(['mousemove', 'mouseup'])
    expect(selectorText()).toBe('#buy')
  })

  it('locks on pointerdown, and the trailing click cannot re-aim it', async () => {
    await mount()
    const buy = document.getElementById('buy')!
    const blank = document.getElementById('blank')!

    dispatchPointer(buy)
    expect(selectorText()).toBe('#buy')

    // A click delivered elsewhere by the time the gesture lands (the page
    // moved under the cursor) must not change what the press aimed at.
    const click = dispatchMouse(blank, 'click')
    expect(click.defaultPrevented).toBe(true)
    expect(selectorText()).toBe('#buy')

    // A fresh press does re-aim.
    dispatchPointer(blank)
    expect(selectorText()).toBe('#blank')
  })

  it('still locks a click that carries no press', async () => {
    await mount()

    dispatchMouse(document.getElementById('buy')!, 'click')

    expect(selectorText()).toBe('#buy')
  })
})

describe('element picker: committing without pressing', () => {
  it('sends picker:result once on Enter', async () => {
    await mount()
    dispatchMouse(document.getElementById('buy')!, 'mousemove')
    expect(confirmBtn().disabled).toBe(false)

    const enter = dispatchKey('Enter')

    expect(enter.defaultPrevented).toBe(true)
    expect(results()).toEqual([
      {
        type: 'picker:result',
        pickerId: 'p1',
        selector: '#buy',
        findBy: 'cssSelector',
        multiple: false,
      },
    ])
    expect(document.getElementById('bc-element-picker')).toBeNull()
  })

  it('does not commit while nothing is aimed', async () => {
    await mount()

    dispatchKey('Enter')

    expect(sent).toEqual([])
    expect(document.getElementById('bc-element-picker')).not.toBeNull()
  })

  it('leaves a card-focused Enter to the button itself', async () => {
    await mount()
    dispatchMouse(document.getElementById('buy')!, 'mousemove')

    // The button's native activation also fires on Enter; handling it here too
    // would send the result twice.
    const enter = dispatchKey('Enter', confirmBtn())

    expect(enter.defaultPrevented).toBe(false)
    expect(results()).toEqual([])
  })

  it('keeps the card reachable: a click inside it commits through its own handler', async () => {
    await mount()
    dispatchMouse(document.getElementById('buy')!, 'mousemove')

    const click = dispatchMouse(confirmBtn(), 'click')

    expect(click.defaultPrevented).toBe(false)
    expect(results()).toHaveLength(1)
  })

  it('cancels on Escape and lets the page breathe again', async () => {
    await mount()

    dispatchKey('Escape')

    expect(sent).toEqual([{ type: 'picker:cancel', pickerId: 'p1' }])
    expect(document.getElementById('bc-element-picker')).toBeNull()
    // Bound listeners are gone, so a later press belongs to the page.
    const click = dispatchMouse(document.getElementById('buy')!, 'click')
    expect(click.defaultPrevented).toBe(false)
  })
})

const GROUP_PAGE = `
  <div id="list">
    <div class="row"><button class="pick">One</button></div>
    <div class="row"><button class="pick">Two</button></div>
    <div class="row"><button class="pick">Three</button></div>
  </div>
`
const groupButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button.pick'))
const matchNav = () => field('[data-role="matchnav"]')
const matchLabel = () => field('[data-role="matchlabel"]').textContent

describe('element picker: choosing which match', () => {
  beforeEach(() => {
    document.body.innerHTML = GROUP_PAGE
  })

  it('pins the aimed match when the short selector matches several', async () => {
    await mount()
    const buttons = groupButtons()

    dispatchMouse(buttons[1]!, 'mousemove')

    const pinned = selectorText()!
    const found = document.querySelectorAll(pinned)
    expect(found).toHaveLength(1)
    expect(found[0]).toBe(buttons[1])
    expect(matchNav().style.display).toBe('flex')
    expect(matchLabel()).toBe('Match 2 of 3')
    expect(field('[data-role="count"]').textContent).toContain('Matches 3 elements')
  })

  it('steps to another match and commits the pinned selector', async () => {
    await mount()
    const buttons = groupButtons()
    dispatchMouse(buttons[0]!, 'mousemove')
    expect(matchLabel()).toBe('Match 1 of 3')

    dispatchMouse(field('[data-act="next-match"]'), 'click')
    expect(matchLabel()).toBe('Match 2 of 3')
    const pinned = selectorText()!
    expect(document.querySelectorAll(pinned)[0]).toBe(buttons[1])

    dispatchMouse(field('[data-act="prev-match"]'), 'click')
    dispatchMouse(field('[data-act="prev-match"]'), 'click')
    expect(matchLabel()).toBe('Match 3 of 3') // wraps backwards

    dispatchMouse(field('[data-act="next-match"]'), 'click') // back to 1
    const committed = selectorText()!
    dispatchKey('Enter')

    const [result] = results()
    expect(result!.selector).toBe(committed)
    expect(document.querySelectorAll(committed)[0]).toBe(buttons[0])
  })

  it('keeps the broad selector when the block acts on every match', async () => {
    await mount({ multiple: true })
    const buttons = groupButtons()

    dispatchMouse(buttons[1]!, 'mousemove')

    expect(matchNav().style.display).toBe('none')
    const broad = selectorText()!
    expect(document.querySelectorAll(broad)).toHaveLength(3)
    expect(field('[data-role="count"]').textContent).toContain('Matches 3 elements')
  })

  it('renders the stepper in the editor locale', async () => {
    await mount({ locale: 'zh' })

    dispatchMouse(groupButtons()[1]!, 'mousemove')

    expect(matchLabel()).toBe('第 2 / 3 个匹配')
    expect(field('[data-role="count"]').textContent).toContain('匹配 3 个元素')
    expect(field('[data-act="next-match"]').title).toBe('下一个匹配')
  })
})

describe('element picker: the click-free hint', () => {
  it('appears with the first element aimed at', async () => {
    await mount()
    expect(hintShown()).toBe(false)

    dispatchMouse(document.getElementById('buy')!, 'mousemove')

    expect(hintShown()).toBe(true)
  })

  it('is in the locale the editor passed', async () => {
    await mount({ locale: 'zh' })
    dispatchMouse(document.getElementById('buy')!, 'mousemove')
    expect(hintText()).toContain('按 Enter')

    dispatchKey('Escape')
    document.getElementById('bc-element-picker')?.remove()
    await mount()
    dispatchMouse(document.getElementById('buy')!, 'mousemove')
    expect(hintText()).toContain('Press Enter')
  })
})
