/**
 * Workflow recorder — injected into pages while recording.
 *
 * SELF-CONTAINED like kernel.ts / element-picker: injected via
 * chrome.scripting.executeScript({ func }), so no imports and no closures over
 * outer scope. Listeners are attached in capture mode and send normalized
 * "flow" entries to the background via chrome.runtime.sendMessage.
 *
 * Event classification mirrors Automa's recordEvents.js:
 *   - <a href> click        -> `link` block (automa link/new-tab navigation)
 *   - button / submit click  -> `event-click`
 *   - text input/change      -> `forms` (type text)
 *   - select change          -> `forms` (type select)
 *   - checkbox/radio click   -> `forms` (type checkbox/radio)
 *   - special keydown        -> `press-key`
 *   - scroll (throttled)     -> `element-scroll`
 *
 * @module inpage/record
 */

export interface RecorderArgs {
  recording: boolean
}

type RecorderStart = (args: RecorderArgs) => void

/** Entry injected into every frame. Installs listeners when recording. */
export const startRecorder: RecorderStart = (args) => {
  const w = window as Window & { __bcRecorder?: { stop: () => void } }
  // Idempotent: remove any prior instance first.
  if (w.__bcRecorder) {
    w.__bcRecorder.stop()
  }
  if (!args.recording) {
    return
  }

  // --- selector builder (inlined; mirrors build-selector.ts) ----------------
  const esc = (v: string) =>
    typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/([^a-zA-Z0-9_-])/g, '\\$1')
  function partOf(el: Element): string {
    const tag = el.tagName.toLowerCase()
    if (el.id) return `#${esc(el.id)}`
    let q = ''
    if (el.classList.length) {
      q += Array.from(el.classList)
        .filter((c) => c && !/^(css-|jsx-|sc-|ng-|ember)/.test(c) && !/^\d/.test(c))
        .slice(0, 2)
        .map((c) => `.${esc(c)}`)
        .join('')
    }
    const pEl = el.parentElement
    if (pEl) {
      const sib = Array.from(pEl.children).filter((c) => (c as Element).tagName === el.tagName)
      if (sib.length > 1) q += `:nth-of-type(${sib.indexOf(el) + 1})`
    }
    return tag + q
  }
  // Open shadow roots to query across (excluding our own recorder bar / picker
  // hosts, whose shadow roots are extension UI rather than page content).
  const openRoots = (): ParentNode[] => {
    const roots: ParentNode[] = [document]
    const visit = (root: ParentNode): void => {
      const list = root.querySelectorAll('*')
      for (let i = 0; i < list.length; i += 1) {
        const h = list[i] as Element
        if (h.id === 'bc-element-picker' || h.id === 'bc-recorder-bar') continue
        const sr = (h as HTMLElement).shadowRoot
        if (sr && sr.nodeType === 11) { roots.push(sr); visit(sr) }
      }
    }
    visit(document)
    return roots
  }
  const countInRoots = (sel: string): { count: number; matches: Element[] } => {
    let count = 0
    const matches: Element[] = []
    try {
      for (const root of openRoots()) {
        const ms = root.querySelectorAll(sel)
        count += ms.length
        ms.forEach((m) => matches.push(m))
      }
    } catch {
      /* invalid selector */
    }
    return { count, matches }
  }
  function selectorFor(el: Element): string {
    const direct = partOf(el)
    if (direct.startsWith('#') && countInRoots(direct).count === 1) return direct
    const chain = [direct]
    let node: Element | null = el.parentElement
    let depth = 0
    while (node && depth < 5) {
      const cand = chain.slice().reverse().join(' > ')
      const { count, matches } = countInRoots(cand)
      if (count === 1 && matches[0] === el) return cand
      chain.push(partOf(node))
      node = node.parentElement
      depth++
    }
    return chain.slice().reverse().join(' > ')
  }

  const send = (flow: { blockId: string; [k: string]: unknown }) => {
    try {
      void chrome.runtime.sendMessage({ type: 'record:event', flow })
    } catch {
      /* extension context may be gone during navigation */
    }
  }

  const TEXT_INPUTS = ['text', 'email', 'password', 'search', 'tel', 'url', 'number', '']
  let lastScroll = 0

  function isEditable(el: Element): el is HTMLInputElement {
    if (el.tagName === 'TEXTAREA') return true
    if (el.tagName === 'INPUT') {
      const t = (el as HTMLInputElement).type.toLowerCase()
      return TEXT_INPUTS.includes(t)
    }
    return (el as HTMLElement).isContentEditable === true
  }

  // --- Text-field recording -------------------------------------------------
  // Automa attaches the element's selector on focus, then listens for `input`
  // (debounced). Relying on `change` alone misses fields the user submits via
  // Enter / button without blurring (the context is torn down before change
  // fires), so we record on input, on Enter and on change, deduping per field.
  const TEXT_PENDING = new Map<Element, { selector: string; name: string; timer: ReturnType<typeof setTimeout> | null }>()

  /**
   * The last text-field value recorded PER FIELD, keyed by element. One physical
   * fill of a field reaches us through up to four paths — the debounced `input`,
   * an Enter commit, the `focusout` flush, and the trailing `change` event — and
   * without this they each emitted a separate `forms` block, duplicating the
   * node. We only emit a block when the field's value differs from the last one
   * we recorded for that same element, so a single fill yields one node while
   * genuinely distinct values are still kept.
   */
  const LAST_TEXT_SENT = new WeakMap<Element, string>()

  function textFieldValue(el: Element): string {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return (el as HTMLInputElement).value
    return (el as HTMLElement).innerText ?? ''
  }
  function textFieldName(el: Element): string {
    const ae = el.getAttribute('aria-label')
    if (ae) return ae
    const nm = el.getAttribute('name')
    return nm ?? ''
  }

  /** Build the `forms` text-field flow for an element once. */
  function formsFlowFor(el: Element, selector: string, name: string) {
    return {
      blockId: 'forms',
      selector,
      findBy: 'cssSelector',
      type: 'text-field',
      value: textFieldValue(el),
      clearValue: true,
      delay: 100,
      waitForSelector: true,
      waitSelectorTimeout: 5000,
      description: name ? `Text field (${name.slice(0, 12)})` : 'Text field',
    }
  }

  /** Emit a text-field `forms` block, skipping a repeat of the last value. */
  function sendFormsText(el: Element, selector: string, name: string): void {
    const value = textFieldValue(el)
    if (LAST_TEXT_SENT.get(el) === value) return
    LAST_TEXT_SENT.set(el, value)
    send(formsFlowFor(el, selector, name))
  }

  function recordText(el: Element, immediate: boolean) {
    if (!isEditable(el)) return
    const selector = (el as HTMLElement).dataset.__bcSel ?? selectorFor(el)
    ;(el as HTMLElement).dataset.__bcSel = selector
    const name = textFieldName(el)
    if (immediate) {
      const pending = TEXT_PENDING.get(el)
      if (pending?.timer) clearTimeout(pending.timer)
      TEXT_PENDING.delete(el)
      sendFormsText(el, selector, name)
      return
    }
    const existing = TEXT_PENDING.get(el)
    if (existing?.timer) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      TEXT_PENDING.delete(el)
      sendFormsText(el, selector, name)
    }, 400)
    TEXT_PENDING.set(el, { selector, name, timer })
  }

  function onFocusIn(e: FocusEvent) {
    const el = eventTarget(e)
    if (!el || isOurUi(el) || !isEditable(el)) return
    ;(el as HTMLElement).dataset.__bcSel = selectorFor(el)
    el.addEventListener('input', onInputField, true)
  }
  function onFocusOut(e: FocusEvent) {
    const el = eventTarget(e)
    if (!el || !isEditable(el)) return
    el.removeEventListener('input', onInputField, true)
    // Flush any pending typing into a forms block before the field loses focus.
    const pending = TEXT_PENDING.get(el)
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer)
      TEXT_PENDING.delete(el)
    }
    // Either flush the pending value or, if nothing was debounced, still emit
    // the blur value — sendFormsText de-dupes against the last recorded value,
    // so this never duplicates the block a debounced/Enter path already sent.
    sendFormsText(el, pending?.selector ?? (el as HTMLElement).dataset.__bcSel ?? selectorFor(el), pending?.name ?? textFieldName(el))
  }
  function onInputField(e: Event) {
    const el = eventTarget(e)
    if (el && isEditable(el)) recordText(el, false)
  }

  function onClick(e: MouseEvent) {
    const el = eventTarget(e)
    if (!el || isOurUi(el)) return

    // Anchor -> link block.
    const anchor = el.closest('a[href]') as HTMLAnchorElement | null
    if (anchor) {
      send({
        blockId: 'link',
        selector: selectorFor(anchor),
        findBy: 'cssSelector',
        waitForSelector: true,
        waitSelectorTimeout: 5000,
        description: anchor.textContent?.trim().slice(0, 40) ?? '',
      })
      return
    }

    // Checkbox / radio -> forms.
    const input = el.closest('input') as HTMLInputElement | null
    if (input && (input.type === 'checkbox' || input.type === 'radio')) {
      send({
        blockId: 'forms',
        selector: selectorFor(input),
        findBy: 'cssSelector',
        type: input.type,
        value: input.type === 'checkbox' ? input.checked : input.value,
        waitForSelector: true,
        waitSelectorTimeout: 5000,
        description: input.name ?? '',
      })
      return
    }

    // Text fields are recorded via focus/input/blur, not on click.
    if (isEditable(el)) return

    // Everything else -> event click.
    send({
      blockId: 'event-click',
      selector: selectorFor(el),
      findBy: 'cssSelector',
      waitForSelector: true,
      waitSelectorTimeout: 5000,
      description: (el as HTMLElement).innerText?.trim().slice(0, 40) ?? el.tagName.toLowerCase(),
      button: e.button,
    })
  }

  function onChange(e: Event) {
    const el = eventTarget(e)
    if (!el || isOurUi(el)) return

    if (el.tagName === 'SELECT') {
      const sel = el as HTMLSelectElement
      send({
        blockId: 'forms',
        selector: selectorFor(sel),
        findBy: 'cssSelector',
        type: 'select',
        value: sel.value,
        delay: 100,
        waitForSelector: true,
        waitSelectorTimeout: 5000,
        description: sel.name ? `Element Name (${sel.name})` : '',
      })
      return
    }

    if (isEditable(el)) {
      // Text fields are recorded on input/Enter/blur; avoid a duplicate here.
      const pending = TEXT_PENDING.get(el)
      if (pending?.timer) clearTimeout(pending.timer)
      TEXT_PENDING.delete(el)
      recordText(el, true)
    }
  }

  // Special keys are recorded as press-key; printable characters within inputs
  // are captured via the forms block above.
  const SPECIAL_KEYS = new Set([
    'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' ',
  ])
  function onKeydown(e: KeyboardEvent) {
    const el = eventTarget(e)
    if (el && isOurUi(el)) return
    const typing = el ? isEditable(el) : false

    // Enter in a text field commits the typed value NOW (forms block), because
    // the form may submit and navigate before blur/change fires. Don't then
    // record Enter as a separate press-key inside a field.
    if (typing && e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      recordText(el as Element, true)
      return
    }

    // Record shortcuts (modifier combos) and navigation keys anywhere; only
    // record plain special keys when NOT typing in a field (those are part of
    // text entry, captured as forms).
    if (typing && !e.ctrlKey && !e.metaKey && !e.altKey && !SPECIAL_KEYS.has(e.key)) return
    if (typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== 'Enter' && e.key !== 'Tab' && e.key !== 'Escape') return
    const key = e.key === ' ' ? 'Space' : e.key
    send({
      blockId: 'press-key',
      key,
      modifiers: [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift']
        .filter(Boolean)
        .join('+'),
      description: [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift', key]
        .filter(Boolean)
        .join('+'),
    })
  }

  function onScroll() {
    const now = Date.now()
    if (now - lastScroll < 600) return
    lastScroll = now
    const el = document.scrollingElement || document.documentElement
    // Only record meaningful scroll of the page / a scrollable container under
    // the cursor path is complex; Automa records scroll-y of the window.
    send({
      blockId: 'element-scroll',
      selector: el.tagName === 'HTML' ? 'window' : selectorFor(el as Element),
      findBy: 'cssSelector',
      scrollY: Math.round(window.scrollY),
      description: `Scroll to ${Math.round(window.scrollY)}px`,
    })
  }

  /**
   * Deepest event target crossing OPEN shadow boundaries. Capture listeners
   * see a retargeted host for shadowed events, so e.target would record the
   * host instead of the button inside. composedPath()[0] is the real element
   * inside an open root; for a CLOSED root it is the host (unreachable in JS;
   * those interactions are driven via chrome.debugger, not recorded).
   */
  function eventTarget(e: Event): Element | null {
    const path = e.composedPath?.()
    const first = path && path[0]
    if (first && (first as Node).nodeType === 1) return first as Element
    return (e.target as Element | null) ?? null
  }

  function isOurUiEl(el: Element | null): boolean {
    if (!el) return false
    if (el.closest('#bc-element-picker, #bc-recorder-bar')) return true
    // Inside an open shadow root: walk the host chain (closest() does not
    // cross shadow boundaries).
    let root: Node = el.getRootNode ? el.getRootNode() : el.ownerDocument
    while (root && (root as ShadowRoot).nodeType === 11) {
      const host = (root as ShadowRoot).host
      if (host && host.closest('#bc-element-picker, #bc-recorder-bar')) return true
      root = host && host.getRootNode ? host.getRootNode() : host?.ownerDocument
    }
    return false
  }

  function isOurUi(el: Element): boolean {
    return isOurUiEl(el)
  }

  document.addEventListener('click', onClick, true)
  document.addEventListener('change', onChange, true)
  document.addEventListener('keydown', onKeydown, true)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })

  w.__bcRecorder = {
    stop() {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('change', onChange, true)
      document.removeEventListener('keydown', onKeydown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions)
      delete w.__bcRecorder
    },
  }
}
