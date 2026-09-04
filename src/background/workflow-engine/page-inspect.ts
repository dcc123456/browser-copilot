/**
 * Live page inspection for the AI workflow debugger.
 *
 * When a run fails on a selector, the model repairs far better from REAL
 * elements than from guesses. This module injects one closure-free function
 * into the page the run is driving (same pattern as `ai-agent-executor`'s
 * element reader) and reports:
 * - `target`: what the failed selector matches today (tag/id/classes/text),
 * - `candidates`: elements whose tag/classes resemble the failed selector —
 *   where a corrected selector usually lives,
 * - `interactive`: the page's actionable elements with generated CSS paths.
 *
 * Everything is best-effort: any failure resolves `null` and the debugger
 * simply continues without the page view.
 *
 * @module background/workflow-engine/page-inspect
 */
import { resolveAutomationTab } from '../driver'
import type { ScopeWindow } from '../automation-scope'

/** Compact description of one page element, as shipped to the model. */
export interface InspectedElement {
  /** Generated CSS path usable as a block selector. */
  selector: string
  tag: string
  id?: string
  classes?: string
  text?: string
}

export interface PageInspection {
  target: {
    selectorUsed: string
    found: boolean
    /** How many elements the selector matched (0 when not found). */
    matches: number
    info?: InspectedElement
  }
  candidates: InspectedElement[]
  interactive: InspectedElement[]
}

/** Text cap per element so one element can't blow the model context. */
const TEXT_CAP = 80
/** Caps on list sizes shipped to the model. */
const MAX_CANDIDATES = 6
const MAX_INTERACTIVE = 15

/**
 * Top-level injected function (no closures): inspects the page around
 * `selector`. Must stay serializable for `chrome.scripting.executeScript`.
 */
function inspectPageInPage(selector: string): PageInspection {
  const cap = (text: string | null | undefined, max: number): string =>
    (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

  /** Short, stable CSS path: #id, unique tag.class, else nth-child chain. */
  function cssPathOf(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`
    const tag = el.tagName.toLowerCase()
    const classList = (el as HTMLElement).classList
    if (classList && classList.length > 0) {
      for (const cls of Array.from(classList).slice(0, 3)) {
        const withClass = `${tag}.${CSS.escape(cls)}`
        try {
          const matches = el.ownerDocument.querySelectorAll(withClass)
          if (matches.length === 1) return withClass
        } catch {
          /* invalid class token — try the next one */
        }
      }
    }
    const parts: string[] = []
    let node: Element | null = el
    let depth = 0
    while (node && node !== document.body && depth < 4) {
      // Explicit annotation breaks the node → parent → node narrowing cycle.
      const parent: HTMLElement | null = node.parentElement
      if (!parent) break
      const current: Element = node
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === current.tagName)
      const tag = current.tagName.toLowerCase()
      const index = Array.prototype.indexOf.call(parent.children, current) + 1
      parts.unshift(sameTag.length === 1 ? tag : `${tag}:nth-child(${index})`)
      node = parent
      depth += 1
    }
    return parts.length > 0 ? parts.join(' > ') : tag
  }

  function infoOf(el: Element): InspectedElement {
    const classes =
      typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : ''
    const info: InspectedElement = {
      selector: cssPathOf(el),
      tag: el.tagName.toLowerCase(),
      ...(el.id ? { id: el.id } : {}),
      ...(classes ? { classes: cap(classes, 80) } : {}),
      text: cap(el.textContent, TEXT_CAP),
    }
    return info
  }

  /** Resolves an XPath expression to its first node (when the selector is one). */
  function xpathFirst(expression: string): Element | null {
    try {
      const result = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
      return (result.singleNodeValue as Element | null) ?? null
    } catch {
      return null
    }
  }

  const isXpath = /^\s*[/(]/.test(selector)
  let target: PageInspection['target']
  if (isXpath) {
    const el = xpathFirst(selector)
    target = { selectorUsed: selector, found: !!el, matches: el ? 1 : 0, ...(el ? { info: infoOf(el) } : {}) }
  } else {
    let matched: Element[] = []
    try {
      matched = Array.from(document.querySelectorAll(selector))
    } catch {
      matched = []
    }
    target = {
      selectorUsed: selector,
      found: matched.length > 0,
      matches: matched.length,
      ...(matched.length > 0 ? { info: infoOf(matched[0]!) } : {}),
    }
  }

  // Candidates: elements sharing the failed selector's last compound's tag or
  // class tokens — the natural home of a corrected selector.
  const candidates: InspectedElement[] = []
  const seen = new Set<Element>()
  const pushCandidate = (el: Element): void => {
    if (seen.has(el) || candidates.length >= MAX_CANDIDATES) return
    seen.add(el)
    candidates.push(infoOf(el))
  }
  if (target.found) {
    // The selector still matches — the failure is elsewhere; offer the
    // target's own siblings as context instead of lookalikes.
    const info = target.info!
    if (info.selector) {
      try {
        for (const el of Array.from(document.querySelectorAll(info.selector)).slice(0, 2)) {
          pushCandidate(el)
        }
      } catch {
        /* ignore */
      }
    }
  } else if (!isXpath) {
    const compound = selector.split(/[\s>]+/).pop() ?? ''
    const tagMatch = /^[a-z][a-z0-9-]*/i.exec(compound)
    const classMatches = Array.from(compound.matchAll(/\.([-_\w]+)/g)).map((m) => m[1]!)
    const queries: string[] = []
    for (const cls of classMatches.slice(0, 3)) {
      if (tagMatch) queries.push(`${tagMatch[0]}.${CSS.escape(cls)}`)
      queries.push(`.${CSS.escape(cls)}`)
    }
    if (queries.length === 0 && tagMatch) queries.push(tagMatch[0])
    for (const query of queries) {
      if (candidates.length >= MAX_CANDIDATES) break
      try {
        for (const el of Array.from(document.querySelectorAll(query)).slice(0, 3)) {
          pushCandidate(el)
        }
      } catch {
        /* invalid query — skip */
      }
    }
  }

  const interactive: InspectedElement[] = []
  try {
    const actionable = document.querySelectorAll(
      'a[href], button, input, select, textarea, [role="button"]',
    )
    for (const el of Array.from(actionable).slice(0, MAX_INTERACTIVE)) {
      interactive.push(infoOf(el))
    }
  } catch {
    /* ignore */
  }

  return { target, candidates, interactive }
}

/**
 * Inspects the page the run is driving around `selector`. Prefers the
 * automation tab; resolves `null` when nothing is injectable or the
 * inspection fails. The result is passed to the model verbatim.
 */
export async function inspectPage(
  selector: string,
  scope?: ScopeWindow,
): Promise<PageInspection | null> {
  if (!selector) return null
  const tab = await resolveAutomationTab(undefined, scope).catch(() => undefined)
  const tabId = typeof tab?.id === 'number' ? tab.id : undefined
  if (typeof tabId !== 'number') return null
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: inspectPageInPage,
      args: [selector.slice(0, 300)],
    })
    return (injection?.result as PageInspection | undefined) ?? null
  } catch {
    return null
  }
}
