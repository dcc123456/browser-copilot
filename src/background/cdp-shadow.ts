/**
 * Closed shadow-DOM support via the Chrome DevTools Protocol.
 *
 * Web components whose shadow root is created with `mode: 'closed'` (Xiaohongshu's
 * `<xhs-publish-btn>` is one) expose NOTHING to JavaScript: their inner
 * elements have no accessible shadow root, document queries never reach them,
 * and synthetic events dispatched on the host do not cross into the shadow
 * tree. The page's own scripts cannot see them either.
 *
 * The debugger protocol is the one sanctioned channel that can:
 *   - `DOM.getDocument({ pierce: true })` expands CLOSED shadow roots (CDP's
 *     `node.shadowRoots` is populated regardless of the root's mode);
 *   - `Input.dispatchMouseEvent` synthesizes TRUSTED input, so the browser's
 *     own hit-testing lands on the shadowed button and fires the page's real
 *     listeners.
 *
 * The manifest already declares the `debugger` permission (the CSP fallback in
 * driver.ts uses it). Attaching shows Chrome's "extension is debugging this
 * tab" infobar; we attach on demand and detach immediately after.
 *
 * Tree parsing is split into pure functions (`buildShadowCandidates`,
 * `matchCandidates`) so it is unit-testable without chrome.debugger; only the
 * live node resolution / event dispatch touches the protocol.
 *
 * @module background/cdp-shadow
 */

import type { SnapshotElement, Target, TargetSpec } from '../lib/ops'

// --- CDP node shapes (only the fields we use) -------------------------------

interface CdpNode {
  nodeId?: number
  backendNodeId?: number
  nodeType?: number
  nodeName?: string
  nodeValue?: string
  attributes?: string[] // flat [name0, value0, name1, value1, ...]
  children?: CdpNode[]
  shadowRoots?: CdpNode[]
  childNodeCount?: number
}

interface CdpBoxModel {
  /** Flat number quad [x1,y1,x2,y2,x3,y3,x4,y4] (real CDP shape). */
  content?: unknown
}

// --- Pure tree parsing -------------------------------------------------------

/**
 * An interactive element discovered inside a shadow root (open or closed) in
 * the CDP-pierced tree.
 */
export interface ShadowCandidate {
  tag: string
  role: string
  name: string
  disabled: boolean
  /** Chain of shadow hosts outermost-first (light-DOM tags, for narrowing). */
  hostTags: string[]
  /** Index of the element within the flattened candidate list, for `nth`. */
  depth: number
  text: string
  node: CdpNode
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary'])

function attrMap(node: CdpNode): Record<string, string> {
  const out: Record<string, string> = {}
  const attrs = node.attributes ?? []
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    const name = attrs[i]
    const value = attrs[i + 1]
    if (name) out[name] = value ?? ''
  }
  return out
}

function collapse(text: string): string {
  return (text ?? '').replace(/[\s ]+/g, ' ').trim()
}

/** Implicit ARIA role from a tag, mirroring the kernel's `roleOf`. */
export function roleForTag(tag: string, attrs: Record<string, string>): string {
  const explicit = attrs.role
  if (explicit) return explicit.trim().split(/\s+/)[0] ?? ''
  if (tag === 'a') return attrs.href ? 'link' : 'generic'
  if (tag === 'button') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'summary') return 'button'
  if (tag === 'input') {
    const type = (attrs.type ?? 'text').toLowerCase()
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
    if (type === 'hidden') return 'none'
    return 'textbox'
  }
  return 'generic'
}

function isInteractive(tag: string, attrs: Record<string, string>): boolean {
  if (INTERACTIVE_TAGS.has(tag)) return roleForTag(tag, attrs) !== 'none'
  if (attrs.role) {
    const r = attrs.role.toLowerCase()
    if (!['presentation', 'none'].includes(r)) return true
  }
  if (attrs.tabindex !== undefined && attrs.tabindex !== '-1') return true
  if (attrs.contenteditable === 'true' || attrs.contenteditable === '') return true
  if (attrs.onclick) return true
  return false
}

/** Visible text of a CDP node by aggregating its subtree's text children. */
function nodeText(node: CdpNode): string {
  let out = ''
  const walk = (n: CdpNode): void => {
    if (n.nodeType === 3) {
      out += n.nodeValue ?? ''
      return
    }
    if (n.nodeName && ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(n.nodeName)) return
    n.children?.forEach(walk)
  }
  walk(node)
  return collapse(out)
}

/**
 * Walk the pierced DOM tree and collect interactive elements located inside a
 * shadow root. `inShadow` flips true once we descend into any `shadowRoots`
 * entry; elements within are candidates. Pure (tree in, candidates out).
 */
export function buildShadowCandidates(root: CdpNode): ShadowCandidate[] {
  const out: ShadowCandidate[] = []

  const walk = (node: CdpNode, inShadow: boolean, hostTags: string[]): void => {
    if (node.nodeType === 1) {
      const tag = (node.nodeName ?? '').toLowerCase()
      const attrs = attrMap(node)
      if (inShadow && isInteractive(tag, attrs)) {
        const role = roleForTag(tag, attrs)
        out.push({
          tag,
          role,
          name: accessibleName(node, tag, attrs),
          disabled: attrs.disabled !== undefined || attrs['aria-disabled'] === 'true',
          hostTags: hostTags.slice(),
          depth: out.length,
          text: nodeText(node),
          node,
        })
      }
      // Descend into light-DOM children first.
      node.children?.forEach((child) => {
        walk(child, inShadow, hostTags)
      })
      // Shadow roots of this host: their subtree is shadowed.
      node.shadowRoots?.forEach((sr) => {
        const nextHosts = inShadow ? hostTags.concat(tag) : [tag]
        sr.children?.forEach((child) => walk(child, true, nextHosts))
      })
    } else {
      // Shadow-root node (nodeType 11) reached directly, or document fragment.
      node.children?.forEach((child) => walk(child, inShadow, hostTags))
    }
  }

  walk(root, false, [])
  return out
}

/** Best-effort accessible name for a CDP node (aria-label / title / value / text). */
function accessibleName(node: CdpNode, tag: string, attrs: Record<string, string>): string {
  const aria = collapse(attrs['aria-label'] ?? '')
  if (aria) return aria
  const title = collapse(attrs.title ?? '')
  if (title) return title
  if (tag === 'input') {
    const type = (attrs.type ?? 'text').toLowerCase()
    if (['button', 'submit', 'reset'].includes(type)) {
      return collapse(attrs.value ?? '')
    }
    return collapse(attrs.placeholder ?? attrs.name ?? '')
  }
  const text = nodeText(node)
  return text.length <= 120 ? text : text.slice(0, 120)
}

// --- Candidate matching ------------------------------------------------------

/** True when a candidate satisfies a single target spec. */
export function candidateMatches(c: ShadowCandidate, spec: TargetSpec): boolean {
  const wantedName = spec.value
  // For a role spec, `spec.role` carries the ARIA role and `value` the
  // accessible name. Snapshots we produced always have role; tolerate a
  // name-only fallback too.
  if (spec.how === 'role' || spec.how === 'cdp-shadow') {
    if (spec.role) {
      if (c.role.toLowerCase() !== spec.role.toLowerCase()) return false
    } else if (wantedName) {
      // No role to compare (name-only spec); match on name below.
    }
    return !wantedName || c.name === wantedName || c.text === wantedName
  }
  if (spec.how === 'text' || spec.how === 'id' || spec.how === 'testid') {
    return c.name === wantedName || c.text === wantedName
  }
  if (spec.how === 'css') {
    // CSS specs normally resolve open roots in-page; for the closed path
    // accept by name/tag embedded in the value.
    if (!wantedName) return true
    return c.name === wantedName || c.text === wantedName || c.tag === wantedName.toLowerCase()
  }
  return false
}

/** Pick the best candidate for a target (primary + fallbacks), honoring nth. */
export function matchCandidates(
  candidates: ShadowCandidate[],
  target: Target,
): ShadowCandidate | null {
  const specs = [target.primary, ...(target.fallbacks ?? [])]
  for (const spec of specs) {
    if (!spec) continue
    const matches = candidates.filter((c) => candidateMatches(c, spec))
    if (matches.length === 0) continue
    if (typeof spec.nth === 'number' && typeof matches[spec.nth] !== 'undefined') {
      return matches[spec.nth] ?? null
    }
    return matches.find((c) => !c.disabled) ?? matches[0] ?? null
  }
  return null
}

/** Find candidates whose role/name resemble a free-text query (for snapshot). */
export function findCandidatesByName(
  candidates: ShadowCandidate[],
  name: string,
): ShadowCandidate[] {
  const wanted = name.trim()
  if (!wanted) return []
  return candidates.filter((c) => c.name === wanted || c.text === wanted || c.name.includes(wanted))
}

// --- Live CDP operations -----------------------------------------------------

export interface CdpSession {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

/**
 * Center of a CDP box model's content quad (viewport coordinates).
 *
 * The REAL CDP `DOM.getBoxModel` returns `model.content` as a FLAT number quad
 * `[x1, y1, x2, y2, x3, y3, x4, y4]` — not an array of points. Tolerate an
 * object-point array too (defensive; older tooling exposed that shape), and
 * reject NaN/non-finite results so a bad box never reaches
 * `Input.dispatchMouseEvent` as a null/NaN coordinate (the CDP binder fails
 * with "mandatory field missing" for a null x/y).
 */
export function boxCenter(
  box: { model?: CdpBoxModel; content?: unknown } | undefined,
): { x: number; y: number } | null {
  const raw = box?.model?.content ?? box?.content
  if (!Array.isArray(raw) || raw.length === 0) return null
  const points: Array<{ x: number; y: number }> = []
  if (typeof raw[0] === 'number') {
    // Flat quad: 4 points × 2 coordinates.
    if (raw.length < 8) return null
    for (let i = 0; i + 1 < raw.length; i += 2) {
      points.push({ x: raw[i] as number, y: raw[i + 1] as number })
    }
  } else {
    if (raw.length < 4) return null
    for (const p of raw) {
      const pt = p as { x?: unknown; y?: unknown } | null
      if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') return null
      points.push({ x: pt.x, y: pt.y })
    }
  }
  if (points.length < 4) return null
  let x = 0
  let y = 0
  for (const p of points) {
    x += p.x
    y += p.y
  }
  const cx = x / points.length
  const cy = y / points.length
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  return { x: cx, y: cy }
}

/** Convert a shadow candidate into a snapshot element entry. */
export function candidateToSnapshot(c: ShadowCandidate, ref: string): SnapshotElement {
  const primary: TargetSpec = {
    how: 'cdp-shadow',
    value: c.name || c.tag,
    role: c.role,
    tag: c.tag,
    closedShadow: true,
    // Host tags are descriptive (the closed root is re-discovered from the
    // pierced tree at click time, not reached via these selectors).
    shadowHosts: c.hostTags.slice(),
  }
  const target: Target = { primary, fallbacks: [], label: c.name || c.tag }
  const entry: SnapshotElement = {
    ref,
    role: c.role,
    name: c.name,
    tag: c.tag,
    inViewport: true,
    target,
  }
  if (c.disabled) entry.disabled = true
  return entry
}

/**
 * Read all interactive elements inside shadow roots (incl. closed) via CDP.
 * Returns snapshot entries with refs continuing from `startRef`.
 */
export async function snapshotClosedShadow(
  session: CdpSession,
  startRef: number,
): Promise<SnapshotElement[]> {
  const doc = (await session.send('DOM.getDocument', {
    depth: -1,
    pierce: true,
  })) as { root?: CdpNode }
  const candidates = buildShadowCandidates(doc.root ?? ({} as CdpNode))
  if (candidates.length === 0) return []

  const entries: SnapshotElement[] = []
  let ref = startRef
  // Resolve box models to filter out non-rendered elements; one CDP call per
  // candidate is acceptable because shadowed interactive elements are few.
  for (const c of candidates) {
    const nodeId = c.node.nodeId
    if (typeof nodeId !== 'number') continue
    let box: { model?: CdpBoxModel; content?: unknown } | undefined
    try {
      box = (await session.send('DOM.getBoxModel', { nodeId })) as typeof box
    } catch {
      box = undefined
    }
    const center = boxCenter(box)
    if (!center) continue // not rendered / display:none
    const entry = candidateToSnapshot(c, `e${ref}`)
    entries.push(entry)
    ref += 1
  }
  return entries
}

/**
 * Last-resort click for a node whose box model is unavailable: resolve it to
 * a Runtime object and invoke `this.click()` on it. The event is untrusted
 * (isTrusted === false), so pages that gate on real input still need the
 * Input-dispatch path — but plain addEventListener handlers fire.
 */
async function syntheticClickNode(
  session: CdpSession,
  nodeId: number,
): Promise<{ ok: boolean; note?: string; error?: string }> {
  try {
    const resolved = (await session.send('DOM.resolveNode', { nodeId })) as {
      object?: { objectId?: string }
    }
    const objectId = resolved.object?.objectId
    if (!objectId) {
      return { ok: false, error: '元素未渲染（没有可见尺寸），且节点无法解析，无法点击。' }
    }
    await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { this.click(); }',
      returnByValue: true,
    })
    return { ok: true, note: '已通过节点回退方式点击（合成 click，非受信任事件）' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `元素未渲染且回退点击失败：${message}` }
  }
}

/**
 * What {@link probeClosedShadow} observes about a shadowed element. The fields
 * mirror the kernel's `actionability` payload exactly, so a readiness wait cannot
 * tell the two channels apart.
 */
export interface ShadowProbe {
  /** How many shadowed elements the target's whole spec chain matched. */
  matchCount: number
  state: 'ready' | 'blocked' | 'missing'
  visible: boolean
  enabled: boolean
  occluded: boolean
  rect: { x: number; y: number; w: number; h: number } | null
}

/** The minimal DOM surface {@link readRenderedState} touches (it is serialized). */
interface ProbeNode {
  nodeType: number
  isConnected?: boolean
  disabled?: boolean
  parentNode?: ProbeNode | null
  assignedSlot?: ProbeNode | null
  getRootNode?: () => { host?: ProbeNode } | null
  getAttribute?: (name: string) => string | null
  contains?: (other: ProbeNode | null) => boolean
  getBoundingClientRect?: () => {
    x: number
    y: number
    width: number
    height: number
    left: number
    top: number
  }
}

/**
 * Serialized into the page through `Runtime.callFunctionOn`, so it must stay
 * self-contained (no reference outside its own body) and return only
 * JSON-serializable values. `this` is the element CDP resolved — which is the
 * whole point: the debugger holds a node inside a CLOSED shadow root that page
 * scripts can never obtain.
 */
function readShadowActionability(this: ProbeNode): {
  visible: boolean
  enabled: boolean
  occluded: boolean
  rect: { x: number; y: number; w: number; h: number } | null
} {
  const self = this
  const measured = self.getBoundingClientRect?.()
  const rect = measured
    ? { x: measured.x, y: measured.y, w: measured.width, h: measured.height }
    : null
  // Walking up must cross the shadow boundary, or every element inside a root
  // looks disconnected from the document. `parentNode` stops at the root; its
  // `host` is the light-DOM element that renders it.
  const composedParent = (node: ProbeNode): ProbeNode | null => {
    if (node.assignedSlot) return node.assignedSlot
    if (node.parentNode) return node.parentNode
    const root = node.getRootNode ? node.getRootNode() : null
    return root?.host ?? null
  }

  let visible =
    self.isConnected !== false && !!measured && measured.width > 0 && measured.height > 0
  // A function handed to `Runtime.callFunctionOn` runs in strict mode, where
  // reading a property of `null` throws instead of yielding undefined: the
  // parent walk must stop on the condition, not in the call.
  let node: ProbeNode | null | undefined = self
  for (let depth = 0; visible && node && depth < 64; depth += 1) {
    if (node.nodeType === 1) {
      const style = getComputedStyle(node as unknown as Element)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number(style.opacity) === 0
      ) {
        visible = false
      }
    }
    node = node ? composedParent(node) : null
  }

  let enabled = self.disabled !== true && self.getAttribute?.('aria-disabled') !== 'true'

  // `elementFromPoint` retargets through the shadow boundary and reports the
  // light-DOM HOST, so "occluded" is decided by whether the hit lands anywhere
  // on this node's composed path (host included) rather than on the node itself.
  let occluded = false
  if (visible && measured && typeof document.elementFromPoint === 'function') {
    const hit = document.elementFromPoint(
      measured.left + measured.width / 2,
      measured.top + measured.height / 2,
    ) as ProbeNode | null
    if (hit && hit !== self && self.contains?.(hit) !== true) {
      let onOwnPath = false
      let up: ProbeNode | null = self
      for (let depth = 0; up && depth < 64; depth += 1) {
        if (up === hit) {
          onOwnPath = true
          break
        }
        up = composedParent(up)
      }
      occluded = !onOwnPath
    }
  }

  return { visible, enabled, occluded, rect }
}

/**
 * Read the rendered state of a resolved shadow node. Falls back to the box
 * model (the channel {@link clickClosedShadow} itself uses) when the page-side
 * read is unavailable: a box exists only for a laid-out element, so it answers
 * "is it there and drawn" even if nothing else does.
 */
async function readRenderedState(
  session: CdpSession,
  nodeId: number,
  disabledByAttribute: boolean,
): Promise<Omit<ShadowProbe, 'matchCount' | 'state'>> {
  try {
    const resolved = (await session.send('DOM.resolveNode', { nodeId })) as {
      object?: { objectId?: string }
    }
    const objectId = resolved.object?.objectId
    if (!objectId) throw new Error('no object id')
    const call = (await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: readShadowActionability.toString(),
      returnByValue: true,
    })) as {
      result?: { value?: { visible?: unknown; enabled?: unknown; occluded?: unknown; rect?: unknown } }
    }
    const value = call.result?.value
    if (!value || typeof value.visible !== 'boolean') throw new Error('unreadable value')
    const rect = value.rect as { x?: number; y?: number; w?: number; h?: number } | null
    return {
      visible: value.visible,
      enabled: value.enabled !== false && !disabledByAttribute,
      occluded: value.occluded === true,
      rect:
        rect && typeof rect.w === 'number' && typeof rect.h === 'number'
          ? { x: rect.x ?? 0, y: rect.y ?? 0, w: rect.w, h: rect.h }
          : null,
    }
  } catch {
    let box: { model?: CdpBoxModel; content?: unknown } | undefined
    try {
      box = (await session.send('DOM.getBoxModel', { nodeId })) as typeof box
    } catch {
      box = undefined
    }
    const center = boxCenter(box)
    return {
      visible: center !== null,
      enabled: !disabledByAttribute,
      occluded: false,
      rect: null,
    }
  }
}

/**
 * Answer "is this target there, drawn and usable?" for an element inside a
 * CLOSED shadow root — the question the in-page kernel structurally cannot ask,
 * because a closed root exposes no element to page JS.
 *
 * `present` / `visible` / `enabled` readiness waits and the `element_exists`
 * condition otherwise get an empty kernel result for such a target and time out
 * on a button the driver can click all day.
 */
export async function probeClosedShadow(
  session: CdpSession,
  target: Target,
): Promise<ShadowProbe> {
  const doc = (await session.send('DOM.getDocument', {
    depth: -1,
    pierce: true,
  })) as { root?: CdpNode }
  const candidates = buildShadowCandidates(doc.root ?? ({} as CdpNode))
  const specs = [target.primary, ...(target.fallbacks ?? [])].filter((s): s is TargetSpec => !!s)
  const best = matchCandidates(candidates, target)
  // Same first-spec-wins rule the kernel counts with, so a rich target and a
  // flat selector never disagree about how many elements answered.
  let matched: ShadowCandidate[] = []
  for (const spec of specs) {
    const hits = candidates.filter((c) => candidateMatches(c, spec))
    if (hits.length > 0) {
      matched = hits
      break
    }
  }
  const nodeId = best?.node.nodeId
  if (!best || matched.length === 0 || typeof nodeId !== 'number') {
    return {
      matchCount: matched.length,
      state: 'missing',
      visible: false,
      enabled: false,
      occluded: false,
      rect: null,
    }
  }
  const observed = await readRenderedState(session, nodeId, best.disabled)
  return {
    matchCount: matched.length,
    state: observed.visible && observed.enabled && !observed.occluded ? 'ready' : 'blocked',
    ...observed,
  }
}

/**
 * Click (or hover) an element inside a closed shadow root via trusted CDP
 * input events. Resolves the target inside the pierced tree, scrolls it into
 * view, and dispatches real mouse input at its center — input the browser
 * hit-tests through the shadow boundary.
 *
 * @returns a human-readable outcome.
 */
export async function clickClosedShadow(
  session: CdpSession,
  target: Target,
  kind: 'click' | 'hover' = 'click',
): Promise<{ ok: boolean; note?: string; error?: string }> {
  const doc = (await session.send('DOM.getDocument', {
    depth: -1,
    pierce: true,
  })) as { root?: CdpNode }
  const candidates = buildShadowCandidates(doc.root ?? ({} as CdpNode))
  const match = matchCandidates(candidates, target)
  if (!match) {
    return {
      ok: false,
      error: `封闭 Shadow DOM 中未找到匹配元素（${target.primary.how}: ${target.primary.value}）。`,
    }
  }
  const nodeId = match.node.nodeId
  if (typeof nodeId !== 'number') {
    return { ok: false, error: '匹配到的元素缺少 nodeId，无法操作。' }
  }

  try {
    await session.send('DOM.scrollIntoViewIfNeeded', { nodeId })
  } catch {
    /* not scrollable / unsupported; the box coordinates still apply */
  }

  let box: { model?: CdpBoxModel; content?: unknown } | undefined
  try {
    box = (await session.send('DOM.getBoxModel', { nodeId })) as typeof box
  } catch {
    box = undefined
  }
  const center = boxCenter(box)
  if (!center) {
    // Box unavailable (not rendered / zero size): fall back to a synthetic DOM
    // click on the resolved node — CDP holds the node even inside a closed
    // shadow root, so this still reaches the page's own click listeners.
    return syntheticClickNode(session, nodeId)
  }

  const at = { x: Math.round(center.x), y: Math.round(center.y) }
  if (kind === 'hover') {
    // A trusted mouseMoved: the browser fires pointerover/mouseover chain on
    // the shadowed element under the cursor.
    await session.send('Input.dispatchMouseEvent', {
      ...at,
      type: 'mouseMoved',
      button: 'none',
      buttons: 0,
    })
    return { ok: true, note: `已悬停 ${match.tag}「${match.name || match.text}」` }
  }

  // Trusted click sequence: press then release. The browser fires the full
  // pointer/mouse/click chain at the shadowed element under the cursor.
  await session.send('Input.dispatchMouseEvent', {
    ...at,
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  await session.send('Input.dispatchMouseEvent', {
    ...at,
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  return { ok: true, note: `已点击 ${match.tag}「${match.name || match.text}」` }
}
