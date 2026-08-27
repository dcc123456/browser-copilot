/**
 * CSS selector / XPath generation for the element picker.
 *
 * Plain DOM functions (no imports, no closure over module state) so the same
 * source can be injected into the page via `chrome.scripting.executeScript` as
 * a self-contained function. Mirrors Automa's elementSelector
 * (generateElementsSelector.js + getSelectorOptions.js): short, stable
 * selectors that prefer id, then distinctive classes, then tag + nth-of-type,
 * toggled by user-facing options.
 *
 * Also exported to unit tests under the normal module name.
 *
 * @module inpage/element-picker/build-selector
 */

export interface SelectorOptions {
  idName: boolean
  tagName: boolean
  className: boolean
  attr: boolean
  attrNames: string[]
  nthChild: boolean
}

export const DEFAULT_SELECTOR_OPTIONS: SelectorOptions = {
  idName: true,
  tagName: true,
  className: true,
  attr: false,
  attrNames: ['data-testid', 'data-test', 'name', 'type'],
  nthChild: false,
}

function cssEscape(value: string): string {
  // CSS.escape is available in page contexts; minimal fallback for safety.
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value)
  return value.replace(/([^a-zA-Z0-9_-])/g, '\\$1')
}

/** Build a selector for one element (no ancestor walking). */
function elementPart(el: Element, opts: SelectorOptions): string {
  const tag = el.tagName.toLowerCase()
  const parts: string[] = []

  if (opts.idName && el.id) {
    // Id only when it yields a unique-ish match in the document.
    parts.push(`#${cssEscape(el.id)}`)
    return parts.join('')
  }

  const tagPart = opts.tagName ? tag : ''
  let qualifiers = ''

  if (opts.className && el.classList.length) {
    const classes = Array.from(el.classList)
      .filter((c) => c && !/^\d/.test(c) && !/\s/.test(c))
      // Skip framework-generated utility chains: use up to 2 distinctive classes.
      .filter((c) => !/^(css-|jsx-|ember|sc-|ng-)/.test(c))
      .slice(0, 2)
    if (classes.length) qualifiers += classes.map((c) => `.${cssEscape(c)}`).join('')
  }

  if (opts.attr) {
    for (const attrName of opts.attrNames) {
      const v = el.getAttribute(attrName)
      if (v && !/^\d/.test(attrName)) {
        qualifiers += `[${attrName}="${v.replace(/"/g, '\\"')}"]`
        break
      }
    }
  }

  if (!qualifiers || opts.nthChild) {
    const parent = el.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === el.tagName,
      )
      if (sameTag.length > 1) {
        const idx = sameTag.indexOf(el) + 1
        qualifiers += `:nth-of-type(${idx})`
      }
    }
  }

  return tagPart + qualifiers
}

/**
 * Build the shortest *unique* CSS selector for `el` under `root` (document by
 * default), honoring the user options. Walks up ancestors until the selector
 * matches exactly one element.
 */
export function buildSelector(
  el: Element,
  root: Document | Element = document,
  opts: SelectorOptions = DEFAULT_SELECTOR_OPTIONS,
): string {
  const direct = elementPart(el, opts)
  // Id alone is unique by construction in a document.
  if (direct.startsWith('#')) {
    if (root.querySelectorAll(direct).length === 1) return direct
  }

  const chain: string[] = [direct]
  let node: Element | null = el.parentElement
  let depth = 0
  while (node && depth < 6) {
    const candidate = chain
      .slice()
      .reverse()
      .join(' > ')
    const matches = root.querySelectorAll(candidate)
    if (matches.length === 1 && matches[0] === el) return candidate
    // Id ancestors short-circuit the walk.
    if (opts.idName && node.id) {
      const withId = `#${cssEscape(node.id)} > ${chain
        .slice()
        .reverse()
        .join(' > ')}`
      if (root.querySelectorAll(withId).length === 1) return withId
    }
    chain.push(elementPart(node, opts))
    node = node.parentElement
    depth++
  }
  return chain
    .slice()
    .reverse()
    .join(' > ')
}

/** Build an XPath for the element. */
export function buildXPath(el: Element): string {
  if (el.nodeType !== 1) return ''
  // If the element has an id, use it.
  if (el.id) return `//*[@id="${el.id}"]`

  const segments: string[] = []
  let node: Element | null = el
  while (node && node.nodeType === 1) {
    const tag = node.tagName.toLowerCase()
    const parEl: Element | null = node.parentElement
    if (!parEl) {
      segments.unshift(`/${tag}`)
      break
    }
    const sameTag = Array.from(parEl.children).filter(
      (c) => (c as Element).tagName === node!.tagName,
    )
    if (sameTag.length === 1) {
      segments.unshift(`/${tag}`)
    } else {
      const idx = sameTag.indexOf(node) + 1
      segments.unshift(`/${tag}[${idx}]`)
    }
    if (parEl.id) {
      segments.unshift(`//*[@id="${parEl.id}"]`)
      break
    }
    node = parEl
  }
  return segments.join('')
}

/** The document for a given root element (Document itself, or its ownerDocument).
 *  Uses nodeType rather than `instanceof Document` so injected/test DOMs whose
 *  Document constructor differs from the page's global still resolve. */
function docOf(root: Document | Element): Document {
  const isDoc = (root as Node).nodeType === 9
  const owner = isDoc
    ? (root as Document)
    : (root as Element).ownerDocument ?? null
  return owner ?? (typeof document !== 'undefined' ? document : (root as Document))
}

/** ORDERED_NODE_SNAPSHOT_TYPE, resolved from the page window when injected. */
function xpathSnapshotType(doc: Document): number {
  // XPathResult is a window global in page contexts; derive it from the doc.
  const w = doc.defaultView as (Window & { XPathResult?: typeof XPathResult }) | null
  return w?.XPathResult?.ORDERED_NODE_SNAPSHOT_TYPE ?? 7 // 7 == ORDERED_NODE_SNAPSHOT_TYPE
}

/** Count elements matched by a CSS selector or XPath within `root`. */
export function countMatches(
  selector: string,
  mode: 'cssSelector' | 'xpath' = 'cssSelector',
  root: Document | Element = document,
): number {
  if (!selector) return 0
  try {
    if (mode === 'xpath') {
      const doc = docOf(root)
      const result = doc.evaluate(
        selector,
        root,
        null,
        xpathSnapshotType(doc),
        null,
      )
      return result.snapshotLength
    }
    return root.querySelectorAll(selector).length
  } catch {
    return 0
  }
}

/** Resolve the elements a selector/xpath matches (for highlight lists). */
export function queryMatches(
  selector: string,
  mode: 'cssSelector' | 'xpath' = 'cssSelector',
  root: Document | Element = document,
): Element[] {
  if (!selector) return []
  try {
    if (mode === 'xpath') {
      const doc = docOf(root)
      const result = doc.evaluate(
        selector,
        root,
        null,
        xpathSnapshotType(doc),
        null,
      )
      const out: Element[] = []
      for (let i = 0; i < result.snapshotLength; i++) {
        const n = result.snapshotItem(i)
        // nodeType 1 === ELEMENT_NODE (avoid `instanceof Element`: injected or
        // jsdom nodes may belong to a different Element constructor).
        if (n && (n as Node).nodeType === 1) out.push(n as Element)
      }
      return out
    }
    return Array.from(root.querySelectorAll(selector))
  } catch {
    return []
  }
}
