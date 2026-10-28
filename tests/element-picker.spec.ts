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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  document.getElementById('bc-element-picker-toast')?.remove()
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

describe('element picker: text find-by', () => {
  const findby = () => field('[data-role="findby"]') as HTMLSelectElement

  it('fills the field with the aimed element text and commits findBy text', async () => {
    await mount({ findBy: 'text' })

    dispatchMouse(document.getElementById('buy')!, 'mousemove')

    expect(selectorText()).toBe('Buy')
    expect(field('[data-role="count"]').textContent).toContain('Matches 1 element')
    expect(confirmBtn().disabled).toBe(false)

    dispatchKey('Enter')

    expect(results()).toEqual([
      {
        type: 'picker:result',
        pickerId: 'p1',
        selector: 'Buy',
        findBy: 'text',
        multiple: false,
      },
    ])
  })

  it('counts every element rendering the same text', async () => {
    document.body.innerHTML = `
      <ul><li><button class="pick">Buy</button></li><li><button class="pick">Buy</button></li></ul>
    `
    await mount({ findBy: 'text' })

    dispatchMouse(document.querySelectorAll('button.pick')[1]!, 'mousemove')

    expect(selectorText()).toBe('Buy')
    expect(field('[data-role="count"]').textContent).toContain('Matches 2 elements')
  })

  it('rewrites the field when the card switches to text', async () => {
    await mount()
    dispatchMouse(document.getElementById('buy')!, 'mousemove')
    expect(selectorText()).toBe('#buy')

    findby().value = 'text'
    findby().dispatchEvent(new Event('change'))

    expect(selectorText()).toBe('Buy')
    expect(confirmBtn().disabled).toBe(false)
  })

  it('shows the no-text placeholder and refuses to commit', async () => {
    document.body.innerHTML = '<button id="empty"></button>'
    await mount({ findBy: 'text' })

    dispatchMouse(document.getElementById('empty')!, 'mousemove')

    expect(selectorText()).toBe('(no visible text)')
    expect(confirmBtn().disabled).toBe(true)
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

describe('element picker: verify outlines the matches', () => {
  const boxes = () => card()!.querySelectorAll('.pick-verify-box')
  const toast = () => card()!.querySelector('.pick-verify-toast') as HTMLElement
  const mountVerify = (args: Partial<PickerArgs> = {}) =>
    startPicker({ pickerId: 'v1', mode: 'verify', selector: '.pick', ...args })
  /** Past the picker's hold; the exact constant is private to the injected fn. */
  const HOLD_MS = 5000

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = GROUP_PAGE
  })

  afterEach(() => {
    // Settle a still-open verify overlay before the faked clock is restored,
    // so its key listener and timer do not leak into the next row.
    dispatchKey('Escape')
    vi.useRealTimers()
  })

  it('outlines every match and answers only after the hold', async () => {
    await mountVerify()

    expect(boxes()).toHaveLength(3)
    expect(toast().textContent).toContain('3 elements match')
    expect(toast().classList.contains('is-error')).toBe(false)
    expect(results()).toEqual([])

    await vi.advanceTimersByTimeAsync(HOLD_MS)

    expect(results()).toEqual([
      {
        type: 'picker:result',
        pickerId: 'v1',
        selector: '.pick',
        count: 3,
        verified: true,
      },
    ])
    expect(document.getElementById('bc-element-picker')).toBeNull()
  })

  it('lets Escape answer early with the count', async () => {
    await mountVerify({ locale: 'zh' })

    expect(toast().textContent).toContain('匹配到 3 个元素')
    expect(toast().textContent).toContain('按 Esc 关闭')

    dispatchKey('Escape')

    expect(results()).toHaveLength(1)
    expect(results()[0]!.count).toBe(3)
    expect(document.getElementById('bc-element-picker')).toBeNull()
  })

  it('shows the miss state and answers zero', async () => {
    await mountVerify({ selector: '.nope' })

    expect(boxes()).toHaveLength(0)
    expect(toast().classList.contains('is-error')).toBe(true)
    expect(toast().textContent).toContain('Element not found')

    await vi.advanceTimersByTimeAsync(HOLD_MS)

    expect(results()).toEqual([
      { type: 'picker:result', pickerId: 'v1', selector: '.nope', count: 0, verified: true },
    ])
  })

  it('counts XPath through the same root walk', async () => {
    await mountVerify({ selector: '//button[@class="pick"]', findBy: 'xpath' })

    expect(boxes()).toHaveLength(3)

    await vi.advanceTimersByTimeAsync(HOLD_MS)

    expect(results()[0]!.count).toBe(3)
  })

  it('counts text through the tightest holder, not its containers', async () => {
    await mountVerify({ selector: 'Two', findBy: 'text' })

    // The row and the list also *contain* "Two"; only the button holds it
    // without a deeper holder, so exactly one box is drawn.
    expect(boxes()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(HOLD_MS)

    expect(results()[0]!.count).toBe(1)
  })
})

describe('element picker: copy mode copies on the click', () => {
  const mountCopy = (args: Partial<PickerArgs> = {}) =>
    startPicker({ pickerId: 'h1', mode: 'copy', ...args })
  const pickCard = () => card()?.querySelector('.pick-card') as HTMLElement
  const highlight = () => card()?.querySelector('.pick-highlight') as HTMLElement
  let copied = ''
  let execCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    copied = ''
    execCommand = vi.fn(() => {
      // Read inside the call: the helper removes its textarea before returning.
      copied = (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? ''
      return true
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: execCommand,
    })
  })

  afterEach(() => {
    document.getElementById('bc-element-picker-toast')?.remove()
    Reflect.deleteProperty(document, 'execCommand')
  })

  it('shows no card, only the dim overlay and the highlight', async () => {
    await mountCopy()

    expect(document.getElementById('bc-element-picker')).not.toBeNull()
    expect(pickCard().style.display).toBe('none')
    expect(card()?.querySelector('.pick-overlay')).not.toBeNull()

    dispatchMouse(document.getElementById('buy')!, 'mousemove')
    expect(highlight().style.display).toBe('block')
  })

  it('copies the clicked element, reports it and closes without letting the page see the press', async () => {
    await mountCopy()
    const pageSaw: string[] = []
    onPage(document, 'click', () => pageSaw.push('click'))
    const shop = document.getElementById('shop')!
    onPage(shop, 'click', () => pageSaw.push('shop'), false)

    clickGesture(shop)

    expect(copied).toBe(shop.outerHTML)
    expect(copied).toContain('<button id="buy"')
    expect(pageSaw).toEqual([])
    expect(document.getElementById('bc-element-picker')).toBeNull()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'picker:selection',
      selection: {
        selector: '#shop',
        tag: 'div',
        text: 'Buy',
        html: shop.outerHTML,
        url: location.href,
        title: document.title,
      },
    })
    const toast = document.getElementById('bc-element-picker-toast')
    expect(toast?.shadowRoot?.textContent).toContain('Copied')
    expect(toast?.shadowRoot?.textContent).toContain('chars')
  })

  it('copies only a CSS selector that resolves to the element', async () => {
    await mountCopy({ copyFormat: 'selector' })

    clickGesture(document.getElementById('shop')!)

    expect(copied).toBe('#shop')
    expect(document.querySelectorAll(copied)).toHaveLength(1)
    const toast = document.getElementById('bc-element-picker-toast')
    expect(toast?.shadowRoot?.textContent).toContain('CSS selector')
  })

  it('copies only the visible text', async () => {
    await mountCopy({ copyFormat: 'text' })

    clickGesture(document.getElementById('buy')!)

    expect(copied).toBe('Buy')
    const toast = document.getElementById('bc-element-picker-toast')
    expect(toast?.shadowRoot?.textContent).toContain('<button> text')
  })

  it('copies large HTML untouched — the card that warned about it is gone', async () => {
    document.body.innerHTML = '<div id="huge"></div>'
    document.getElementById('huge')!.textContent = 'x'.repeat(120_000)
    await mountCopy()

    clickGesture(document.getElementById('huge')!)

    expect(copied.length).toBeGreaterThan(120_000)
    expect(document.getElementById('bc-element-picker')).toBeNull()
  })

  it('closes with an error toast when the browser refuses the copy, still reporting the element', async () => {
    execCommand.mockReturnValueOnce(false)
    await mountCopy()

    clickGesture(document.getElementById('shop')!)

    expect(document.getElementById('bc-element-picker')).toBeNull()
    const toast = document.getElementById('bc-element-picker-toast')
    expect(toast?.shadowRoot?.textContent).toContain('Copy failed')
    expect(toast?.shadowRoot?.querySelector('.toast')?.classList.contains('is-error')).toBe(true)
    // The pick is what the agent acts on; a refused clipboard must not erase it.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'picker:selection' })
  })

  it('closes without messaging an editor', async () => {
    await mountCopy()

    dispatchKey('Escape')

    expect(sent).toEqual([])
    expect(document.getElementById('bc-element-picker')).toBeNull()
  })

  it('hides the page launcher while picking and restores it afterwards', async () => {
    const launcher = document.createElement('div')
    launcher.id = 'bc-element-picker-launcher'
    document.documentElement.appendChild(launcher)

    await mountCopy()
    // `visibility` keeps the launcher's box so a floating window it is docked
    // into does not resize while picking.
    expect(launcher.style.visibility).toBe('hidden')

    dispatchKey('Escape')
    expect(launcher.style.visibility).toBe('')

    launcher.remove()
  })

  it('localizes the copy toast', async () => {
    await mountCopy({ locale: 'zh' })

    clickGesture(document.getElementById('shop')!)

    const toast = document.getElementById('bc-element-picker-toast')
    expect(toast?.shadowRoot?.textContent).toContain('已复制')
  })
})

describe('element picker: select-only copy mode', () => {
  const mountSelectOnly = (args: Partial<PickerArgs> = {}) =>
    startPicker({ pickerId: 'h2', mode: 'copy', selectOnly: true, ...args })
  const pickCard = () => card()?.querySelector('.pick-card') as HTMLElement
  const highlight = () => card()?.querySelector('.pick-highlight') as HTMLElement
  let copied = ''
  let execCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    copied = ''
    execCommand = vi.fn(() => {
      copied = (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? ''
      return true
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: execCommand,
    })
  })

  afterEach(() => {
    document.getElementById('bc-element-picker-toast')?.remove()
    Reflect.deleteProperty(document, 'execCommand')
  })

  it('selects on the first click without copying, keeping the highlight and the page intact', async () => {
    await mountSelectOnly()
    const pageSaw: string[] = []
    onPage(document, 'click', () => pageSaw.push('click'))
    const buy = document.getElementById('buy')!
    onPage(buy, 'click', () => pageSaw.push('buy'), false)

    clickGesture(buy)

    expect(execCommand).not.toHaveBeenCalled()
    expect(copied).toBe('')
    expect(pageSaw).toEqual([])
    expect(document.getElementById('bc-element-picker')).not.toBeNull()
    expect(pickCard().style.display).toBe('none')
    expect(highlight().style.display).toBe('block')
    expect(document.getElementById('bc-element-picker-toast')).toBeNull()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'picker:selection',
      selection: { selector: '#buy', tag: 'button', id: 'buy', text: 'Buy' },
    })
  })

  it('keeps the selection while the mouse moves, then dismisses on the next click', async () => {
    await mountSelectOnly()
    const pageSaw: string[] = []
    onPage(document, 'click', () => pageSaw.push('click'))

    clickGesture(document.getElementById('buy')!)
    dispatchMouse(document.getElementById('shop')!, 'mousemove')

    expect(highlight().style.display).toBe('block')
    expect(sent).toHaveLength(1)

    clickGesture(document.getElementById('shop')!)

    expect(document.getElementById('bc-element-picker')).toBeNull()
    expect(pageSaw).toEqual([])
    expect(execCommand).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })

  it('selects with Enter, then dismisses with the next Enter, never pressing the page', async () => {
    await mountSelectOnly()
    const pageSaw: string[] = []
    onPage(document, 'keydown', () => pageSaw.push('keydown'))

    dispatchMouse(document.getElementById('buy')!, 'mousemove')
    dispatchKey('Enter')

    expect(document.getElementById('bc-element-picker')).not.toBeNull()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'picker:selection' })
    expect(execCommand).not.toHaveBeenCalled()

    dispatchKey('Enter')

    expect(document.getElementById('bc-element-picker')).toBeNull()
    expect(pageSaw).toEqual([])
  })

  it('cancels on Escape without copying or reporting', async () => {
    await mountSelectOnly()

    dispatchKey('Escape')

    expect(copied).toBe('')
    expect(sent).toEqual([])
    expect(document.getElementById('bc-element-picker')).toBeNull()
  })

  it('dismisses with Escape after selecting, keeping the single report', async () => {
    await mountSelectOnly()
    clickGesture(document.getElementById('buy')!)
    expect(sent).toHaveLength(1)

    dispatchKey('Escape')

    expect(document.getElementById('bc-element-picker')).toBeNull()
    expect(execCommand).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'picker:selection' })
  })
})
