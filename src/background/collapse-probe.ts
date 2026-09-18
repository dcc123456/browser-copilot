/**
 * The page-side half of loop folding.
 *
 * Folding a run of "same action, different element" steps into `loop-elements`
 * needs ONE selector whose matches are exactly the elements the run acted on,
 * in the same order — `loop-elements` iterates `querySelectorAll(selector)` and
 * hands iteration N the N-th match. That selector cannot be derived from the
 * recorded selectors alone (`#input-1` / `#input-2` share no textual form), so
 * it is derived as a CANDIDATE and then verified against the live page. A
 * candidate that does not match those elements and nothing else is discarded;
 * when none survives, the fold is refused.
 *
 * @module background/collapse-probe
 */

import { resolveAutomationTab } from './driver'
import type { ScopeWindow } from './automation-scope'
import type { CollapseProbe } from '../lib/workflow/loop-collapse'

/**
 * Self-contained candidate derivation, injected into the page.
 *
 * Everything it needs is declared inside: `chrome.scripting.executeScript`
 * serializes this function's SOURCE, so a module-scope helper would be a
 * `ReferenceError` in the page.
 *
 * Returns a selector matching exactly `selectors`' elements, in order, or null.
 * Every candidate goes through the same verification, so a wrong guess is
 * dropped rather than trusted.
 *
 * Exported only so it can be exercised against a real DOM in
 * `tests/collapse-probe.spec.ts`; the sole production caller is the injection
 * inside {@link createCollapseProbe}.
 */
export function deriveLoopSelectorInPage(selectors: string[]): string | null {
  /** Drop positional pseudo-classes so sibling paths become comparable. */
  const stripPositional = (selector: string): string =>
    selector
      .replace(/:(?:nth|first|last)-[a-z-]+\([^)]*\)/g, '')
      .replace(/:(?:first|last)-child/g, '')
      .trim()

  /**
   * A CSS path for `element`, preferring a stable id and otherwise pinning the
   * absolute child index at each level. Best-effort: the result is only ever a
   * candidate, and every candidate is verified before it is accepted.
   */
  const pathOf = (element: Element): string => {
    const parts: string[] = []
    let node: Element | null = element
    let depth = 0
    while (node && node.nodeType === 1 && depth < 20) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag)
        break
      }
      if (node.id) {
        parts.unshift(`#${node.id}`)
        break
      }
      let position = 1
      let sibling = node.previousElementSibling
      while (sibling) {
        position += 1
        sibling = sibling.previousElementSibling
      }
      parts.unshift(`${tag}:nth-child(${position})`)
      node = node.parentElement
      depth += 1
    }
    return parts.join(' > ')
  }

  if (!Array.isArray(selectors) || selectors.length < 2) return null
  const doc = document

  const elements: Element[] = []
  for (const selector of selectors) {
    let found: Element | null = null
    try {
      found = doc.querySelector(String(selector))
    } catch {
      return null
    }
    if (!found) return null
    // The same element twice is not a per-element run.
    if (elements.indexOf(found) !== -1) return null
    elements.push(found)
  }

  /** Does `candidate` match exactly the recorded elements, in the same order? */
  const matches = (candidate: string): boolean => {
    if (!candidate) return false
    let found: Element[]
    try {
      found = Array.prototype.slice.call(doc.querySelectorAll(candidate)) as Element[]
    } catch {
      return false
    }
    if (found.length !== elements.length) return false
    for (let i = 0; i < found.length; i += 1) {
      if (found[i] !== elements[i]) return false
    }
    return true
  }

  // Candidate 1: the recorded selectors with their positional parts removed —
  // turns `.list > li:nth-child(1)` / `(2)` into the shared `.list > li`.
  const stripped = selectors.map((selector) => stripPositional(String(selector)))
  if (stripped.every((value) => value !== '' && value === stripped[0]) && matches(stripped[0]!)) {
    return stripped[0]!
  }

  // Candidate 2/3: the elements' tag, optionally narrowed by a class they all
  // carry, scoped to their deepest common ancestor so an unrelated look-alike
  // elsewhere on the page cannot be swept in.
  const tag = elements[0]!.tagName.toLowerCase()
  if (!elements.every((element) => element.tagName.toLowerCase() === tag)) return null

  let ancestor: Element | null = elements[0]!.parentElement
  while (ancestor && !elements.every((element) => ancestor!.contains(element))) {
    ancestor = ancestor.parentElement
  }
  const root =
    ancestor && ancestor !== doc.body && ancestor !== doc.documentElement ? pathOf(ancestor) : ''

  const shared: string[] = []
  const first = elements[0]!
  for (let i = 0; i < first.classList.length; i += 1) {
    const name = first.classList.item(i)
    if (!name) continue
    if (elements.every((element) => element.classList.contains(name))) shared.push(name)
  }

  /** The `tag:nth-child(k)` chain from `from` (exclusive) down to `element`. */
  const relativePath = (element: Element, from: Element): string | null => {
    const steps: string[] = []
    let node: Element | null = element
    while (node && node !== from && steps.length < 20) {
      const stepTag = node.tagName.toLowerCase()
      let position = 1
      let sibling = node.previousElementSibling
      while (sibling) {
        position += 1
        sibling = sibling.previousElementSibling
      }
      steps.unshift(`${stepTag}:nth-child(${position})`)
      node = node.parentElement
    }
    return node === from ? steps.join(' > ') : null
  }

  const candidates: string[] = [
    ...shared.map((name) => [root, `${tag}.${name}`].filter(Boolean).join(' > ')),
    [root, tag].filter(Boolean).join(' > '),
  ]

  // Candidate 4: each element's own path below the common ancestor, with the
  // positions stripped. Candidates 2/3 only reach DIRECT children of that
  // ancestor, so a run nested one or more levels down (`.rows > div > input`,
  // every row's input id different) is only reachable this way.
  if (ancestor) {
    const common: Element = ancestor
    const paths = elements.map((element) => relativePath(element, common))
    if (paths.every((path) => path !== null)) {
      const strippedPaths = paths.map((path) => stripPositional(path!))
      if (strippedPaths.every((path) => path !== '' && path === strippedPaths[0])) {
        candidates.push([root, strippedPaths[0]!].filter(Boolean).join(' > '))
      }
    }
  }

  for (const candidate of new Set(candidates)) {
    if (matches(candidate)) return candidate
  }
  return null
}

/**
 * The production {@link CollapseProbe}: asks the automation tab's page.
 *
 * Resolves null on every failure (no injectable tab, restricted page, probe
 * crash) — the caller then refuses the fold rather than guessing.
 */
export function createCollapseProbe(scope?: ScopeWindow): CollapseProbe {
  return {
    async deriveLoopSelector(selectors, signal) {
      if (signal.aborted || selectors.length < 2) return null
      const tab = await resolveAutomationTab(undefined, scope).catch(() => undefined)
      const tabId = typeof tab?.id === 'number' ? tab.id : undefined
      if (typeof tabId !== 'number') return null
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          func: deriveLoopSelectorInPage,
          args: [selectors.map((selector) => String(selector).slice(0, 300))],
        })
        const result = injection?.result
        return typeof result === 'string' && result ? result : null
      } catch {
        return null
      }
    },
  }
}
