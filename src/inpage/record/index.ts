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
  function selectorFor(el: Element): string {
    const direct = partOf(el)
    if (direct.startsWith('#') && document.querySelectorAll(direct).length === 1) return direct
    const chain = [direct]
    let node: Element | null = el.parentElement
    let depth = 0
    while (node && depth < 5) {
      const cand = chain.slice().reverse().join(' > ')
      const ms = document.querySelectorAll(cand)
      if (ms.length === 1 && ms[0] === el) return cand
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

  function onClick(e: MouseEvent) {
    const el = e.target as Element | null
    if (!el || isOurUi(el)) return

    // Anchor -> link block.
    const anchor = el.closest('a[href]') as HTMLAnchorElement | null
    if (anchor) {
      send({
        blockId: 'link',
        selector: selectorFor(anchor),
        findBy: 'cssSelector',
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
        description: input.name ?? '',
      })
      return
    }

    // Text fields (record on change/blur handled separately) skip here.
    if (isEditable(el)) return

    // Everything else -> event click.
    send({
      blockId: 'event-click',
      selector: selectorFor(el),
      findBy: 'cssSelector',
      description: (el as HTMLElement).innerText?.trim().slice(0, 40) ?? el.tagName.toLowerCase(),
      button: e.button,
    })
  }

  function onChange(e: Event) {
    const el = e.target as Element | null
    if (!el || isOurUi(el)) return

    if (el.tagName === 'SELECT') {
      const sel = el as HTMLSelectElement
      send({
        blockId: 'forms',
        selector: selectorFor(sel),
        findBy: 'cssSelector',
        type: 'select',
        value: sel.value,
        description: sel.name ?? '',
      })
      return
    }

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const inp = el as HTMLInputElement
      if (inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'submit' || inp.type === 'button') return
      send({
        blockId: 'forms',
        selector: selectorFor(inp),
        findBy: 'cssSelector',
        type: inp.tagName === 'TEXTAREA' ? 'text' : 'text',
        value: inp.value,
        description: inp.name ?? '',
      })
    }
  }

  // Special keys are recorded as press-key; printable characters within inputs
  // are captured via the forms block above.
  const SPECIAL_KEYS = new Set([
    'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' ',
  ])
  function onKeydown(e: KeyboardEvent) {
    const el = e.target as Element | null
    if (el && isOurUi(el)) return
    // Record shortcuts (modifier combos) and navigation keys anywhere; only
    // record plain special keys when NOT typing in a field (those are part of
    // text entry, captured as forms).
    const typing = el ? isEditable(el) : false
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

  function isOurUi(el: Element): boolean {
    return !!el.closest('#bc-element-picker, #bc-recorder-bar')
  }

  document.addEventListener('click', onClick, true)
  document.addEventListener('change', onChange, true)
  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })

  w.__bcRecorder = {
    stop() {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('change', onChange, true)
      document.removeEventListener('keydown', onKeydown, true)
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions)
      delete w.__bcRecorder
    },
  }
}
