/**
 * Element picker — injected into the active page via chrome.scripting.
 *
 * SELF-CONTAINED: this file is serialized and run in the page world by the
 * background script (same pattern as inpage/kernel.ts). It must not import
 * anything at module level and must not close over outer variables. All
 * helpers live below in one function scope, styles are injected as a string
 * into a Shadow DOM, and icons are inline SVG strings carrying lucide's
 * official path data (no React and no webfont exist in the page world).
 *
 * The picker highlights the element under the cursor, locks it on the FIRST
 * PRESS (the page never sees that press, so a popover that closes on
 * click-outside stays open), lets the user switch CSS/XPath, toggle selector
 * options, walk parent/child, and confirm with the card button or Enter. When
 * the built selector still matches several elements, it is pinned to the
 * chosen match (a stepper walks the match set) so the committed selector
 * resolves to exactly one element — unless the caller passed `multiple`, which
 * means the block acts on every match and keeps the broad selector. The
 * chosen selector is reported back through
 * chrome.runtime.sendMessage({ type: 'picker:result', pickerId, selector }).
 *
 * In `verify` mode the picker outlines every match on the page and holds that
 * view for a short beat before replying with the count — the reply raises the
 * editor window, so answering instantly would hide what was verified.
 *
 * IMPORTANT: this function is serialized via `func.toString()` and run in the
 * page world by chrome.scripting.executeScript. EVERYTHING it uses — styles,
 * icons, helpers — MUST be declared INSIDE the function body. Module-level
 * constants (or imports) become free variables that do not exist in the page
 * world and throw ReferenceError the moment the picker tries to mount, which
 * strands the editor spinner. (Mirrors Automa's self-contained picker bundle.)
 *
 * @module inpage/element-picker
 */

export interface PickerArgs {
  pickerId: string
  mode: 'select' | 'verify' | 'copy'
  /**
   * Copy mode: what the confirm action writes to the clipboard. Mirrors the
   * shared `ElementPickerFormat`; inlined because this file must not import.
   */
  copyFormat?: 'selector' | 'text' | 'html'
  /**
   * `text` captures the aimed element's visible text instead of a selector:
   * the workflow engine resolves it through the kernel's text strategy.
   */
  findBy?: 'cssSelector' | 'xpath' | 'text'
  selector?: string
  /**
   * True when the block acts on EVERY match (loop-elements, get-text with
   * `multiple`): the picker then keeps the broad selector instead of pinning
   * one match.
   */
  multiple?: boolean
  /**
   * Editor UI locale, so the copy this module adds reads the same way as the
   * panel that launched it. The card's pre-existing strings are English-only
   * debt; only new strings are localized.
   */
  locale?: 'en' | 'zh'
}

/** Entry signature used by chrome.scripting.executeScript({ func }). */
type PickerStart = (args: PickerArgs) => Promise<void>

export const startPicker: PickerStart = async (args) => {
  const {
    pickerId,
    mode,
    copyFormat = 'html',
    findBy = 'cssSelector',
    selector: initial = '',
    multiple = false,
    locale = 'en',
  } = args

  // --- styles (inlined so the serialized function is self-contained) --------
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
.pick-card-head { display: flex; align-items: center; padding: 12px 14px 6px; cursor: move; }
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
.pick-match { display: none; align-items: center; gap: 6px; margin-top: 6px; }
.pick-match-label { flex: 1; text-align: center; font-size: 12px; color: #374151; }
.pick-hint { margin-top: 6px; font-size: 12px; color: #6b7280; }
.pick-settings { margin-top: 10px; border-top: 1px solid #f3f4f6; padding-top: 8px; }
.pick-settings summary { cursor: pointer; color: #6b7280; font-size: 12px; }
.pick-opt { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; }
.pick-note { margin-top: 8px; font-size: 12px; color: #059669; }
.pick-err { margin-top: 8px; font-size: 12px; color: #dc2626; }
.pick-verify-layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
.pick-verify-box { position: fixed; pointer-events: none; border-radius: 2px;
  outline: 2px solid #10b981; outline-offset: 1px; background: rgba(16,185,129,0.14); }
.pick-verify-toast { position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; background: #111827; color: #fff;
  font-size: 13px; padding: 10px 14px; border-radius: 10px; pointer-events: none;
  box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
.pick-verify-toast.is-error { background: #dc2626; }
.pick-verify-toast b { color: #a7f3d0; }
.pick-verify-toast.is-error b { color: #fff; }
.pick-verify-esc { color: #9ca3af; font-size: 12px; }
`

  // --- inline SVG icons (lucide glyphs, stroke markup inlined as strings:
  // the picker runs in the page world where the React component library and
  // any webfont are unavailable, so the official lucide path data is embedded
  // directly — same geometry the lucide-react components render).
  const lucideSvg = (paths: string): string =>
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
  const ICON = {
    close: lucideSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    up: lucideSvg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
    down: lucideSvg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
    check: lucideSvg('<path d="M20 6 9 17l-5-5"/>'),
    left: lucideSvg('<path d="m15 18-6-6 6-6"/>'),
    right: lucideSvg('<path d="m9 18 6-6-6-6"/>'),
  }

  // Idempotency guard (Automa's elementSelectorInstance): a previous picker
  // mount (e.g. re-injection, or a re-trigger while one is open) is removed
  // first so cards never stack and listeners never double-bind.
  document.getElementById('bc-element-picker')?.remove()

  // The new copy is bilingual (§3); a table keyed by locale, because the page
  // world has no i18n module to import.
  const STRINGS = {
    hint:
      locale === 'zh'
        ? '按 Enter 选中高亮的元素（无需点击）'
        : 'Press Enter to select the highlighted element (no click needed)',
    matchNav: (index: number, total: number): string =>
      locale === 'zh' ? `第 ${index} / ${total} 个匹配` : `Match ${index} of ${total}`,
    prevMatch: locale === 'zh' ? '上一个匹配' : 'Previous match',
    nextMatch: locale === 'zh' ? '下一个匹配' : 'Next match',
    groupCount: (total: number, index: number): string =>
      locale === 'zh'
        ? `匹配 <b>${total}</b> 个元素 · 使用第 <b>${index}</b> 个`
        : `Matches <b>${total}</b> elements · using <b>#${index}</b>`,
    verifyFound: (total: number): string =>
      locale === 'zh'
        ? `匹配到 <b>${total}</b> 个元素`
        : `<b>${total}</b> element${total === 1 ? '' : 's'} match`,
    verifyMiss: locale === 'zh' ? '未找到匹配元素' : 'Element not found',
    verifyEsc: locale === 'zh' ? '按 Esc 关闭' : 'Press Esc to close',
    textOption: locale === 'zh' ? '文本' : 'Text',
    noText: locale === 'zh' ? '（无可读文本）' : '(no visible text)',
    copyHtml: locale === 'zh' ? '复制 HTML' : 'Copy HTML',
    copySelector: locale === 'zh' ? '复制选择器' : 'Copy selector',
    copyText: locale === 'zh' ? '复制文本' : 'Copy text',
    targetPlaceholder: locale === 'zh' ? '（点击一个元素）' : '(click an element)',
    copyHint: (action: string): string =>
      locale === 'zh'
        ? `点击元素锁定，按 Enter 或点“${action}”`
        : `Click an element, then press Enter or ${action}`,
    copyLockHint: locale === 'zh' ? '点击页面上的元素' : 'Click an element on the page',
    htmlChars: (size: string): string =>
      locale === 'zh' ? `HTML · ${size} 个字符` : `HTML · ${size} chars`,
    selectorChars: (size: string): string =>
      locale === 'zh' ? `CSS 选择器 · ${size} 个字符` : `CSS selector · ${size} chars`,
    textChars: (size: string): string =>
      locale === 'zh' ? `文本 · ${size} 个字符` : `Text · ${size} chars`,
    htmlLarge: (size: string): string =>
      locale === 'zh'
        ? `HTML 较大（${size} 个字符），粘贴后可能超出模型上下文`
        : `Large HTML (${size} chars) — pasting may exceed the model context`,
    textLarge: (size: string): string =>
      locale === 'zh'
        ? `文本较大（${size} 个字符），粘贴后可能超出模型上下文`
        : `Large text (${size} chars) — pasting may exceed the model context`,
    copiedHtml: (size: string, tag: string): string =>
      locale === 'zh' ? `已复制 <${tag}> 的 ${size} 个字符` : `Copied ${size} chars of <${tag}>`,
    copiedSelector: (size: string): string =>
      locale === 'zh'
        ? `已复制 CSS 选择器（${size} 个字符）`
        : `Copied CSS selector (${size} chars)`,
    copiedText: (size: string, tag: string): string =>
      locale === 'zh'
        ? `已复制 <${tag}> 的文本（${size} 个字符）`
        : `Copied <${tag}> text (${size} chars)`,
    copyFailed: locale === 'zh' ? '复制失败，请重试' : 'Copy failed — please retry',
  }

  // --- selector builder (mirrors build-selector.ts; inlined for injection) ---
  interface Opts {
    idName: boolean
    tagName: boolean
    className: boolean
    attr: boolean
    attrNames: string[]
    nthChild: boolean
  }
  const opts: Opts = {
    idName: true,
    tagName: true,
    className: true,
    attr: false,
    attrNames: ['data-testid', 'data-test', 'name', 'type'],
    nthChild: false,
  }
  const esc = (v: string) =>
    typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(v)
      : v.replace(/([^a-zA-Z0-9_-])/g, '\\$1')
  function part(el: Element, forceNth = false): string {
    const tag = el.tagName.toLowerCase()
    if (opts.idName && el.id) return `#${esc(el.id)}`
    let q = ''
    if (opts.className && el.classList.length) {
      q += Array.from(el.classList)
        .filter((c) => c && !/^(css-|jsx-|sc-|ng-|ember)/.test(c) && !/^\d/.test(c))
        .slice(0, 2)
        .map((c) => `.${esc(c)}`)
        .join('')
    }
    if (opts.attr)
      for (const a of opts.attrNames) {
        const v = el.getAttribute(a)
        if (v) {
          q += `[${a}="${v.replace(/"/g, '\\"')}"]`
          break
        }
      }
    if (!q || opts.nthChild || forceNth) {
      const parentEl = el.parentElement
      if (parentEl) {
        const sib = Array.from(parentEl.children).filter(
          (c) => (c as Element).tagName === el.tagName,
        )
        if (sib.length > 1) q += `:nth-of-type(${sib.indexOf(el) + 1})`
      }
    }
    return (opts.tagName ? tag : '') + q
  }
  // Matches of a CSS selector or XPath across all open roots, in root order —
  // shadow elements never appear in document queries, so every count and
  // uniqueness check walks the same root list.
  const matchesOf = (sel: string, xp = false): Element[] => {
    if (!sel) return []
    const out: Element[] = []
    for (const root of openRoots()) {
      if (xp) {
        try {
          const doc = root.nodeType === 9 ? (root as Document) : (root as ShadowRoot).ownerDocument
          if (!doc) continue
          const result = doc.evaluate(sel, root, null, 7, null)
          for (let i = 0; i < result.snapshotLength; i += 1) {
            const node = result.snapshotItem(i)
            if (node && node.nodeType === 1) out.push(node as Element)
          }
        } catch {
          /* bad expression in this root */
        }
      } else {
        try {
          root.querySelectorAll(sel).forEach((m) => out.push(m))
        } catch {
          /* bad selector */
        }
      }
    }
    return out
  }
  const isExact = (sel: string, el: Element, xp = false): boolean => {
    const ms = matchesOf(sel, xp)
    return ms.length === 1 && ms[0] === el
  }
  function build(el: Element, forceNth = false): string {
    const direct = part(el, forceNth)
    if (direct.startsWith('#') && matchesOf(direct).length === 1) return direct
    const chain = [direct]
    let node: Element | null = el.parentElement
    let depth = 0
    while (node && depth < 6) {
      const cand = chain.slice().reverse().join(' > ')
      const ms = matchesOf(cand)
      if (ms.length === 1 && ms[0] === el) return cand
      if (opts.idName && node.id) {
        const withId = `#${esc(node.id)} > ${chain.slice().reverse().join(' > ')}`
        if (matchesOf(withId).length === 1) return withId
      }
      chain.push(part(node, forceNth))
      node = node.parentElement
      depth++
    }
    return chain.slice().reverse().join(' > ')
  }
  /** Absolute :nth-child path from body/html; null when a shadow boundary blocks it. */
  function positionalPath(el: Element): string | null {
    const parts: string[] = []
    let node: Element | null = el
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag)
        break
      }
      const parent: Element | null = node.parentElement
      if (!parent) return null
      let position = 1
      let sibling = node.previousElementSibling
      while (sibling) {
        position += 1
        sibling = sibling.previousElementSibling
      }
      parts.unshift(`${tag}:nth-child(${position})`)
      node = parent
    }
    return parts.length > 0 ? parts.join(' > ') : ''
  }
  /**
   * A selector resolving to exactly `el`. Repeated rows share every ancestor
   * and class, so the short build stays broad; retry with :nth-of-type on the
   * repeated level, then fall back to the absolute :nth-child path. '' when no
   * CSS form is provably unique (the caller must keep the broad selector
   * rather than claim a target).
   */
  function pinnedSelectorFor(el: Element, base: string, index: number, xp: boolean): string {
    if (xp) {
      const wrapped = `(${base})[${index + 1}]`
      return isExact(wrapped, el, true) ? wrapped : ''
    }
    if (isExact(base, el)) return base
    const positional = build(el, true)
    if (isExact(positional, el)) return positional
    const absolute = positionalPath(el)
    return absolute && isExact(absolute, el) ? absolute : ''
  }
  function buildXp(el: Element): string {
    if (el.id) return `//*[@id="${el.id}"]`
    const segs: string[] = []
    let node: Element | null = el
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase()
      const pNode: Element | null = node.parentElement
      if (!pNode) {
        segs.unshift(`/${tag}`)
        break
      }
      const same = Array.from(pNode.children).filter(
        (c) => (c as Element).tagName === node!.tagName,
      )
      segs.unshift(same.length === 1 ? `/${tag}` : `/${tag}[${same.indexOf(node) + 1}]`)
      if (pNode.id) {
        segs.unshift(`//*[@id="${pNode.id}"]`)
        break
      }
      node = pNode
    }
    return segs.join('')
  }
  // Collect the document plus every OPEN shadow root (outermost first) so the
  // selector matcher can reach inside web components. The picker host itself
  // is excluded (its open shadow root is our own card). Closed shadow roots
  // are invisible to JS; those targets are driven via chrome.debugger.
  const openRoots = (): ParentNode[] => {
    const roots: ParentNode[] = [document]
    const visit = (root: ParentNode): void => {
      let list: NodeListOf<Element>
      try {
        list = root.querySelectorAll('*')
      } catch {
        return
      }
      list.forEach((el) => {
        if (el === host) return
        const sr = (el as HTMLElement).shadowRoot
        if (sr && sr.nodeType === 11) {
          roots.push(sr)
          visit(sr)
        }
      })
    }
    visit(document)
    return roots
  }
  const count = (sel: string, xp: boolean): number => matchesOf(sel, xp).length

  // --- text strategy (mirrors the kernel's, inlined for injection) -----------
  // Text mode reads the aimed element's rendered text and counts how many
  // elements the kernel would resolve for it. The two must AGREE: the picker's
  // count is the operator's only warning that a text is not unique, and the
  // click replays the same strategy. So the whitespace rule and the "tightest
  // holder wins" rule are copied verbatim, not approximated.
  const collapseText = (text: string): string => text.replace(/[\s\u00a0]+/g, ' ').trim()
  const visibleTextOf = (el: Element): string => {
    const html = el as HTMLElement
    if (typeof html.innerText === 'string' && html.innerText.length > 0) {
      return collapseText(html.innerText)
    }
    const clone = el.cloneNode(true) as HTMLElement
    clone
      .querySelectorAll('script, style, noscript, template, svg, canvas, iframe, object, embed')
      .forEach((node) => node.remove())
    return collapseText(clone.textContent ?? '')
  }
  let textMatchCache: { wanted: string; matches: Element[] } | null = null
  const matchesByText = (wanted: string): Element[] => {
    if (!wanted) return []
    if (textMatchCache && textMatchCache.wanted === wanted) return textMatchCache.matches
    const all: Element[] = []
    for (const root of openRoots()) {
      try {
        root.querySelectorAll('*').forEach((el) => {
          if (el !== host) all.push(el)
        })
      } catch {
        /* the root vanished mid-walk */
      }
    }
    const texts = new Map<Element, string>()
    all.forEach((el) => texts.set(el, visibleTextOf(el)))
    // An element qualifies only when none of its descendants does, so a word
    // never counts the page container that merely holds it.
    const tightest = (holds: (text: string) => boolean): Element[] => {
      const hits = all.filter((el) => holds(texts.get(el) ?? ''))
      return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)))
    }
    let found = tightest((text) => text === wanted)
    // The kernel only loosens to "includes" when the exact pass found nothing.
    if (found.length === 0) found = tightest((text) => text.includes(wanted))
    textMatchCache = { wanted, matches: found }
    return found
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
          <option value="text">${STRINGS.textOption}</option>
        </select>
        <button class="pick-btn" data-act="parent" title="Select parent">${ICON.up}</button>
        <button class="pick-btn" data-act="child" title="Select child">${ICON.down}</button>
      </div>
      <div class="pick-row">
        <div class="pick-selector" data-role="selector">(hover an element)</div>
        <button class="pick-btn" data-act="verify" title="Verify">${ICON.check}</button>
      </div>
      <div class="pick-count" data-role="count"></div>
      <div class="pick-match" data-role="matchnav">
        <button class="pick-btn" data-act="prev-match" title="${STRINGS.prevMatch}">${ICON.left}</button>
        <span class="pick-match-label" data-role="matchlabel"></span>
        <button class="pick-btn" data-act="next-match" title="${STRINGS.nextMatch}">${ICON.right}</button>
      </div>
      <details class="pick-settings">
        <summary>Selector settings</summary>
        <label class="pick-opt"><input type="checkbox" data-opt="idName" checked> Include id</label>
        <label class="pick-opt"><input type="checkbox" data-opt="tagName" checked> Include tag name</label>
        <label class="pick-opt"><input type="checkbox" data-opt="className" checked> Include class name</label>
        <label class="pick-opt"><input type="checkbox" data-opt="attr"> Include attributes</label>
        <label class="pick-opt"><input type="checkbox" data-opt="nthChild"> Use nth-child</label>
      </details>
      <button class="pick-primary" data-act="confirm" disabled>Select Element</button>
      <div class="pick-hint" data-role="hint" style="display:none">${STRINGS.hint}</div>
      <div class="pick-note" data-role="note" style="display:none"></div>
    </div>`
  rootEl.append(overlay, highlight, card)
  root.appendChild(rootEl)
  document.documentElement.appendChild(host)

  // The picker launcher is another extension control parked on the page. Hide
  // it while picking so the press interceptor cannot lock onto our own button;
  // cleanup() restores it. Verify mode never mounts this card, so it leaves the
  // launcher alone.
  const launcherHost =
    mode === 'verify' ? null : document.getElementById('bc-element-picker-launcher')
  if (launcherHost instanceof HTMLElement) launcherHost.style.display = 'none'

  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T
  const findBySel = $<HTMLSelectElement>('[data-role="findby"]')
  const selectorEl = $('[data-role="selector"]')
  const countEl = $('[data-role="count"]')
  const matchNavEl = $('[data-role="matchnav"]')
  const matchLabelEl = $('[data-role="matchlabel"]')
  const hintEl = $('[data-role="hint"]')
  const noteEl = $('[data-role="note"]')
  const confirmBtn = $<HTMLButtonElement>('[data-act="confirm"]')
  const verifyBtn = $<HTMLButtonElement>('[data-act="verify"]')
  const settingsEl = card.querySelector('.pick-settings') as HTMLElement | null
  findBySel.value = findBy

  // Copy mode drops the selector machinery: only the target, the payload size
  // and the copy action remain. What gets copied is the copyFormat setting.
  const copyAction =
    copyFormat === 'selector'
      ? STRINGS.copySelector
      : copyFormat === 'text'
        ? STRINGS.copyText
        : STRINGS.copyHtml
  if (mode === 'copy') {
    findBySel.style.display = 'none'
    verifyBtn.style.display = 'none'
    if (settingsEl) settingsEl.style.display = 'none'
    selectorEl.textContent = STRINGS.targetPlaceholder
    confirmBtn.textContent = copyAction
    hintEl.textContent = STRINGS.copyHint(copyAction)
    countEl.textContent = STRINGS.copyLockHint
  }

  let locked: Element | null = null
  let hovered: Element | null = null
  let curSelector = initial
  /**
   * The broad selector and match set the current pin was chosen from. Present
   * only when the short build matched several elements and pinning produced a
   * unique selector; drives the match stepper.
   */
  let matchGroup: { base: string; members: Element[]; index: number } | null = null

  const target = () => locked ?? hovered

  /** The Enter hint is an instruction for a target that exists, so it appears
   *  with the first hover and stays while one is aimed at. */
  function updateHint() {
    hintEl.style.display = target() ? 'block' : 'none'
  }

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

  function renderMatchNav() {
    const visible = matchGroup !== null && matchGroup.members.length > 1
    matchNavEl.style.display = visible ? 'flex' : 'none'
    if (!matchGroup) return
    matchLabelEl.textContent = STRINGS.matchNav(matchGroup.index + 1, matchGroup.members.length)
  }

  /** Serializing a large payload is expensive; warn above this size. */
  const HTML_WARN_CHARS = 100_000

  /** Compact `<tag#id.class>` label for the copy-mode card. */
  const describeTarget = (el: Element): string => {
    const tag = el.tagName.toLowerCase()
    const id = el.id ? `#${el.id}` : ''
    const cls = el.classList.length ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : ''
    return `<${tag}${id}${cls}>`
  }

  /** One selector that resolves to exactly `el`, falling back to the short form. */
  const selectorFor = (el: Element): string => {
    const base = build(el)
    return pinnedSelectorFor(el, base, 0, false) || base
  }

  /** Caller-selected clipboard payload for a copy-mode target. */
  const copyValueFor = (el: Element): string =>
    copyFormat === 'selector'
      ? selectorFor(el)
      : copyFormat === 'text'
        ? visibleTextOf(el)
        : el.outerHTML

  /** Copy mode: the target and its payload size, no selector machinery. */
  function refreshCopy() {
    const el = target()
    if (!el) {
      selectorEl.textContent = STRINGS.targetPlaceholder
      countEl.textContent = ''
      confirmBtn.disabled = true
      matchNavEl.style.display = 'none'
      highlightEl(null)
      updateHint()
      return
    }
    selectorEl.textContent =
      copyFormat === 'selector' && locked ? selectorFor(locked) : describeTarget(el)
    // Only the locked target is measured: serializing on every mousemove would
    // rebuild huge payloads dozens of times per second.
    if (locked) {
      const size = copyValueFor(locked).length
      const isLarge = size > HTML_WARN_CHARS
      const sizeText = size.toLocaleString()
      if (isLarge) {
        countEl.textContent =
          copyFormat === 'text' ? STRINGS.textLarge(sizeText) : STRINGS.htmlLarge(sizeText)
      } else {
        countEl.textContent =
          copyFormat === 'selector'
            ? STRINGS.selectorChars(sizeText)
            : copyFormat === 'text'
              ? STRINGS.textChars(sizeText)
              : STRINGS.htmlChars(sizeText)
      }
      countEl.style.color = isLarge ? '#dc2626' : '#6b7280'
    } else {
      countEl.textContent = STRINGS.copyLockHint
      countEl.style.color = '#6b7280'
    }
    confirmBtn.disabled = false
    matchNavEl.style.display = 'none'
    highlightEl(el)
    updateHint()
  }

  function refresh() {
    if (mode === 'copy') return refreshCopy()
    const el = target()
    if (!el) return
    const dialect = findBySel.value
    const textMode = dialect === 'text'
    const xp = dialect === 'xpath'
    const base = textMode ? visibleTextOf(el) : xp ? buildXp(el) : build(el)
    const baseMatches = textMode ? matchesByText(base) : matchesOf(base, xp)
    // A `multiple` caller wants the broad selector (every match). Otherwise
    // the aim is ONE element, so pin the committed selector to the match the
    // user actually pointed at — a broad selector would act on the first
    // visible match and silently pick a different row. Text has no positional
    // form: the field holds the text itself, and the count warns when several
    // elements share it.
    matchGroup = null
    let nextSelector = base
    const index = baseMatches.indexOf(el)
    if (!textMode && !multiple && baseMatches.length > 1 && index >= 0) {
      const pinned = pinnedSelectorFor(baseMatches[index] as Element, base, index, xp)
      if (pinned) {
        matchGroup = { base, members: baseMatches, index }
        nextSelector = pinned
      }
    }
    curSelector = nextSelector
    selectorEl.textContent = curSelector || (textMode ? STRINGS.noText : '')
    const n = textMode ? matchesByText(curSelector).length : count(curSelector, xp)
    countEl.innerHTML = matchGroup
      ? STRINGS.groupCount(matchGroup.members.length, matchGroup.index + 1)
      : n === 1
        ? 'Matches <b>1</b> element'
        : `Matches <b>${n}</b> elements`
    confirmBtn.disabled = !curSelector || n < 1
    renderMatchNav()
    highlightEl(el)
    updateHint()
  }
  /** Move the pin within the current broad match set (wrapping). */
  function stepMatch(delta: number) {
    if (!matchGroup) return
    const xp = findBySel.value === 'xpath'
    const total = matchGroup.members.length
    const nextIndex = (matchGroup.index + delta + total) % total
    const nextEl = matchGroup.members[nextIndex]
    if (!nextEl) return
    const pinned = pinnedSelectorFor(nextEl, matchGroup.base, nextIndex, xp)
    // No unique form for that member: keep the broad selector and stay put
    // rather than showing a selector that means something else.
    if (!pinned) return
    matchGroup.index = nextIndex
    locked = nextEl
    curSelector = pinned
    selectorEl.textContent = curSelector
    countEl.innerHTML = STRINGS.groupCount(total, nextIndex + 1)
    confirmBtn.disabled = false
    renderMatchNav()
    highlightEl(nextEl)
    updateHint()
  }

  // Verify mode: outline every match on the page, hold that view for a beat,
  // then answer. The editor raises its own window the moment the reply lands
  // (element-pick.ts focusEditorWindow), so answering immediately would hide
  // the page before the operator could see what matched.
  if (mode === 'verify' && initial) {
    const VERIFY_HOLD_MS = 3000
    // A pathological selector must not paint thousands of boxes; the reply
    // still carries the full count.
    const MAX_VERIFY_BOXES = 50
    const matched =
      findBy === 'text' ? matchesByText(initial) : matchesOf(initial, findBy === 'xpath')
    // The select-mode scaffold (dark overlay, card, single highlight) has no
    // role here; only the match boxes and the result toast should show.
    rootEl.remove()

    const layer = document.createElement('div')
    layer.className = 'pick-verify-layer'
    matched.slice(0, MAX_VERIFY_BOXES).forEach((el) => {
      const r = el.getBoundingClientRect()
      const box = document.createElement('div')
      box.className = 'pick-verify-box'
      box.style.top = `${r.top}px`
      box.style.left = `${r.left}px`
      box.style.width = `${r.width}px`
      box.style.height = `${r.height}px`
      layer.appendChild(box)
    })
    const toast = document.createElement('div')
    toast.className = `pick-verify-toast${matched.length > 0 ? '' : ' is-error'}`
    toast.innerHTML = `<span>${
      matched.length > 0 ? STRINGS.verifyFound(matched.length) : STRINGS.verifyMiss
    }</span><span class="pick-verify-esc">${STRINGS.verifyEsc}</span>`
    layer.appendChild(toast)
    root.appendChild(layer)

    let answered = false
    function answer(): void {
      if (answered) return
      answered = true
      clearTimeout(timer)
      window.removeEventListener('keydown', onVerifyKey, true)
      void chrome.runtime.sendMessage({
        type: 'picker:result',
        pickerId,
        selector: initial,
        count: matched.length,
        verified: true,
      })
      host.remove()
    }
    // Escape dismisses the preview without waiting out the hold; the count is
    // already known, so it answers rather than cancels.
    function onVerifyKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      answer()
    }
    const timer = setTimeout(answer, VERIFY_HOLD_MS)
    window.addEventListener('keydown', onVerifyKey, true)
    return
  }

  // Deepest element under a mouse event, crossing OPEN shadow boundaries.
  // composedPath()[0] is the real target inside an open shadow root; for a
  // closed root the path is truncated to the host, matching elementFromPoint.
  const eventTarget = (e: MouseEvent): Element | null => {
    const path = e.composedPath?.()
    const first = path && path[0]
    return (first as Element) ?? document.elementFromPoint(e.clientX, e.clientY)
  }
  // Our own UI (the picker card lives in `host`'s open shadow root): any event
  // whose path passes through `host` belongs to the card. Takes `Event` because
  // the keyboard commit asks the same question.
  const isOurUi = (e: Event): boolean => {
    const path = e.composedPath?.()
    if (path && path.indexOf(host) !== -1) return true
    const t = e.target as Node | null
    return !!t && host.contains(t)
  }
  const onMove = (e: MouseEvent) => {
    if (locked) return
    const aimed = eventTarget(e)
    hovered =
      aimed && (aimed === card || card.contains(aimed) || host.contains(aimed)) ? null : aimed
    // A hover aims the pick exactly like a lock does, so it goes through the
    // same refresh — the Enter commit needs `confirmBtn` to be truthful about
    // what is currently selectable.
    if (hovered) refresh()
    else {
      highlightEl(null)
      updateHint()
    }
  }
  // Locking happens on the FIRST press, and the page must never learn about
  // that press: the popovers users need to pick inside close on their own
  // click-outside handler, which runs on pointerdown/mousedown — before any
  // click-level interceptor. `window` capture is the first station of the
  // capture path, so swallowing there beats every document-level directive;
  // stopImmediatePropagation (not stopPropagation) also silences listeners
  // already bound to this node, and preventDefault suppresses the focus shift
  // that focusout-based dismissals key on. Page timers closing a popover are
  // still page timers — this only promises the page never sees THIS press.
  const swallowPress = (e: Event) => {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  const lockTo = (e: MouseEvent) => {
    const el = eventTarget(e)
    if (!el || el === host || host.contains(el)) return
    locked = el
    refresh()
  }
  // The trailing mousedown/click of a press we already locked on must not
  // re-lock: by then the page may have moved the DOM under the cursor.
  let sawPointerPress = false
  let sawMousePress = false
  const onPointerDown = (e: MouseEvent) => {
    sawPointerPress = true
    // Card presses are let through before anything else — the old guard order
    // killed the card's own confirm/cancel handlers and stranded the spinner.
    if (isOurUi(e)) return
    swallowPress(e)
    lockTo(e)
  }
  const onMouseDown = (e: MouseEvent) => {
    sawMousePress = true
    if (isOurUi(e)) return
    swallowPress(e)
    if (!sawPointerPress) lockTo(e)
  }
  const onClick = (e: MouseEvent) => {
    const pressed = sawPointerPress || sawMousePress
    sawPointerPress = false
    sawMousePress = false
    if (isOurUi(e)) return
    swallowPress(e)
    // A click with no press at all (a synthetic `el.click()`) still picks.
    if (!pressed) lockTo(e)
  }
  /**
   * Mirrors src/lib/clipboard.ts. This function is serialized into the page, so
   * it cannot import the shared helper; execCommand runs inside the click
   * gesture and needs no clipboardWrite permission.
   */
  function copyPlainText(value: string): boolean {
    const field = document.createElement('textarea')
    field.value = value
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.top = '0'
    field.style.opacity = '0'
    ;(document.body ?? document.documentElement).appendChild(field)
    field.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      field.remove()
    }
  }

  /** Brief confirmation after the card (and overlay) are gone. */
  function showCopiedToast(text: string): void {
    document.getElementById('bc-element-picker-toast')?.remove()
    const toastHost = document.createElement('div')
    toastHost.id = 'bc-element-picker-toast'
    toastHost.style.all = 'initial'
    const toastRoot = toastHost.attachShadow({ mode: 'open' })
    toastRoot.innerHTML = `
      <style>
        :host { all: initial; }
        .toast { position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
          display: flex; align-items: center; gap: 8px; background: #111827; color: #fff;
          font: 13px -apple-system, "Segoe UI", Roboto, sans-serif; padding: 10px 14px;
          border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.3);
          pointer-events: none; z-index: 2147483648; max-width: 70vw; }
        .check { color: #a7f3d0; display: inline-flex; flex: none; }
      </style>
      <div class="toast"><span class="check">${ICON.check}</span><span data-role="toast-text"></span></div>`
    const label = toastRoot.querySelector('[data-role="toast-text"]')
    if (label) label.textContent = text
    document.documentElement.appendChild(toastHost)
    setTimeout(() => toastHost.remove(), 1800)
  }

  /** The one commit path: shared by the card button and the Enter key. */
  function confirmPick() {
    // The button's disabled state is the single authority on what is pickable
    // (an empty selector, or one matching nothing, must not be committed).
    if (confirmBtn.disabled) return
    if (mode === 'copy') {
      const el = target()
      if (!el) return
      const value = copyValueFor(el)
      if (!copyPlainText(value)) {
        noteEl.style.display = 'block'
        noteEl.style.color = '#dc2626'
        noteEl.textContent = STRINGS.copyFailed
        return
      }
      const tag = el.tagName.toLowerCase()
      const size = value.length.toLocaleString()
      cleanup()
      showCopiedToast(
        copyFormat === 'selector'
          ? STRINGS.copiedSelector(size)
          : copyFormat === 'text'
            ? STRINGS.copiedText(size, tag)
            : STRINGS.copiedHtml(size, tag),
      )
      return
    }
    void chrome.runtime.sendMessage({
      type: 'picker:result',
      pickerId,
      selector: curSelector,
      findBy: findBySel.value,
      multiple,
    })
    cleanup()
  }
  /** Copy mode is a local action: closing it must not message an editor. */
  function cancelPick() {
    cleanup()
    if (mode !== 'copy') {
      void chrome.runtime.sendMessage({ type: 'picker:cancel', pickerId })
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      cancelPick()
      return
    }
    // Enter commits without ever pressing the page — the click-free path for a
    // popover that any press would disturb. Inside the card a focused button
    // keeps its native activation, so committing here too would double-send.
    if (e.key !== 'Enter' || isOurUi(e)) return
    swallowPress(e)
    confirmPick()
  }

  card.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!btn) return
    const act = btn.dataset.act
    if (act === 'cancel') {
      cancelPick()
      return
    }
    if (act === 'confirm') {
      confirmPick()
      return
    }
    if (act === 'parent') {
      const el = target()
      if (el?.parentElement) {
        locked = el.parentElement
        refresh()
      }
    }
    if (act === 'child') {
      const el = target()
      const kid = el?.firstElementChild
      if (kid) {
        locked = kid
        refresh()
      }
    }
    if (act === 'prev-match' || act === 'next-match') {
      stepMatch(act === 'prev-match' ? -1 : 1)
      return
    }
    if (act === 'verify') {
      const dialect = findBySel.value
      const n =
        dialect === 'text'
          ? matchesByText(curSelector).length
          : count(curSelector, dialect === 'xpath')
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
  let dragDx = 0,
    dragDy = 0,
    dragging = false
  const head = card.querySelector('.pick-card-head') as HTMLElement
  head.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    dragging = true
    const r = card.getBoundingClientRect()
    dragDx = e.clientX - r.left
    dragDy = e.clientY - r.top
  })
  window.addEventListener(
    'mousemove',
    (e) => {
      if (!dragging) return
      card.style.left = `${e.clientX - dragDx}px`
      card.style.top = `${e.clientY - dragDy}px`
      card.style.bottom = 'auto'
    },
    true,
  )
  window.addEventListener(
    'mouseup',
    () => {
      dragging = false
    },
    true,
  )

  function cleanup() {
    document.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('click', onClick, true)
    window.removeEventListener('keydown', onKey, true)
    host.remove()
    if (launcherHost instanceof HTMLElement && launcherHost.isConnected) {
      launcherHost.style.display = ''
    }
  }
  // Hover stays on document (mousemove must reach the page to highlight, and a
  // hover cannot close a click-outside popover); only the press is intercepted,
  // and keys are intercepted at window capture for the same reason.
  document.addEventListener('mousemove', onMove, true)
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('click', onClick, true)
  window.addEventListener('keydown', onKey, true)
}
