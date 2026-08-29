/**
 * Page operations: the vocabulary of things the agent can do to a page.
 *
 * These types are shared between the background driver and the in-page kernel.
 * Only *types* may live here: the kernel is serialized via
 * `chrome.scripting.executeScript` and cannot reference any runtime value
 * outside itself.
 *
 * @module lib/ops
 */

/**
 * A durable description of an element.
 *
 * Multiple strategies are kept so a page that drifts between visits still
 * resolves the target: the primary spec is tried first, then each fallback.
 */
export interface Target {
  primary: TargetSpec
  fallbacks: TargetSpec[]
  /** Frame URL when the element lives in an iframe; absent for the top frame. */
  frameHint?: string
  /** Human-readable label, surfaced in logs and confirmations. */
  label?: string
}

/** One way of locating an element. */
export interface TargetSpec {
  /**
   * `cdp-shadow` elements live inside a CLOSED shadow root: in-page JS cannot
   * see them, so the kernel never resolves such a spec — the driver routes the
   * op to the chrome.debugger (CDP) channel instead.
   */
  how: 'testid' | 'id' | 'name' | 'role' | 'text' | 'css' | 'cdp-shadow'
  value: string
  role?: string
  tag?: string
  /** Zero-based index among visible matches, when a spec matches several. */
  nth?: number
  /**
   * Shadow hosts crossed from the document root to the target, outermost
   * first, each as a CSS selector that matches the host in LIGHT DOM (hosts
   * always live in light DOM; only their content is shadowed). Empty/absent
   * for plain light-DOM elements. Used to descend into open shadow roots
   * in-page, and by the CDP channel to narrow the pierced-tree search.
   */
  shadowHosts?: string[]
  /**
   * True when the target is inside a CLOSED shadow root. Such a spec can only
   * be resolved through chrome.debugger (DOM.getDocument pierce / Input
   * events); the kernel treats it as unresolvable.
   */
  closedShadow?: boolean
}

/** Every action the kernel understands. */
export type ActionName =
  | 'click'
  | 'hover'
  | 'fill'
  | 'select_option'
  | 'set_checkbox'
  | 'press_key'
  | 'scroll'
  | 'wait_for'
  | 'snapshot'
  | 'element_exists'
  | 'get_attribute'
  | 'set_attribute'
  | 'click_link'
  | 'read_form'
  | 'create_element'
  | 'handle_dialog'
  | 'count_elements'
  | 'trigger_event'
  | 'capture'
  | 'exec_js'
  | 'exec_workflow_js'

/** What `scroll` should do. */
export type ScrollSpec =
  | { mode: 'into_view' }
  | { mode: 'by'; x?: number; y?: number; smooth?: boolean }
  | { mode: 'incremental'; x?: number; y?: number }
  | { mode: 'top'; smooth?: boolean }
  | { mode: 'bottom'; smooth?: boolean }

/** One operation, handed across the structured-clone boundary. */
export interface Op {
  action: ActionName
  target?: Target
  /** Text to type, option to choose, or key to press. */
  value?: string | string[] | boolean
  /** Attribute name for `get_attribute` / `set_attribute` / `trigger_event`. */
  attribute?: string
  scroll?: ScrollSpec
  /** Whether to clear an input before typing (default true for `fill`). */
  clear?: boolean
  /**
   * Poll (in-page) up to this many milliseconds for the target element to
   * appear before running the action. Mirrors Automa's `waitForSelector`
   * flag: recorded interaction blocks set it so steps that navigate first
   * don't race the element that appears after load.
   */
  waitFor?: number
  /** Character budget for snapshot text. */
  maxChars?: number
  /** Max interactive elements in a snapshot. */
  maxElements?: number
  /**
   * Named arguments handed to an `exec_js` evaluation, available as the
   * function parameters named by `jsArgNames` (e.g. `vars`, `refData`,
   * `rows`). Values must be structured-cloneable (they cross into the page).
   */
  jsArgs?: Record<string, unknown>
  /** Parameter names for `jsArgs`, in order. Defaults to the keys of jsArgs. */
  jsArgNames?: string[]
}

/** A snapshot entry for one interactive element. */
export interface SnapshotElement {
  /** Snapshot-local handle `e1`, `e2`… Valid only within this snapshot. */
  ref: string
  role: string
  name: string
  tag: string
  type?: string
  /** Current value for non-password fields, truncated. */
  value?: string
  placeholder?: string
  href?: string
  disabled?: boolean
  checked?: boolean
  required?: boolean
  inViewport: boolean
  /** Durable target, computed in-page while the element is in hand. */
  target: Target
}

/** One form and its fields. */
export interface FormSummary {
  name: string
  fields: {
    ref: string
    label: string
    tag: string
    type?: string
    required?: boolean
    options?: string[]
  }[]
}

/** Structured reading of a page. */
export interface PageSnapshot {
  url: string
  title: string
  text: string
  truncated: boolean
  selection: string
  elements: SnapshotElement[]
  elementsTruncated: boolean
  frameUrl: string
  isTopFrame: boolean
  forms: FormSummary[]
  /** Pixels the page can still scroll vertically. */
  scrollHeight: number
  scrollY: number
  viewportHeight: number
}

/** Result of one op in one frame. */
export interface OpResult {
  ok: boolean
  found: boolean
  error?: string
  matched?: number
  usedSpec?: string
  usedFallback?: boolean
  frameUrl: string
  isTopFrame: boolean
  page?: PageSnapshot
  mayNavigate?: boolean
  note?: string
  /** Structured payload for data-producing ops (attribute, form, count). */
  data?: unknown
}
