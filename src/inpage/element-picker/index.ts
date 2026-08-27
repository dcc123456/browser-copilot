/**
 * Element picker — injected into the active page via chrome.scripting.
 *
 * SELF-CONTAINED: this file is serialized and run in the page world by the
 * background script (same pattern as inpage/kernel.ts). It must not import
 * anything at module level and must not close over outer variables. All
 * helpers live below in one function scope, styles are injected as a string
 * into a Shadow DOM, and icons are inline SVG (the RemixIcon webfont is not
 * present in the page).
 *
 * The picker highlights the element under the cursor, locks it on click, lets
 * the user switch CSS/XPath, toggle selector options, walk parent/child, and
 * confirm. The chosen selector is reported back through
 * chrome.runtime.sendMessage({ type: 'picker:result', pickerId, selector }).
 *
 * @module inpage/element-picker
 */

export interface PickerArgs {
  pickerId: string
  mode: 'select' | 'verify'
  findBy?: 'cssSelector' | 'xpath'
  selector?: string
  multiple?: boolean
}

/** Entry signature used by chrome.scripting.executeScript({ func }). */
type PickerStart = (args: PickerArgs) => Promise<void>

const PICKER_STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
.pick-root { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
.pick-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.28); }
.pick-highlight { position: fixed; pointer-events: none; z-index: 2147483647;
  outline: 2px solid #6366f1; outline-offset: 1px; background: rgba(99,102,241,0.12); }
.pick-card { position: fixed; z-index: 2147483648; width: 330px; background: #fff;
  color: #111827; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.28);
  pointer-events: auto; font-size: 13px; }
.pick-card-head { display: flex; align-items: center; padding: 12px 14px 6px; }
.pick-title { font-weight: 700; font-size: 15px; }
.pick-head-actions { margin-left: auto; display: flex; gap: 4px; }
.pick-iconbtn { border: none; background: transparent; width: 28px; height: 28px;
  border-radius: 6px; cursor: pointer; color: #6b7280; display: inline-flex;
  align-items: center; justify-content: center; }
.pick-iconbtn:hover { background: #f3f4f6; color: #111827; }
.pick-body { padding: 6px 14px 14px; }
.pick-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.pick-select { flex: none; border: 1px solid #e5e7eb; border-radius: 8px;
  padding: 6px 8px; background: #f9fafb; font-size: 13px; }
.pick-selector { flex: 1; min-width: 0; border: 1px solid #e5e7eb; border-radius: 8px;
  padding: 6px 8px; font-family: ui-monospace, monospace; font-size: 12px;
  background: #f9fafb; color: #111827; word-break: break-all; }
.pick-btn { border: 1px solid #e5e7eb; background: #fff; border-radius: 8px;
  width: 32px; height: 32px; cursor: pointer; display: inline-flex;
  align-items: center; justify-content: center; color: #374151; flex: none; }
.pick-btn:hover { background: #f3f4f6; }
.pick-btn:disabled { opacity: 0.4; cursor: default; }
.pick-primary { width: 100%; margin-top: 12px; border: none; background: #6366f1;
  color: #fff; font-weight: 600; border-radius: 8px; padding: 10px; cursor: pointer; font-size: 14px; }
.pick-primary:disabled { opacity: 0.5; cursor: default; }
.pick-count { margin-top: 8px; font-size: 12px; color: #6b7280; }
.pick-count b { color: #6366f1; }
.pick-settings { margin-top: 10px; border-top: 1px solid #f3f4f6; padding-top: 8px; }
.pick-settings summary { cursor: pointer; color: #6b7280; font-size: 12px; }
.pick-opt { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; }
.pick-note { margin-top: 8px; font-size: 12px; color: #059669; }
.pick-err { margin-top: 8px; font-size: 12px; color: #dc2626; }
`

// --- inline SVG icons (RemixIcon glyphs; webfont unavailable in page world) --
const ICON = {
  close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 10.587l4.95-4.95 1.414 1.414-4.95 4.95 4.95 4.95-1.414 1.414-4.95-4.95-4.95 4.95-1.414-1.414 4.95-4.95-4.95-4.95L7.05 5.637z"/></svg>',
  up: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13 7.828V20h-2V7.828l-5.364 5.364-1.414-1.414L12 4l7.778 7.778-1.414 1.414z"/></svg>',
  down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="m12 16-.343.343 5.657 5.657H22v-2h-3.657l-4.95-4.95-1.414 1.414 3.273 3.273L12 16zM2 6h4.686l4.95 4.95-1.414 1.414L6.657 8.657H2V6zm18 2.343L13.343 15 12 13.657l6.657-6.657H15V5h7v7h-2z"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="m10 15.172 7.071-7.071 1.414 1.414L10 18 5.515 13.515l1.414-1.414z"/></svg>',
}

export const startPicker: PickerStart = async (args) => {
  const { pickerId, mode, findBy = 'cssSelector', selector: initial = '', multiple = false } = args

  // --- selector builder (mirrors build-selector.ts; inlined for injection) ---
  interface Opts { idName: boolean; tagName: boolean; className: boolean; attr: boolean; attrNames: string[]; nthChild: boolean }
  const opts: Opts = { idName: true, tagName: true, className: true, attr: false, attrNames: ['data-testid', 'data-test', 'name', 'type'], nthChild: false }
  const esc = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/([^a-zA-Z0-9_-])/g, '\\$1'))
  function part(el: Element): string {
    const tag = el.tagName.toLowerCase()
    if (opts.idName && el.id) return `#${esc(el.id)}`
    let q = ''
    if (opts.className && el.classList.length) {
      q += Array.from(el.classList).filter((c) => c && !/^(css-|jsx-|sc-|ng-|ember)/.test(c) && !/^\d/.test(c)).slice(0, 2).map((c) => `.${esc(c)}`).join('')
    }
    if (opts.attr) for (const a of opts.attrNames) { const v = el.getAttribute(a); if (v) { q += `[${a}="${v.replace(/"/g, '\\"')}"]`; break } }
    if (!q || opts.nthChild) {
      const parentEl = el.parentElement
      if (parentEl) { const sib = Array.from(parentEl.children).filter((c) => (c as Element).tagName === el.tagName); if (sib.length > 1) q += `:nth-of-type(${sib.indexOf(el) + 1})` }
    }
    return (opts.tagName ? tag : '') + q
  }
  function build(el: Element): string {
    const direct = part(el)
    if (direct.startsWith('#') && document.querySelectorAll(direct).length === 1) return direct
    const chain = [direct]
    let node: Element | null = el.parentElement
    let depth = 0
    while (node && depth < 6) {
      const cand = chain.slice().reverse().join(' > ')
      const ms = document.querySelectorAll(cand)
      if (ms.length === 1 && ms[0] === el) return cand
      if (opts.idName && node.id) { const withId = `#${esc(node.id)} > ${chain.slice().reverse().join(' > ')}`; if (document.querySelectorAll(withId).length === 1) return withId }
      chain.push(part(node)); node = node.parentElement; depth++
    }
    return chain.slice().reverse().join(' > ')
  }
  function buildXp(el: Element): string {
    if (el.id) return `//*[@id="${el.id}"]`
    const segs: string[] = []
    let node: Element | null = el
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase()
      const pNode: Element | null = node.parentElement
      if (!pNode) { segs.unshift(`/${tag}`); break }
      const same = Array.from(pNode.children).filter((c) => (c as Element).tagName === node!.tagName)
      segs.unshift(same.length === 1 ? `/${tag}` : `/${tag}[${same.indexOf(node) + 1}]`)
      if (pNode.id) { segs.unshift(`//*[@id="${pNode.id}"]`); break }
      node = pNode
    }
    return segs.join('')
  }
  const count = (sel: string, xp: boolean): number => {
    if (!sel) return 0
    try {
      if (xp) return document.evaluate(sel, document, null, 7, null).snapshotLength
      return document.querySelectorAll(sel).length
    } catch { return 0 }
  }

  // --- DOM scaffold (Shadow DOM) ---
  const host = document.createElement('div')
  host.id = 'bc-element-picker'
  host.style.all = 'initial'
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = PICKER_STYLES
  root.appendChild(style)

  const rootEl = document.createElement('div')
  rootEl.className = 'pick-root'
  const overlay = document.createElement('div')
  overlay.className = 'pick-overlay'
  const highlight = document.createElement('div')
  highlight.className = 'pick-highlight'
  highlight.style.display = 'none'

  const card = document.createElement('div')
  card.className = 'pick-card'
  card.style.left = '16px'
  card.style.bottom = '16px'
  card.innerHTML = `
    <div class="pick-card-head">
      <span class="pick-title">Browser Copilot</span>
      <div class="pick-head-actions">
        <button class="pick-iconbtn" data-act="cancel" title="Cancel">${ICON.close}</button>
      </div>
    </div>
    <div class="pick-body">
      <div class="pick-row">
        <select class="pick-select" data-role="findby">
          <option value="cssSelector">CSS</option>
          <option value="xpath">XPath</option>
        </select>
        <button class="pick-btn" data-act="parent" title="Select parent">${ICON.up}</button>
        <button class="pick-btn" data-act="child" title="Select child">${ICON.down}</button>
      </div>
      <div class="pick-row">
        <div class="pick-selector" data-role="selector">(hover an element)</div>
        <button class="pick-btn" data-act="verify" title="Verify">${ICON.check}</button>
      </div>
      <div class="pick-count" data-role="count"></div>
      <details class="pick-settings">
        <summary>Selector settings</summary>
        <label class="pick-opt"><input type="checkbox" data-opt="idName" checked> Include id</label>
        <label class="pick-opt"><input type="checkbox" data-opt="tagName" checked> Include tag name</label>
        <label class="pick-opt"><input type="checkbox" data-opt="className" checked> Include class name</label>
        <label class="pick-opt"><input type="checkbox" data-opt="attr"> Include attributes</label>
        <label class="pick-opt"><input type="checkbox" data-opt="nthChild"> Use nth-child</label>
      </details>
      <button class="pick-primary" data-act="confirm" disabled>Select Element</button>
      <div class="pick-note" data-role="note" style="display:none"></div>
    </div>`
  rootEl.append(overlay, highlight, card)
  root.appendChild(rootEl)
  document.documentElement.appendChild(host)

  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T
  const findBySel = $<HTMLSelectElement>('[data-role="findby"]')
  const selectorEl = $('[data-role="selector"]')
  const countEl = $('[data-role="count"]')
  const noteEl = $('[data-role="note"]')
  const confirmBtn = $<HTMLButtonElement>('[data-act="confirm"]')
  findBySel.value = findBy

  let locked: Element | null = null
  let hovered: Element | null = null
  let curSelector = initial

  const target = () => locked ?? hovered

  function highlightEl(el: Element | null) {
    if (!el || el === host || host.contains(el)) {
      highlight.style.display = 'none'
      return
    }
    const r = el.getBoundingClientRect()
    highlight.style.display = 'block'
    highlight.style.top = `${r.top}px`
    highlight.style.left = `${r.left}px`
    highlight.style.width = `${r.width}px`
    highlight.style.height = `${r.height}px`
  }

  function refresh() {
    const el = target()
    if (!el) return
    const xp = findBySel.value === 'xpath'
    curSelector = xp ? buildXp(el) : build(el)
    selectorEl.textContent = curSelector
    const n = count(curSelector, xp)
    countEl.innerHTML = n === 1 ? 'Matches <b>1</b> element' : `Matches <b>${n}</b> elements`
    confirmBtn.disabled = !curSelector || n < 1
    highlightEl(el)
  }

  // Verify mode: count an existing selector and report immediately.
  if (mode === 'verify' && initial) {
    const xp = findBy === 'xpath'
    const n = count(initial, xp)
    void chrome.runtime.sendMessage({ type: 'picker:result', pickerId, selector: initial, count: n, verified: true })
    host.remove()
    return
  }

  const onMove = (e: MouseEvent) => {
    if (locked) return
    hovered = document.elementFromPoint(e.clientX, e.clientY)
    if (hovered && (hovered === card || (card.contains(hovered)) || host.contains(hovered))) {
      hovered = null
      highlightEl(null)
      return
    }
    highlightEl(hovered)
    if (hovered) {
      const xp = findBySel.value === 'xpath'
      curSelector = xp ? buildXp(hovered) : build(hovered)
      selectorEl.textContent = curSelector
      countEl.innerHTML = `Matches <b>${count(curSelector, xp)}</b> elements`
    }
  }
  const onClick = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if ((e.target as HTMLElement).closest('.pick-card')) return
    locked = hovered ?? document.elementFromPoint(e.clientX, e.clientY)
    if (locked && !host.contains(locked)) refresh()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { cleanup(); void chrome.runtime.sendMessage({ type: 'picker:cancel', pickerId }) }
  }

  card.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!btn) return
    const act = btn.dataset.act
    if (act === 'cancel') { cleanup(); void chrome.runtime.sendMessage({ type: 'picker:cancel', pickerId }); return }
    if (act === 'confirm' && curSelector) {
      void chrome.runtime.sendMessage({ type: 'picker:result', pickerId, selector: curSelector, findBy: findBySel.value, multiple })
      cleanup(); return
    }
    if (act === 'parent') { const el = target(); if (el?.parentElement) { locked = el.parentElement; refresh() } }
    if (act === 'child') { const el = target(); const kid = el?.firstElementChild; if (kid) { locked = kid; refresh() } }
    if (act === 'verify') {
      const xp = findBySel.value === 'xpath'
      const n = count(curSelector, xp)
      noteEl.style.display = 'block'
      noteEl.style.color = n > 0 ? '#059669' : '#dc2626'
      noteEl.textContent = n > 0 ? `Verified: ${n} element(s) match` : 'Element not found'
    }
  })
  findBySel.addEventListener('change', refresh)
  root.querySelectorAll<HTMLInputElement>('[data-opt]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.opt as keyof Opts
      if (key === 'attrNames') return
      ;(opts as unknown as Record<string, unknown>)[key] = cb.checked
      refresh()
    })
  })

  // make the card draggable
  let dragDx = 0, dragDy = 0, dragging = false
  const head = card.querySelector('.pick-card-head') as HTMLElement
  head.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    dragging = true
    const r = card.getBoundingClientRect()
    dragDx = e.clientX - r.left
    dragDy = e.clientY - r.top
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    card.style.left = `${e.clientX - dragDx}px`
    card.style.top = `${e.clientY - dragDy}px`
    card.style.bottom = 'auto'
  }, true)
  window.addEventListener('mouseup', () => { dragging = false }, true)

  function cleanup() {
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKey, true)
    host.remove()
  }
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)
}
