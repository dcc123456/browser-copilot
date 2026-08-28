/**
 * Workflow trigger support (service worker).
 *
 * Automa stores the trigger INSIDE the graph as a `trigger` block whose
 * `data.type` selects how the workflow launches (manual / on-startup /
 * keyboard-shortcut / context-menu / visit-web / scheduled / date /
 * specific-day / element-change). Browser Copilot also keeps a top-level
 * `workflow.trigger` object; this module reads BOTH and reports the effective
 * launch type so a single source of truth drives the listeners.
 *
 * Keyboard shortcuts are content-script free: Automa uses a page listener, but
 * the extension can fire on the global `chrome.commands` API for fixed
 * shortcuts; for user-defined per-workflow shortcuts we listen to tab key
 * events via the offscreen/document approach. Here we expose:
 *   - on-startup workflows (run at browser/extension startup)
 *   - keyboard-shortcut workflows (matched by a `shortcut` string on tabs)
 *
 * @module background/workflow-triggers
 */

import { listWorkflows } from '../lib/workflow/storage'
import type { Workflow, WorkflowNode } from '../lib/workflow/types'

/** The effective trigger type for a workflow. */
export type WorkflowTriggerKind =
  | 'manual'
  | 'on-startup'
  | 'keyboard-shortcut'
  | 'context-menu'
  | 'visit-web'
  | 'scheduled'
  | 'date'
  | 'specific-day'
  | 'element-change'

/** Read the trigger type from the Automa trigger block, falling back to the top-level field. */
export function effectiveTriggerKind(wf: Workflow): WorkflowTriggerKind {
  const triggerNode = wf.drawflow.nodes.find(
    (n: WorkflowNode) => (n.data?.['blockId'] as string) === 'trigger' || n.label === 'trigger',
  )
  const fromBlock = triggerNode?.data?.['type'] as WorkflowTriggerKind | undefined
  const top = wf.trigger?.type
  // Map top-level scheduled -> scheduled.
  if (fromBlock) return fromBlock
  if (top === 'scheduled') return 'scheduled'
  if (top === 'context-menu') return 'context-menu'
  if (top === 'visit-web') return 'visit-web'
  return 'manual'
}

/** Whether the workflow's trigger is enabled. */
export function triggerEnabled(wf: Workflow): boolean {
  if (wf.trigger?.enabled === false) return false
  const triggerNode = wf.drawflow.nodes.find(
    (n: WorkflowNode) => (n.data?.['blockId'] as string) === 'trigger',
  )
  // Automa trigger blocks have no per-node disabled flag for launching.
  void triggerNode
  return true
}

/** All workflows configured to launch at browser/extension startup. */
export async function startupWorkflows(): Promise<Workflow[]> {
  const all = await listWorkflows()
  return all.filter((wf) => triggerEnabled(wf) && effectiveTriggerKind(wf) === 'on-startup')
}

/**
 * All keyboard-shortcut workflows with their shortcut string. Returns the
 * Automa `shortcut` (e.g. "Ctrl+Shift+E") from the trigger block.
 */
export async function shortcutWorkflows(): Promise<{ wf: Workflow; shortcut: string }[]> {
  const all = await listWorkflows()
  const out: { wf: Workflow; shortcut: string }[] = []
  for (const wf of all) {
    if (!triggerEnabled(wf) || effectiveTriggerKind(wf) !== 'keyboard-shortcut') continue
    const node = wf.drawflow.nodes.find((n) => (n.data?.['blockId'] as string) === 'trigger')
    const shortcut = (node?.data?.['shortcut'] as string) ?? ''
    if (shortcut) out.push({ wf, shortcut })
  }
  return out
}

/**
 * Normalize a chord like "Ctrl+Shift+E" to comparable lower-case tokens, used
 * to match a keyboard event from a page tab.
 */
export function normalizeShortcut(chord: string): { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean } {
  const parts = chord.toLowerCase().split('+').map((s) => s.trim())
  const has = (name: string) => parts.includes(name)
  const key = parts.filter((p) => !['ctrl', 'control', 'shift', 'alt', 'meta', 'cmd', 'command'].includes(p)).join('+')
  return {
    key,
    ctrl: has('ctrl') || has('control'),
    shift: has('shift'),
    alt: has('alt'),
    meta: has('meta') || has('cmd') || has('command'),
  }
}

/**
 * Self-contained keyboard listener injected into each tab. Reports a shortcut
 * string ("Ctrl+Shift+E") via `{ type: 'shortcut:pressed', shortcut }` when the
 * pressed chord matches a registered shortcut. No imports/closures (injected).
 */
export function shortcutListenerInPage(chords: string[]): void {
  const w = window as unknown as { __bcShortcut?: { stop: () => void } }
  if (w.__bcShortcut) w.__bcShortcut.stop()
  const normalized = chords.map((c) => normalizeShortcutString(c))
  function normalizeShortcutString(chord: string) {
    const parts = chord.toLowerCase().split('+').map((s) => s.trim())
    const has = (n: string) => parts.includes(n)
    const key = parts
      .filter((p) => !['ctrl', 'control', 'shift', 'alt', 'meta', 'cmd', 'command'].includes(p))
      .join('+')
    return { chord, key, ctrl: has('ctrl') || has('control'), shift: has('shift'), alt: has('alt'), meta: has('meta') || has('cmd') || has('command') }
  }
  function onKey(e: KeyboardEvent) {
    const pressed = {
      key: e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase(),
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey,
    }
    for (const c of normalized) {
      if (
        c.ctrl === pressed.ctrl &&
        c.shift === pressed.shift &&
        c.alt === pressed.alt &&
        c.meta === pressed.meta &&
        c.key === pressed.key
      ) {
        e.preventDefault()
        try {
          void chrome.runtime.sendMessage({ type: 'shortcut:pressed', shortcut: c.chord })
        } catch {
          /* context gone */
        }
        return
      }
    }
  }
  document.addEventListener('keydown', onKey, true)
  w.__bcShortcut = {
    stop() {
      document.removeEventListener('keydown', onKey, true)
      delete w.__bcShortcut
    },
  }
}

/** Inject the shortcut listener into a single tab (guarded). */
async function injectShortcutsIntoTab(
  tabId: number,
  url: string | undefined,
  chords: string[],
): Promise<void> {
  if (!/^https?:/i.test(url ?? '')) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: shortcutListenerInPage as unknown as (...args: unknown[]) => void,
      args: [chords],
    })
  } catch {
    /* ignore injection failures */
  }
}

/**
 * Wire keyboard-shortcut workflows: inject the listener into existing tabs and
 * into tabs that finish loading; handle `shortcut:pressed` messages by running
 * the matching workflow. Call once at service-worker startup. Returns false for
 * unrelated messages.
 */
export function initShortcutTriggers(): boolean {
  void (async () => {
    const sh = await shortcutWorkflows()
    const chords = sh.map((s) => s.shortcut)
    if (chords.length === 0) return
    const tabs = await chrome.tabs.query({})
    for (const t of tabs) {
      if (typeof t.id === 'number') await injectShortcutsIntoTab(t.id, t.url, chords)
    }
    chrome.webNavigation.onCompleted.addListener((details) => {
      if (details.frameId !== 0) return
      void injectShortcutsIntoTab(details.tabId, details.url, chords)
    })
  })()
  return true
}

/** Handle a `shortcut:pressed` runtime message; runs the bound workflow. */
export async function handleShortcutPressed(message: unknown): Promise<boolean> {
  const msg = message as { type?: string; shortcut?: string }
  if (msg.type !== 'shortcut:pressed' || !msg.shortcut) return false
  const sh = await shortcutWorkflows()
  const match = sh.find((s) => s.shortcut === msg.shortcut)
  if (match) {
    // The runner is provided by the background index via a callback set below.
    runWorkflowRef?.(match.wf.id)
  }
  return true
}

/** Injected by the background index so this module can launch a workflow. */
let runWorkflowRef: ((workflowId: string) => void) | null = null
export function setWorkflowRunner(fn: (workflowId: string) => void): void {
  runWorkflowRef = fn
}
