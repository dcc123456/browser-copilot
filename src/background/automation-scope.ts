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
export async function normalScopeFromWindowId(
  windowId?: number,
): Promise<ScopeWindow | undefined> {
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
  const out: { windowId: number; title: string; host?: string; isPanel: boolean; isMinimized: boolean }[] = []
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

/** A closed window cannot host a panel. Safe to call multiple times (guarded). */
export function initScopeWindowCleanup(): void {
  if (typeof chrome === 'undefined' || !chrome.windows?.onRemoved) return
  chrome.windows.onRemoved.addListener((closedWindowId) => {
    portsByWindow.delete(closedWindowId)
    for (const [port, windowId] of windowByPort) {
      if (windowId === closedWindowId) windowByPort.delete(port)
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
