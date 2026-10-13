/**
 * Panel-window automation scope.
 *
 * The side panel's window is the ONLY window a panel-driven turn may read or
 * act on; every other browser window belongs to the user. A {@link ScopeWindow}
 * is a window id validated to still exist and to be a `normal` window — the
 * standalone workflow editor is a `popup`-type window, so senders from it
 * (editor runs, element picking) degrade to the legacy global resolution
 * (undefined scope) instead of scoping to a window that has no injectable
 * tabs.
 *
 * The module also tracks which windows currently host a connected panel
 * (port-keyed), so automatic visit-web triggers can stay quiet while the user
 * browses in a window that has no panel. Registry state lives in module scope
 * and is disposable: after a worker eviction the set is empty and triggers
 * fall back to global listening until the panel reconnects. Accepted
 * degradation — documented in specs/2026-09-03-panel-window-scope-design.md.
 *
 * A window whose panel is MINIMIZED (see `panel-minimize.ts`) counts as a
 * plugin window too: the panel UI is collapsed into a floating page button,
 * but the user still considers the plugin open there, so unattended runs
 * (local-agent bridge, scheduled tasks, Feishu) remain confined to it. The
 * {@link isPluginWindow} family below is the union of both states; the
 * panel-only predicates stay for code that must distinguish them.
 *
 * Finally, this module owns the windows the extension creates for itself: when
 * unattended runs overlap, the later ones execute in a window of their own
 * ({@link createRunWindow}) and close it on settle ({@link closeRunWindow}).
 * Those windows are never plugin windows, so no run can be resolved into one
 * belonging to another run.
 *
 * @module background/automation-scope
 */

import { isMinimized, listMinimizedWindowIds } from './panel-minimize'
import type { AgentServerMessage } from '../lib/messages'

/** 面板窗口作用域；undefined = 无作用域 = 现有全局行为。 */
export interface ScopeWindow {
  windowId: number
}

/**
 * Validate a candidate window id as an automation scope: the window must
 * still exist and be a `normal` browser window. Anything else (popup editor,
 * DevTools, closed window, missing `chrome`) yields `undefined`, meaning
 * "no scope" — callers keep their legacy global behaviour.
 */
export async function normalScopeFromWindowId(windowId?: number): Promise<ScopeWindow | undefined> {
  if (typeof windowId !== 'number') return undefined
  if (typeof chrome === 'undefined' || !chrome.windows?.get) return undefined
  try {
    const win = await chrome.windows.get(windowId)
    return win.type === 'normal' ? { windowId } : undefined
  } catch {
    return undefined
  }
}

// --- Panel window registry (for automatic-trigger guards) ---------------------

/** Connected panel ports keyed by their host window id. */
const portsByWindow = new Map<number, Set<chrome.runtime.Port>>()
/** Reverse index so a disconnect only drops its own port. */
const windowByPort = new Map<chrome.runtime.Port, number>()

/** Register a panel port as living in `windowId`. Ignored for bad ids. */
export function registerPanelWindow(windowId: number, port: chrome.runtime.Port): void {
  if (typeof windowId !== 'number') return
  // Re-homing (a port re-registering to another window) must retire the old
  // window's entry when it becomes empty, or stale keys would linger here and
  // in latestPanelWindowId.
  const previous = windowByPort.get(port)
  if (typeof previous === 'number' && previous !== windowId) {
    const old = portsByWindow.get(previous)
    if (old) {
      old.delete(port)
      if (old.size === 0) portsByWindow.delete(previous)
    }
  }
  windowByPort.set(port, windowId)
  const existing = portsByWindow.get(windowId)
  if (existing) {
    existing.add(port)
    // Re-insert so Map iteration order (insertion order) keeps the most
    // recently connected panel window last — what latestPanelWindowId returns.
    portsByWindow.delete(windowId)
    portsByWindow.set(windowId, existing)
  } else {
    portsByWindow.set(windowId, new Set([port]))
  }
}

/** Drop one port; the window stays registered while other ports remain. */
export function unregisterPort(port: chrome.runtime.Port): void {
  const windowId = windowByPort.get(port)
  if (typeof windowId !== 'number') return
  windowByPort.delete(port)
  const set = portsByWindow.get(windowId)
  if (!set) return
  set.delete(port)
  if (set.size === 0) portsByWindow.delete(windowId)
}

/**
 * Post a server message to EVERY connected panel port, best effort.
 *
 * Used for out-of-band progress pushes (e.g. live AI review logs) that are
 * not a reply to any particular command — the reviewing panel subscribes and
 * renders them while the review is still streaming.
 */
export function broadcastPanels(message: AgentServerMessage): void {
  for (const ports of portsByWindow.values()) {
    for (const port of ports) {
      try {
        port.postMessage(message)
      } catch {
        // The panel closed mid-stream; nothing to do.
      }
    }
  }
}

/** At least one side panel is currently connected. */
export function hasPanelWindows(): boolean {
  return portsByWindow.size > 0
}

/** Whether `windowId` hosts a connected side panel. */
export function isPanelWindow(windowId: number | undefined): boolean {
  return typeof windowId === 'number' && portsByWindow.has(windowId)
}

/**
 * The most recently connected panel window, when any exists. Used by runs
 * that have no natural sender (scheduled tasks, Feishu commands, the
 * local-agent bridge): they must stay inside the plugin window while one is
 * open. With several panels open, the most recently connected one wins.
 */
export function latestPanelWindowId(): number | undefined {
  if (portsByWindow.size === 0) return undefined
  const ids = [...portsByWindow.keys()]
  return ids[ids.length - 1]
}

// --- Plugin windows (connected panels ∪ minimized panels) ---------------------

/** At least one window runs the plugin (panel connected or minimized). */
export function hasPluginWindows(): boolean {
  return portsByWindow.size > 0 || listMinimizedWindowIds().length > 0
}

/**
 * Whether the plugin is "open" in this window: a connected side panel OR a
 * minimized panel (floating page button). Unattended runs may only act on
 * plugin windows; everything else belongs to the user.
 */
export function isPluginWindow(windowId: number | undefined): boolean {
  return isPanelWindow(windowId) || isMinimized(windowId)
}

/**
 * The most recently used plugin window: the latest connected panel window
 * while any panel is open (an interactive panel is the user's active
 * surface), otherwise the most recently minimized one.
 */
export function latestPluginWindowId(): number | undefined {
  return latestPanelWindowId() ?? listMinimizedWindowIds().at(-1)
}

/**
 * Automation scope for sender-less runs: the plugin window while one exists
 * (validated), undefined — legacy global resolution — when none does.
 */
export async function currentPluginScope(): Promise<ScopeWindow | undefined> {
  return normalScopeFromWindowId(latestPluginWindowId())
}

/**
 * Every ordinary browser window with a title for its active tab, flagged by
 * plugin state. Backs the multi-window picker (`window-policy`): unattended
 * runs may only target plugin windows, so the caller filters on the flags.
 * Empty when `chrome.windows` is unavailable (unit tests).
 */
export async function listNormalWindows(): Promise<
  { windowId: number; title: string; host?: string; isPanel: boolean; isMinimized: boolean }[]
> {
  if (typeof chrome === 'undefined' || !chrome.windows?.getAll) return []
  const windows = await chrome.windows
    .getAll({ windowTypes: ['normal'], populate: true })
    .catch(() => [])
  const out: {
    windowId: number
    title: string
    host?: string
    isPanel: boolean
    isMinimized: boolean
  }[] = []
  for (const win of windows as chrome.windows.Window[]) {
    if (typeof win.id !== 'number') continue
    const active = win.tabs?.find((tab) => tab.active) ?? win.tabs?.[0]
    let host: string | undefined
    if (active?.url) {
      try {
        host = new URL(active.url).host || undefined
      } catch {
        /* non-URL (chrome:// etc.) — leave the host off */
      }
    }
    out.push({
      windowId: win.id,
      title: active?.title ?? '',
      host,
      isPanel: isPanelWindow(win.id),
      isMinimized: isMinimized(win.id),
    })
  }
  return out
}

// --- Run-owned windows (parallel unattended execution) -----------------------

/**
 * A browser window the extension created for exactly one in-flight run.
 *
 * When several unattended runs overlap they cannot share one window: they would
 * drive the same active tab step by step on top of each other. The second (and
 * third…) run therefore gets a window of its own, which it closes when it
 * settles. Those windows are deliberately NOT plugin windows — no panel is
 * attached and none can be opened without a user gesture — so every
 * plugin-window predicate above stays false for them, and no later run can
 * resolve into a window that belongs to another run.
 *
 * The registry lives in module scope like the panel sets, mirrored into
 * `chrome.storage.session`: that mirror survives a service-worker eviction (the
 * run dies, the window does not) and clears when the browser exits (so a stale
 * entry can never point at a window of the next session).
 */
export interface RunWindowRecord {
  runId: string
  /** Set once the window is gone — closed by the run or by the user. */
  closed: boolean
}

const RUN_WINDOWS_KEY = 'bc:runOwnedWindows'

/**
 * Cascade geometry: each extra run window is offset so its title bar stays
 * clickable and no window is fully covered. Full occlusion is what makes Chrome
 * treat a window as hidden, and a hidden window is what this feature must avoid.
 */
const RUN_WINDOW_TILE = { left: 80, top: 60, width: 1280, height: 860, stepX: 56, stepY: 44 }

const runOwnedWindows = new Map<number, RunWindowRecord>()

/**
 * Hook that drops per-window automation state (tab cache, `pin_tab` slot) when
 * a run window closes. Injected from the background script because the driver
 * owns that state and this module must not import it.
 */
let pruneRunWindowState: ((windowId: number) => void) | null = null

/** Registers (or clears, with null) the run-window state pruner. */
export function setRunWindowPruner(fn: ((windowId: number) => void) | null): void {
  pruneRunWindowState = fn
}

/** Whether `windowId` is (or was, this run) a window the extension created. */
export function isRunOwnedWindow(windowId: number | undefined): boolean {
  return typeof windowId === 'number' && runOwnedWindows.has(windowId)
}

/** Current ownership records, for the lease layer and for tests. */
export function listRunOwnedWindows(): { windowId: number; runId: string; closed: boolean }[] {
  return [...runOwnedWindows].map(([windowId, record]) => ({ windowId, ...record }))
}

async function mirrorRunWindows(): Promise<void> {
  const session = typeof chrome !== 'undefined' ? chrome.storage?.session : undefined
  if (!session) return
  await session
    .set({ [RUN_WINDOWS_KEY]: listRunOwnedWindows() })
    .catch(() => undefined /* the mirror is a reclaim aid, not a guarantee */)
}

/**
 * Create the dedicated window for one run. `tier` is the cascade slot (0-based)
 * so parallel windows fan out instead of stacking. Opens on the new-tab page: a
 * run whose first step is a wait or a variable must not pay for a page load the
 * workflow may never use. Returns undefined when the window could not be
 * created, which the caller treats as "no dedicated window".
 */
export async function createRunWindow(runId: string, tier: number): Promise<number | undefined> {
  if (typeof chrome === 'undefined' || !chrome.windows?.create) return undefined
  const bounds = {
    left: RUN_WINDOW_TILE.left + tier * RUN_WINDOW_TILE.stepX,
    top: RUN_WINDOW_TILE.top + tier * RUN_WINDOW_TILE.stepY,
    width: RUN_WINDOW_TILE.width,
    height: RUN_WINDOW_TILE.height,
  }
  try {
    // Unfocused on purpose: stealing the user's focus for a background task is
    // worse than the throttling risk, which cascade placement keeps at bay.
    const win = await chrome.windows.create({ ...bounds, focused: false })
    const windowId = typeof win?.id === 'number' ? win.id : undefined
    if (windowId === undefined) return undefined
    runOwnedWindows.set(windowId, { runId, closed: false })
    await mirrorRunWindows()
    return windowId
  } catch (error) {
    console.warn('[automation-scope] run window create failed:', error)
    return undefined
  }
}

/**
 * Close a run's window and forget it. Idempotent: the run's `finally` calls this
 * whether or not the user already closed the window themselves. A window id this
 * module has no record for is refused outright — this function must never be able
 * to close one of the user's windows.
 */
export async function closeRunWindow(windowId: number): Promise<void> {
  if (!runOwnedWindows.delete(windowId)) return
  if (pruneRunWindowState) {
    try {
      pruneRunWindowState(windowId)
    } catch {
      /* pruning is best-effort */
    }
  }
  if (typeof chrome !== 'undefined' && chrome.windows?.remove) {
    await chrome.windows.remove(windowId).catch(() => undefined)
  }
  await mirrorRunWindows()
}

/**
 * Close windows left behind by runs that are no longer alive — a worker
 * eviction kills the run but not its window. `isLive` answers for the running
 * board; every entry it rejects with a still-existing window is an orphan.
 * Re-adopts the records it keeps so ownership survives the eviction too.
 */
export async function reclaimOrphanRunWindows(
  isLive: (runId: string) => boolean,
): Promise<number[]> {
  if (typeof chrome === 'undefined' || !chrome.windows?.get) return []
  const stored = (await chrome.storage?.session
    ?.get(RUN_WINDOWS_KEY)
    .then((all) => all?.[RUN_WINDOWS_KEY])
    .catch(() => undefined)) as { windowId: number; runId: string; closed: boolean }[] | undefined
  const kept: { windowId: number; runId: string; closed: boolean }[] = []
  const closed: number[] = []
  for (const entry of stored ?? []) {
    if (typeof entry?.windowId !== 'number') continue
    const exists = await chrome.windows
      .get(entry.windowId)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue
    if (isLive(entry.runId)) {
      runOwnedWindows.set(entry.windowId, { runId: entry.runId, closed: false })
      kept.push({ windowId: entry.windowId, runId: entry.runId, closed: false })
      continue
    }
    await chrome.windows.remove(entry.windowId).catch(() => undefined)
    closed.push(entry.windowId)
  }
  if (closed.length && chrome.storage?.session) {
    await chrome.storage.session.set({ [RUN_WINDOWS_KEY]: kept }).catch(() => undefined)
  }
  return closed
}

/** A closed window cannot host a panel. Safe to call multiple times (guarded). */
export function initScopeWindowCleanup(): void {
  if (typeof chrome === 'undefined' || !chrome.windows?.onRemoved) return
  chrome.windows.onRemoved.addListener((closedWindowId) => {
    portsByWindow.delete(closedWindowId)
    for (const [port, windowId] of windowByPort) {
      if (windowId === closedWindowId) windowByPort.delete(port)
    }
    // Keep the ownership record: a run whose window the user closed mid-turn
    // must still be recognised as owning it, or the driver would fall back to
    // the global tab chain and act inside the user's window.
    const owned = runOwnedWindows.get(closedWindowId)
    if (owned) {
      owned.closed = true
      void mirrorRunWindows()
    }
  })
}

/**
 * Pure visit-web trigger guard. With no panel window anywhere the trigger
 * listens globally (the long-standing behaviour, and the only way scheduled
 * setups keep working); once any panel exists, navigations in windows the
 * user did NOT attach the panel to must never trigger — that window is the
 * user's own.
 */
export function shouldTriggerVisitWeb(hasPanels: boolean, isPanel: boolean): boolean {
  return !hasPanels || isPanel
}
