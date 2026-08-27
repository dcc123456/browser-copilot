/**
 * The in-page kernel: every DOM operation Browser Copilot can perform.
 *
 * ## The one rule
 *
 * `runOp` is serialized by `chrome.scripting.executeScript` and evaluated in
 * the page. Serialization captures the function *source only*, not its
 * closure, so every helper it uses must be nested inside it. A reference to
 * anything at module scope compiles fine and then fails in the page with
 * `x is not defined`, where the stack trace is least useful.
 *
 * Types are exempt: they erase at compile time, so `import type` is safe.
 *
 * The kernel is synchronous: waiting and retries are the driver's job. Each
 * injection makes one observation or performs one action and returns. An
 * in-page `await` would hold the injection open across navigations, which is
 * exactly when the context is destroyed.
 *
 * @module inpage/kernel
 */

import type { Op, OpResult, PageSnapshot, SnapshotElement, Target, TargetSpec } from '../lib/ops'

/**
 * Performs one operation in the current frame. Never throws: every failure
 * comes back as `ok: false` with a human-readable message.
 */
export function runOp(op: Op): OpResult {
  const frameUrl = location.href
  const isTopFrame = window.self === window.top

  function base(): OpResult {
    return { ok: false, found: false, frameUrl, isTopFrame }
  }
  function fail(error: string, found = true): OpResult {
    return { ...base(), found, error }
  }
  function notFound(error: string): OpResult {
    return { ...base(), found: false, error }
  }

  function collapse(text: string): string {
    return text.replace(/[\s\u00a0]+/g, ' ').trim()
  }
  function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
    if (text.length <= limit) return { text, truncated: false }
    return { text: text.slice(0, limit), truncated: true }
  }

  function visibleText(element: Element): string {
    const html = element as HTMLElement
    if (typeof html.innerText === 'string' && html.innerText.length > 0) {
      return collapse(html.innerText)
    }
    const clone = element.cloneNode(true) as HTMLElement
    clone
      .querySelectorAll('script, style, noscript, template, svg, canvas, iframe, object, embed')
      .forEach((node) => node.remove())
    return collapse(clone.textContent ?? '')
  }

  function hasLayout(): boolean {
    const root = document.documentElement
    if (!root || typeof root.getBoundingClientRect !== 'function') return false
    const rect = root.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  }
  function styleOf(element: Element): CSSStyleDeclaration | null {
    try {
      return window.getComputedStyle(element)
    } catch {
      return null
    }
  }
  function isVisible(element: Element): boolean {
    if (!element.isConnected) return false
    const html = element as HTMLElement
    if (html.hidden === true) return false
    if (element.getAttribute('aria-hidden') === 'true') return false
    if (element instanceof HTMLInputElement && element.type === 'hidden') return false

    let node: Element | null = element
    while (node) {
      const style = styleOf(node)
      if (style) {
        if (style.display === 'none') return false
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (style.opacity !== '' && Number(style.opacity) === 0) return false
      }
      node = node.parentElement
    }
    if (hasLayout()) {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 && rect.height <= 0) {
        let anyChildBox = false
        for (const child of element.children) {
          if (child.getBoundingClientRect().width > 0 || child.getBoundingClientRect().height > 0) {
            anyChildBox = true
            break
          }
        }
        if (!anyChildBox) return false
      }
    }
    return true
  }
  function isInViewport(element: Element): boolean {
    if (!hasLayout()) return true
    const rect = element.getBoundingClientRect()
    const h = window.innerHeight || document.documentElement.clientHeight || 0
    const w = window.innerWidth || document.documentElement.clientWidth || 0
    return rect.bottom > 0 && rect.right > 0 && rect.top < h && rect.left < w
  }
  function isDisabled(element: Element): boolean {
    if ((element as HTMLInputElement).disabled === true) return true
    if (element.getAttribute('aria-disabled') === 'true') return true
    const fieldset = element.closest('fieldset[disabled]')
    if (fieldset && !element.closest('fieldset[disabled] > legend:first-of-type')) return true
    return false
  }

  // --- Roles & names ---------------------------------------------------------

  function roleOf(element: Element): string {
    const explicit = element.getAttribute('role')
    if (explicit) return explicit.trim().split(/\s+/)[0] ?? ''
    const tag = element.tagName.toLowerCase()
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'button') return 'button'
    if (tag === 'select') return (element as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (tag === 'img') return 'img'
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'table') return 'table'
    if (tag === 'form') return 'form'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') {
      const type = ((element as HTMLInputElement).type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image')
        return 'button'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'search') return 'searchbox'
      if (type === 'hidden') return 'none'
      return 'textbox'
    }
    return 'generic'
  }

  function accessibleName(element: Element): string {
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const parts: string[] = []
      for (const id of labelledBy.trim().split(/\s+/)) {
        const ref = document.getElementById(id)
        if (ref) parts.push(visibleText(ref))
      }
      const joined = collapse(parts.join(' '))
      if (joined) return joined
    }
    const ariaLabel = element.getAttribute('aria-label')
    if (ariaLabel && collapse(ariaLabel)) return collapse(ariaLabel)

    const labelable = element as HTMLInputElement
    if (typeof labelable.labels !== 'undefined' && labelable.labels) {
      const parts: string[] = []
      for (let i = 0; i < labelable.labels.length; i += 1) {
        const label = labelable.labels[i]
        if (label) parts.push(visibleText(label))
      }
      const joined = collapse(parts.join(' '))
      if (joined) return joined
    } else if (element.id) {
      const escaped = element.id.replace(/["\\]/g, '\\$&')
      const label = document.querySelector(`label[for="${escaped}"]`)
      if (label) {
        const text = visibleText(label)
        if (text) return text
      }
    }
    const wrapping = element.closest('label')
    if (wrapping) {
      const text = visibleText(wrapping)
      if (text) return text
    }
    const placeholder = element.getAttribute('placeholder')
    if (placeholder && collapse(placeholder)) return collapse(placeholder)
    const title = element.getAttribute('title')
    if (title && collapse(title)) return collapse(title)
    const alt = element.getAttribute('alt')
    if (alt && collapse(alt)) return collapse(alt)
    if (element instanceof HTMLInputElement) {
      const type = (element.type || '').toLowerCase()
      if (type === 'submit' || type === 'button' || type === 'reset') {
        if (collapse(element.value)) return collapse(element.value)
      }
      return ''
    }
    const own = visibleText(element)
    return own.length <= 120 ? own : own.slice(0, 120)
  }

  // --- Selectors -------------------------------------------------------------

  const TEST_ID_ATTRIBUTES = [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-cy',
    'data-qa',
    'data-automation-id',
  ]

  function looksUnstable(value: string): boolean {
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 64) return true
    const patterns = [
      /^[0-9]/,
      /^(?:ember|react|vue|ng|mui|css|sc|jss|radix|headlessui)[-_]?[a-z]*[-_]?\d/i,
      /^:r[0-9a-z]+:$/i,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      /^[0-9a-f]{16,}$/i,
      /\d{5,}/,
      /^[a-z0-9_-]*[a-f0-9]{6,}[a-z0-9_-]*$/i,
    ]
    return patterns.some((pattern) => pattern.test(trimmed))
  }
  function quoteAttr(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  function indexAmongType(element: Element): number {
    let index = 1
    let sibling = element.previousElementSibling
    while (sibling) {
      if (sibling.tagName === element.tagName) index += 1
      sibling = sibling.previousElementSibling
    }
    return index
  }
  function cssPath(element: Element): string {
    const parts: string[] = []
    let node: Element | null = element
    let depth = 0
    while (node && node.nodeType === 1 && depth < 12) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag)
        break
      }
      if (node.id && !looksUnstable(node.id)) {
        parts.unshift(`${tag}[id=${quoteAttr(node.id)}]`)
        break
      }
      const parent: Element | null = node.parentElement
      const sameTagSiblings = parent
        ? Array.prototype.filter.call(
            parent.children,
            (child: Element) => child.tagName === node?.tagName,
          ).length
        : 1
      parts.unshift(sameTagSiblings > 1 ? `${tag}:nth-of-type(${indexAmongType(node)})` : tag)
      node = parent
      depth += 1
    }
    return parts.join(' > ')
  }

  function scoreSpec(spec: TargetSpec): number {
    const table: Record<string, number> = {
      testid: 100,
      id: 80,
      name: 70,
      role: 60,
      text: 40,
      css: 20,
    }
    let score = table[spec.how] ?? 0
    if (typeof spec.nth === 'number' && spec.nth > 0) score -= 8
    if (spec.how === 'css') score -= Math.min(15, spec.value.split('>').length)
    if (spec.how === 'text' && spec.value.length > 40) score -= 5
    return score
  }
  function serializeSpec(spec: TargetSpec): string {
    const parts = [spec.how, spec.value]
    if (spec.role) parts.push(`role=${spec.role}`)
    if (spec.tag) parts.push(`tag=${spec.tag}`)
    if (typeof spec.nth === 'number') parts.push(`nth=${spec.nth}`)
    return parts.join('|')
  }

  function safeQuery(selector: string): Element[] {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(selector)) as Element[]
    } catch {
      return []
    }
  }
  /** Resolve an XPath expression to element matches (7 = ORDERED_NODE_SNAPSHOT). */
  function xpathQuery(xpath: string): Element[] {
    try {
      const result = document.evaluate(xpath, document, null, 7, null)
      const out: Element[] = []
      for (let i = 0; i < result.snapshotLength; i++) {
        const n = result.snapshotItem(i)
        if (n && (n as Node).nodeType === 1) out.push(n as Element)
      }
      return out
    } catch {
      return []
    }
  }
  function queryAll(spec: TargetSpec): Element[] {
    const tagPrefix = spec.tag ?? ''
    switch (spec.how) {
      case 'testid': {
        const sep = spec.value.indexOf('=')
        const attr = sep === -1 ? 'data-testid' : spec.value.slice(0, sep)
        const value = sep === -1 ? spec.value : spec.value.slice(sep + 1)
        return safeQuery(`${tagPrefix}[${attr}=${quoteAttr(value)}]`)
      }
      case 'id':
        return safeQuery(`${tagPrefix}[id=${quoteAttr(spec.value)}]`)
      case 'name':
        return safeQuery(`${tagPrefix}[name=${quoteAttr(spec.value)}]`)
      case 'css':
        // XPath locators are encoded with an `xpath:` prefix by the engine
        // (Automa blocks can set findBy='xpath'); resolve them via evaluate.
        if (spec.value.startsWith('xpath:')) {
          return xpathQuery(spec.value.slice('xpath:'.length))
        }
        return safeQuery(spec.value)
      case 'role': {
        const wanted = (spec.role ?? '').toLowerCase()
        const all = safeQuery('*')
        const found: Element[] = []
        for (const candidate of all) {
          if (roleOf(candidate).toLowerCase() !== wanted) continue
          if (spec.value && accessibleName(candidate) !== spec.value) continue
          found.push(candidate)
        }
        return found
      }
      case 'text': {
        const wanted = spec.value
        const all = safeQuery(tagPrefix || '*')
        const exact: Element[] = []
        for (const candidate of all) {
          if (visibleText(candidate) !== wanted) continue
          let hasMatchingDescendant = false
          const descendants = candidate.querySelectorAll(tagPrefix || '*')
          for (let i = 0; i < descendants.length; i += 1) {
            const descendant = descendants[i]
            if (descendant && visibleText(descendant) === wanted) {
              hasMatchingDescendant = true
              break
            }
          }
          if (!hasMatchingDescendant) exact.push(candidate)
        }
        return exact
      }
    }
  }

  function specsFor(element: Element): TargetSpec[] {
    const specs: TargetSpec[] = []
    const tag = element.tagName.toLowerCase()
    const withIndex = (spec: TargetSpec): TargetSpec => {
      const matches = queryAll(spec)
      if (matches.length <= 1) return spec
      const position = matches.indexOf(element)
      if (position <= 0) return position === 0 ? spec : { ...spec, nth: 0 }
      return { ...spec, nth: position }
    }
    for (const attribute of TEST_ID_ATTRIBUTES) {
      const value = element.getAttribute(attribute)
      if (value && value.trim()) {
        const stored = attribute === 'data-testid' ? value : `${attribute}=${value}`
        specs.push(withIndex({ how: 'testid', value: stored }))
        break
      }
    }
    if (element.id && !looksUnstable(element.id)) {
      specs.push(withIndex({ how: 'id', value: element.id }))
    }
    const name = element.getAttribute('name')
    if (name && name.trim() && !looksUnstable(name)) {
      specs.push(withIndex({ how: 'name', value: name, tag }))
    }
    const role = roleOf(element)
    const label = accessibleName(element)
    if (role && role !== 'generic' && role !== 'none' && label && label.length <= 80) {
      specs.push(withIndex({ how: 'role', value: label, role }))
    }
    const own = visibleText(element)
    if (own && own.length <= 80 && element.children.length === 0) {
      specs.push(withIndex({ how: 'text', value: own, tag }))
    }
    specs.push(withIndex({ how: 'css', value: cssPath(element) }))
    return specs
  }

  function targetFor(element: Element): Target {
    const specs = specsFor(element)
    const unique: TargetSpec[] = []
    const seen: Record<string, boolean> = {}
    for (const spec of specs) {
      const key = serializeSpec(spec)
      if (seen[key]) continue
      seen[key] = true
      unique.push(spec)
    }
    unique.sort((a, b) => scoreSpec(b) - scoreSpec(a))
    const primary = unique[0] ?? { how: 'css' as const, value: cssPath(element) }
    const label = accessibleName(element) || visibleText(element).slice(0, 60)
    const built: Target = { primary, fallbacks: unique.slice(1) }
    if (!isTopFrame) built.frameHint = frameUrl
    if (label) built.label = label
    return built
  }

  interface Resolution {
    element: Element
    matched: number
    usedSpec: string
    usedFallback: boolean
  }

  function resolve(target: Target | undefined): Resolution | null {
    if (!target) return null
    const candidates: TargetSpec[] = [target.primary, ...(target.fallbacks ?? [])]
    for (let index = 0; index < candidates.length; index += 1) {
      const spec = candidates[index]
      if (!spec) continue
      const all = queryAll(spec)
      if (all.length === 0) continue
      let chosen: Element | undefined
      if (typeof spec.nth === 'number') {
        chosen = all[spec.nth]
      } else {
        const visible = all.filter((element) => isVisible(element))
        chosen = visible[0] ?? all[0]
      }
      if (!chosen) continue
      return {
        element: chosen,
        matched: all.length,
        usedSpec: serializeSpec(spec),
        usedFallback: index > 0,
      }
    }
    return null
  }

  // --- Interaction helpers ---------------------------------------------------

  function scrollIntoView(element: Element): void {
    try {
      element.scrollIntoView({ block: 'center', inline: 'center' })
    } catch {
      try {
        ;(element as HTMLElement).scrollIntoView()
      } catch {
        /* nothing */
      }
    }
  }
  function describeElement(element: Element): string {
    const tag = element.tagName.toLowerCase()
    const name = accessibleName(element)
    return name ? `<${tag}> "${name}"` : `<${tag}>`
  }
  function dispatchMouse(element: Element, type: string): void {
    const rect = hasLayout()
      ? element.getBoundingClientRect()
      : ({ left: 0, top: 0, width: 0, height: 0 } as DOMRect)
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: document.defaultView ?? undefined,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      buttons: type === 'mouseup' || type === 'click' ? 0 : 1,
    }
    try {
      if (typeof PointerEvent === 'function' && type.startsWith('pointer')) {
        element.dispatchEvent(
          new PointerEvent(type, { ...init, pointerId: 1, isPrimary: true }),
        )
        return
      }
      element.dispatchEvent(new MouseEvent(type, init))
    } catch {
      element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
    }
  }
  function setControlValue(element: Element, value: string): void {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value)
    } else {
      ;(element as HTMLInputElement).value = value
    }
  }
  function fireInputAndChange(element: Element): void {
    const inputEvent =
      typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, cancelable: false })
        : new Event('input', { bubbles: true })
    element.dispatchEvent(inputEvent)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }
  function focusElement(element: Element): void {
    try {
      ;(element as HTMLElement).focus({ preventScroll: true })
    } catch {
      try {
        ;(element as HTMLElement).focus()
      } catch {
        /* not focusable */
      }
    }
  }
  function mayNavigate(element: Element): boolean {
    const tag = element.tagName.toLowerCase()
    if (tag === 'a' && element.hasAttribute('href')) {
      const href = element.getAttribute('href') ?? ''
      return !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:')
    }
    if (element instanceof HTMLInputElement && element.type === 'submit') return true
    if (element instanceof HTMLButtonElement) {
      const type = (element.getAttribute('type') ?? 'submit').toLowerCase()
      return type === 'submit' && element.form !== null
    }
    return false
  }
  function occludedBy(element: Element): Element | null {
    if (!hasLayout() || typeof document.elementFromPoint !== 'function') return null
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const top = document.elementFromPoint(x, y)
    if (!top || top === element || element.contains(top) || top.contains(element)) return null
    return top
  }

  // --- Snapshot --------------------------------------------------------------

  function buildSnapshot(maxChars: number, maxElements: number): PageSnapshot {
    const interactiveSelector = [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      'summary',
      '[role]',
      '[tabindex]',
      '[contenteditable="true"]',
      '[onclick]',
    ].join(', ')

    const seen: Element[] = []
    for (const candidate of safeQuery(interactiveSelector)) {
      const role = roleOf(candidate)
      if (role === 'none' || role === 'presentation') continue
      if (!isVisible(candidate)) continue
      if (seen.indexOf(candidate) !== -1) continue
      seen.push(candidate)
    }

    const elements: SnapshotElement[] = []
    const limit = Math.max(1, maxElements)
    for (let i = 0; i < seen.length && elements.length < limit; i += 1) {
      const element = seen[i]
      if (!element) continue
      const tag = element.tagName.toLowerCase()
      const input = element as HTMLInputElement
      const type = tag === 'input' ? (input.type || 'text').toLowerCase() : undefined
      const entry: SnapshotElement = {
        ref: `e${elements.length + 1}`,
        role: roleOf(element),
        name: accessibleName(element),
        tag,
        inViewport: isInViewport(element),
        target: targetFor(element),
      }
      if (type) entry.type = type
      if (type !== 'password' && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
        const value = String(input.value ?? '')
        if (value) entry.value = value.length > 120 ? `${value.slice(0, 120)}…` : value
      }
      const placeholder = collapse(element.getAttribute('placeholder') ?? '')
      if (placeholder && placeholder !== entry.name) entry.placeholder = placeholder
      if (tag === 'a') {
        const href = (element as HTMLAnchorElement).href
        if (href) entry.href = href.length > 200 ? `${href.slice(0, 200)}…` : href
      }
      if (isDisabled(element)) entry.disabled = true
      if ((element as HTMLInputElement).required) entry.required = true
      if (type === 'checkbox' || type === 'radio') entry.checked = input.checked === true
      elements.push(entry)
    }

    const refByElement = new Map<Element, string>()
    for (let i = 0; i < elements.length; i += 1) {
      const element = seen[i]
      const entry = elements[i]
      if (element && entry) refByElement.set(element, entry.ref)
    }

    const forms: PageSnapshot['forms'] = []
    for (const form of safeQuery('form')) {
      if (!isVisible(form)) continue
      const fields: PageSnapshot['forms'][number]['fields'] = []
      const controls = form.querySelectorAll('input, select, textarea')
      for (let i = 0; i < controls.length; i += 1) {
        const control = controls[i]
        if (!control || !isVisible(control)) continue
        const ref = refByElement.get(control)
        if (!ref) continue
        const tag = control.tagName.toLowerCase()
        const field: PageSnapshot['forms'][number]['fields'][number] = {
          ref,
          label: accessibleName(control),
          tag,
        }
        if (tag === 'input')
          field.type = ((control as HTMLInputElement).type || 'text').toLowerCase()
        if ((control as HTMLInputElement).required) field.required = true
        if (control instanceof HTMLSelectElement) {
          const options: string[] = []
          for (let o = 0; o < control.options.length; o += 1) {
            const option = control.options[o]
            if (option) options.push(collapse(option.textContent ?? '') || option.value)
          }
          field.options = options
        }
        fields.push(field)
      }
      if (fields.length > 0) {
        forms.push({
          name: form.getAttribute('name') ?? form.id ?? accessibleName(form),
          fields,
        })
      }
    }

    const body = document.body ?? document.documentElement
    const rawText = body ? visibleText(body) : ''
    const { text, truncated } = truncateText(rawText, Math.max(200, maxChars))
    const selection = collapse(window.getSelection()?.toString() ?? '')

    return {
      url: location.href,
      title: document.title,
      text,
      truncated,
      selection,
      elements,
      elementsTruncated: seen.length > elements.length,
      frameUrl,
      isTopFrame,
      forms,
      scrollHeight: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight,
    }
  }

  // --- Capture (full-page / element) -----------------------------------------

  /**
   * Renders a DOM node (the document or a matched element) to a PNG data URL by
   * serializing it into an `<svg><foreignObject>`, drawing that into a canvas,
   * and reading `toDataURL`. Returns `null` when the target is missing or the
   * canvas is tainted (e.g. cross-origin images without CORS).
   */
  async function captureNode(selector: string): Promise<OpResult> {
    const host = selector
      ? (document.querySelector(selector) as HTMLElement | null)
      : document.documentElement
    if (!host) {
      return { ...base(), ok: false, found: false, error: `capture: 未找到元素 "${selector}"` }
    }
    try {
      const width = host.scrollWidth || host.offsetWidth || 1280
      const height = host.scrollHeight || host.offsetHeight || 800
      const markup = new XMLSerializer().serializeToString(host)
      const data = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
      const image = new Image()
      const decoded = await new Promise<HTMLImageElement>((resolve, reject) => {
        image.onload = (): void => resolve(image)
        image.onerror = (): void => reject(new Error('capture: SVG 加载失败'))
        image.src = data
      })
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('capture: 无法创建画布')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
      context.drawImage(decoded, 0, 0, width, height)
      return { ...base(), ok: true, found: true, note: 'captured', data: canvas.toDataURL('image/png') }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      return { ...base(), ok: false, found: true, error: `capture: ${text}` }
    }
  }

  // --- Dispatch --------------------------------------------------------------

  try {
    if (op.action === 'snapshot') {
      const page = buildSnapshot(op.maxChars ?? 8000, op.maxElements ?? 120)
      return { ...base(), ok: true, found: true, page }
    }

    if (op.action === 'capture') {
      // Returns a Promise; chrome.scripting.executeScript awaits it. The driver
      // reads `injection.result` after resolution, which is an OpResult.
      return captureNode(op.value ? String(op.value) : '') as unknown as OpResult
    }

    if (op.action === 'scroll' && !op.target) {
      const spec = op.scroll ?? { mode: 'by' as const, y: 600 }
      const behavior: ScrollBehavior = spec.mode === 'incremental' || 'smooth' in spec && spec.smooth ? 'smooth' : 'auto'
      try {
        if (spec.mode === 'top') window.scrollTo({ top: 0, left: 0, behavior })
        else if (spec.mode === 'bottom')
          window.scrollTo({ top: document.documentElement.scrollHeight ?? 0, left: 0, behavior })
        else window.scrollBy({ top: 'y' in spec ? (spec.y ?? 0) : 0, left: 'x' in spec ? (spec.x ?? 0) : 0, behavior })
      } catch {
        /* no scrolling */
      }
      return { ...base(), ok: true, found: true, note: `scrolled ${spec.mode}` }
    }

    if (op.action === 'press_key' && !op.target) {
      const key = String(op.value ?? '')
      if (!key) return fail('press_key needs a key name.')
      const active = (document.activeElement ?? document.body) as Element
      const init: KeyboardEventInit = { key, code: key, bubbles: true, cancelable: true }
      active.dispatchEvent(new KeyboardEvent('keydown', init))
      active.dispatchEvent(new KeyboardEvent('keyup', init))
      return { ...base(), ok: true, found: true, note: `pressed ${key}` }
    }

    if (op.action === 'element_exists' || op.action === 'count_elements') {
      const selector = String(op.value ?? '')
      const matches = safeQuery(selector)
      const count = matches.length
      if (op.action === 'count_elements')
        return { ...base(), ok: true, found: true, note: `count=${count}`, data: count }
      return {
        ...base(),
        ok: true,
        found: count > 0,
        note: count > 0 ? `存在 ${count} 个匹配元素` : '未找到匹配元素',
        data: count,
      }
    }

    if (op.action === 'read_form') {
      const results: Record<string, unknown> = {}
      const selector = op.value ? String(op.value) : 'input, select, textarea'
      const controls = safeQuery(selector)
      for (let i = 0; i < controls.length; i += 1) {
        const control = controls[i] as HTMLInputElement | HTMLTextAreaElement
        const name = control.getAttribute('name') || control.id || `field${i}`
        if (name in results) continue
        if (control instanceof HTMLTextAreaElement) {
          results[name] = control.value
        } else if (control instanceof HTMLSelectElement) {
          results[name] = control.multiple
            ? Array.from(control.selectedOptions).map((o) => o.value)
            : control.value
        } else {
          const type = (control.type || 'text').toLowerCase()
          if (type === 'checkbox') results[name] = control.checked
          else if (type === 'radio') {
            if (control.checked) results[name] = control.value
          } else results[name] = control.value
        }
      }
      return { ...base(), ok: true, found: true, note: '已读取表单', data: results }
    }

    if (op.action === 'create_element') {
      const html = String(op.value ?? '')
      const wrapper = document.createElement('div')
      wrapper.innerHTML = html
      const inserted = Array.prototype.slice.call(wrapper.children) as Element[]
      for (const child of inserted) document.body.appendChild(child)
      return { ...base(), ok: true, found: true, note: `created ${inserted.length} element(s)` }
    }

    if (op.action === 'handle_dialog') {
      try {
        // Auto-accept confirm() and suppress beforeunload prompts so a workflow
        // that navigates or triggers dialogs keeps moving. Goes through
        // descriptors so pages that froze these globals can still be coerced.
        const set = (target: unknown, key: string, value: unknown): void => {
          try {
            Object.defineProperty(target, key, { value, configurable: true, writable: true })
          } catch {
            ;(target as Record<string, unknown>)[key] = value
          }
        }
        set(window, 'onbeforeunload', null)
        set(window, 'confirm', () => true)
      } catch {
        /* handlers may be non-configurable on some pages */
      }
      return { ...base(), ok: true, found: true, note: '对话框处理已启用' }
    }

    if (!op.target) return fail(`${op.action} needs a target element.`, false)

    // waitForSelector (Automa): recorded interaction blocks poll up to
    // `waitFor` ms for the element to appear before acting, so steps that
    // navigate first don't race post-load content. Re-enters runOp once the
    // element exists (waitFor zeroed to avoid polling again). The returned
    // Promise is awaited by chrome.scripting, like capture().
    const waitMs = typeof op.waitFor === 'number' && op.waitFor > 0 ? op.waitFor : 0
    if (waitMs) {
      const target = op.target
      const tried = [target.primary, ...(target.fallbacks ?? [])]
        .map((spec) => serializeSpec(spec))
        .join(', ')
      return (async () => {
        const deadline = Date.now() + waitMs
        let res = resolve(target)
        while (!res && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 120))
          res = resolve(target)
        }
        if (!res) return notFound(`No element matched within ${waitMs}ms. Tried: ${tried}`)
        op.waitFor = 0
        return runOp(op)
      })() as unknown as OpResult
    }

    const resolution = resolve(op.target)
    if (!resolution) {
      const tried = [op.target.primary, ...(op.target.fallbacks ?? [])]
        .map((spec) => serializeSpec(spec))
        .join(', ')
      return notFound(`No element matched. Tried: ${tried}`)
    }

    const element = resolution.element
    const withMeta = (result: OpResult): OpResult => ({
      ...result,
      matched: resolution.matched,
      usedSpec: resolution.usedSpec,
      usedFallback: resolution.usedFallback,
    })

    if (op.action === 'wait_for') {
      const visible = isVisible(element)
      return withMeta({
        ...base(),
        ok: visible,
        found: true,
        ...(visible ? {} : { error: `${describeElement(element)} exists but is not visible.` }),
      })
    }

    if (op.action === 'scroll') {
      const spec = op.scroll ?? { mode: 'into_view' as const }
      const behavior: ScrollBehavior = spec.mode === 'into_view' ? 'auto' : spec.mode === 'incremental' || 'smooth' in spec && spec.smooth ? 'smooth' : 'auto'
      try {
        if (spec.mode === 'into_view') scrollIntoView(element)
        else if (spec.mode === 'by' || spec.mode === 'incremental') {
          ;(element as HTMLElement).scrollBy?.({
            top: 'y' in spec ? (spec.y ?? 0) : 0,
            left: 'x' in spec ? (spec.x ?? 0) : 0,
            behavior,
          })
        } else if (spec.mode === 'top') (element as HTMLElement).scrollTo?.({ top: 0, behavior })
        else (element as HTMLElement).scrollTo?.({ top: element.scrollHeight, behavior })
      } catch {
        /* no scrolling */
      }
      return withMeta({ ...base(), ok: true, found: true })
    }

    scrollIntoView(element)
    if (!isVisible(element)) {
      return withMeta(fail(`${describeElement(element)} exists but is not visible.`))
    }

    if (op.action === 'hover') {
      dispatchMouse(element, 'pointerover')
      dispatchMouse(element, 'mouseover')
      dispatchMouse(element, 'mousemove')
      return withMeta({ ...base(), ok: true, found: true })
    }

    if (op.action === 'click') {
      if (isDisabled(element))
        return withMeta(fail(`${describeElement(element)} is disabled.`))
      const blocker = occludedBy(element)
      if (blocker)
        return withMeta(
          fail(
            `${describeElement(element)} is covered by ${describeElement(blocker)}; a click would not reach it.`,
          ),
        )
      const navigates = mayNavigate(element)
      dispatchMouse(element, 'pointerdown')
      dispatchMouse(element, 'mousedown')
      focusElement(element)
      dispatchMouse(element, 'pointerup')
      dispatchMouse(element, 'mouseup')
      ;(element as HTMLElement).click()
      return withMeta({ ...base(), ok: true, found: true, mayNavigate: navigates })
    }

    if (op.action === 'fill') {
      if (isDisabled(element))
        return withMeta(fail(`${describeElement(element)} is disabled.`))
      const value = op.value === undefined || op.value === null ? '' : String(op.value)
      const editable = element.getAttribute('contenteditable')
      focusElement(element)
      if (editable === '' || editable === 'true') {
        ;(element as HTMLElement).textContent = value
        fireInputAndChange(element)
        return withMeta({ ...base(), ok: true, found: true })
      }
      const isField =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      if (!isField)
        return withMeta(
          fail(`${describeElement(element)} is not a text field, select, or textarea.`),
        )
      if (element instanceof HTMLInputElement) {
        const type = (element.type || 'text').toLowerCase()
        if (type === 'checkbox' || type === 'radio')
          return withMeta(fail(`${describeElement(element)} is a ${type}; use set_checkbox.`))
        if (type === 'file')
          return withMeta(fail('File inputs cannot be filled by an extension.'))
      }
      const next =
        op.clear === false ? `${(element as HTMLInputElement).value ?? ''}${value}` : value
      setControlValue(element, next)
      fireInputAndChange(element)
      return withMeta({ ...base(), ok: true, found: true })
    }

    if (op.action === 'select_option') {
      if (!(element instanceof HTMLSelectElement))
        return withMeta(fail(`${describeElement(element)} is not a <select>.`))
      const wanted = Array.isArray(op.value) ? op.value.map(String) : [String(op.value ?? '')]
      const available: string[] = []
      const chosen: HTMLOptionElement[] = []
      for (let i = 0; i < element.options.length; i += 1) {
        const option = element.options[i]
        if (!option) continue
        const label = collapse(option.textContent ?? '')
        available.push(label || option.value)
        if (wanted.indexOf(option.value) !== -1 || wanted.indexOf(label) !== -1)
          chosen.push(option)
      }
      if (chosen.length === 0)
        return withMeta(
          fail(`No option matched ${JSON.stringify(wanted)}. Available: ${available.join(', ')}`),
        )
      focusElement(element)
      if (element.multiple) {
        for (let i = 0; i < element.options.length; i += 1) {
          const option = element.options[i]
          if (option) option.selected = chosen.indexOf(option) !== -1
        }
      } else {
        const first = chosen[0]
        if (first) setControlValue(element, first.value)
      }
      fireInputAndChange(element)
      return withMeta({ ...base(), ok: true, found: true })
    }

    if (op.action === 'set_checkbox') {
      const input = element as HTMLInputElement
      const type = (input.type || '').toLowerCase()
      if (type !== 'checkbox' && type !== 'radio')
        return withMeta(fail(`${describeElement(element)} is not a checkbox or radio.`))
      if (isDisabled(element)) return withMeta(fail(`${describeElement(element)} is disabled.`))
      const desired = op.value === undefined ? true : op.value === true || op.value === 'true'
      if (input.checked === desired)
        return withMeta({ ...base(), ok: true, found: true, note: 'already in desired state' })
      ;(element as HTMLElement).click()
      const ok = input.checked === desired
      return withMeta({
        ...base(),
        ok,
        found: true,
        ...(ok ? {} : { error: 'The control did not change state.' }),
      })
    }

    if (op.action === 'get_attribute') {
      const attribute = String(op.attribute ?? '')
      if (!attribute) return withMeta(fail('get_attribute needs an attribute name.'))
      const value = element.getAttribute(attribute) ?? ''
      return withMeta({ ...base(), ok: true, found: true, note: value, data: value })
    }

    if (op.action === 'set_attribute') {
      const attribute = String(op.attribute ?? '')
      if (!attribute) return withMeta(fail('set_attribute needs an attribute name.'))
      const value = String(op.value ?? '')
      if (value === '') element.removeAttribute(attribute)
      else element.setAttribute(attribute, value)
      return withMeta({ ...base(), ok: true, found: true, note: `set ${attribute}` })
    }

    if (op.action === 'click_link') {
      const href = (element as HTMLAnchorElement).href
      const tag = element.tagName.toLowerCase()
      if (tag !== 'a' || !href) return withMeta(fail(`${describeElement(element)} is not a clickable link.`))
      const target = (element as HTMLAnchorElement).target
      return withMeta({
        ...base(),
        ok: true,
        found: true,
        mayNavigate: true,
        note: href,
        data: { href, target: target ?? '_self' },
      })
    }

    if (op.action === 'trigger_event') {
      const eventName = String(op.attribute ?? '')
      if (!eventName) return withMeta(fail('trigger_event needs an event name.'))
      let detail: unknown
      try {
        detail = JSON.parse(String(op.value ?? 'null'))
      } catch {
        detail = String(op.value ?? '')
      }
      const useBubbles = () => {
        const maybe = eventName.toLowerCase()
        return maybe.indexOf('mouse') === -1 && maybe.indexOf('click') === -1
      }
      element.dispatchEvent(new CustomEvent(eventName, { bubbles: useBubbles(), detail }))
      return withMeta({ ...base(), ok: true, found: true, note: `dispatched ${eventName}` })
    }

    if (op.action === 'press_key') {
      const key = String(op.value ?? '')
      if (!key) return withMeta(fail('press_key needs a key name.'))
      focusElement(element)
      const init: KeyboardEventInit = { key, code: key, bubbles: true, cancelable: true }
      element.dispatchEvent(new KeyboardEvent('keydown', init))
      element.dispatchEvent(new KeyboardEvent('keypress', init))
      element.dispatchEvent(new KeyboardEvent('keyup', init))
      let navigates = false
      if (key === 'Enter') {
        const form = (element as HTMLInputElement).form
        if (form) {
          navigates = true
          if (typeof form.requestSubmit === 'function') form.requestSubmit()
          else form.submit()
        }
      }
      return withMeta({ ...base(), ok: true, found: true, mayNavigate: navigates })
    }

    return fail(`${op.action} is not something the kernel can do.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...base(), error: `In-page failure: ${message}` }
  }
}
