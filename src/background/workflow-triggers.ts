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

import { getWorkflow, listWorkflows } from '../lib/workflow/storage'
import type { Workflow, WorkflowNode } from '../lib/workflow/types'
import { latestPluginWindowId } from './automation-scope'
import { coerceIntervalMinutes, nextRunAt } from '../lib/schedule'
import type { Schedule } from '../lib/scheduler-types'

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
export function normalizeShortcut(chord: string): {
  key: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
} {
  const parts = chord
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
  const has = (name: string) => parts.includes(name)
  const key = parts
    .filter((p) => !['ctrl', 'control', 'shift', 'alt', 'meta', 'cmd', 'command'].includes(p))
    .join('+')
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
    const parts = chord
      .toLowerCase()
      .split('+')
      .map((s) => s.trim())
    const has = (n: string) => parts.includes(n)
    const key = parts
      .filter((p) => !['ctrl', 'control', 'shift', 'alt', 'meta', 'cmd', 'command'].includes(p))
      .join('+')
    return {
      chord,
      key,
      ctrl: has('ctrl') || has('control'),
      shift: has('shift'),
      alt: has('alt'),
      meta: has('meta') || has('cmd') || has('command'),
    }
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

/**
 * Handle a `shortcut:pressed` runtime message; runs the bound workflow.
 *
 * A keyboard chord is an explicit gesture on a specific tab, so the run is
 * scoped to THAT window (`sender.tab.windowId`) — pressing the shortcut in any
 * window works, and the workflow acts there.
 */
export async function handleShortcutPressed(
  message: unknown,
  sender?: chrome.runtime.MessageSender,
): Promise<boolean> {
  const msg = message as { type?: string; shortcut?: string }
  if (msg.type !== 'shortcut:pressed' || !msg.shortcut) return false
  const sh = await shortcutWorkflows()
  const match = sh.find((s) => s.shortcut === msg.shortcut)
  if (match) {
    // The runner is provided by the background index via a callback set below.
    runWorkflowRef?.(match.wf.id, sender?.tab?.windowId)
  }
  return true
}

/** Injected by the background index so this module can launch a workflow. */
let runWorkflowRef: ((workflowId: string, scopeWindowId?: number) => void) | null = null
export function setWorkflowRunner(fn: (workflowId: string, scopeWindowId?: number) => void): void {
  runWorkflowRef = fn
}

// --- Scheduled workflow triggers ---------------------------------------------
//
// Workflows whose trigger block is time-based (`interval`, `specific-day`, or a
// one-shot `date`) are armed as one-shot alarms, mirroring how tasks are
// scheduled. `interval` and `specific-day` re-arm themselves after each fire; a
// `date` trigger fires exactly once and is then cleared. The `scheduled` (cron)
// trigger is not auto-armed here.

export const WORKFLOW_TRIGGER_ALARM_PREFIX = 'wftrigger:'
/** `chrome.alarms` rejects delays under 1 minute. */
const MIN_ALARM_DELAY_MS = 60_000

export function workflowTriggerAlarmName(workflowId: string): string {
  return `${WORKFLOW_TRIGGER_ALARM_PREFIX}${workflowId}`
}

/** True when an alarm name belongs to a scheduled workflow trigger. */
export function isWorkflowTriggerAlarm(name: string): boolean {
  return name.startsWith(WORKFLOW_TRIGGER_ALARM_PREFIX)
}

/** The trigger block's data payload, if present, read from the workflow graph. */
function triggerNodeData(wf: Workflow): Record<string, unknown> | undefined {
  const node = wf.drawflow.nodes.find(
    (n: WorkflowNode) => (n.data?.['blockId'] as string) === 'trigger' || n.label === 'trigger',
  )
  return node?.data
}

function clampRange(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function parseTime(value: unknown): { hour: number; minute: number } {
  const s = typeof value === 'string' ? value : ''
  const match = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!match) return { hour: 0, minute: 0 }
  return {
    hour: clampRange(Number(match[1]), 0, 23),
    minute: clampRange(Number(match[2]), 0, 59),
  }
}

/**
 * Whether a workflow should be auto-armed from its trigger block.
 *
 * - `interval` → a repeating `{ kind: 'interval' }` schedule;
 * - `specific-day` → `{ kind: 'weekly', days, hour, minute }`;
 * - `date` → a one-shot run at a specific epoch (`once`).
 *
 * Returns `null` when the workflow is off or its trigger is not time-based.
 */
export function workflowAutoTrigger(
  wf: Workflow,
): { kind: 'schedule'; schedule: Schedule } | { kind: 'once'; epoch: number } | null {
  if (!triggerEnabled(wf)) return null
  const data = triggerNodeData(wf)
  const type = data?.['type']
  if (type === 'interval') {
    return {
      kind: 'schedule',
      schedule: { kind: 'interval', minutes: coerceIntervalMinutes(data?.['interval']) },
    }
  }
  if (type === 'specific-day') {
    const rawDays = Array.isArray(data?.['days']) ? (data?.['days'] as unknown[]) : []
    const days = Array.from(
      new Set(rawDays.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)),
    )
    if (days.length === 0) return null
    const { hour, minute } = parseTime(data?.['time'])
    return { kind: 'schedule', schedule: { kind: 'weekly', days, hour, minute } }
  }
  if (type === 'date') {
    const dateStr = typeof data?.['date'] === 'string' ? (data?.['date'] as string) : ''
    if (!dateStr) return null
    const { hour, minute } = parseTime(data?.['time'])
    const epoch = new Date(
      `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
    ).getTime()
    if (!Number.isFinite(epoch)) return null
    return { kind: 'once', epoch }
  }
  return null
}

/** Arms (or clears) the auto-trigger alarm for a single workflow. */
export async function scheduleWorkflowTrigger(workflowId: string): Promise<void> {
  const name = workflowTriggerAlarmName(workflowId)
  const wf = await getWorkflow(workflowId)
  if (!wf) {
    await chrome.alarms.clear(name)
    return
  }
  const auto = workflowAutoTrigger(wf)
  if (!auto) {
    await chrome.alarms.clear(name)
    return
  }
  let when: number
  if (auto.kind === 'once') {
    when = auto.epoch
  } else {
    const next = nextRunAt(auto.schedule, Date.now())
    when = next ?? Date.now() + coerceIntervalMinutes(60) * 60_000
  }
  const safeWhen = Math.max(when, Date.now() + MIN_ALARM_DELAY_MS)
  await chrome.alarms.create(name, { when: safeWhen })
}

/** Clears stale workflow-trigger alarms and re-arms every configured workflow. */
export async function rescheduleAllWorkflowTriggers(): Promise<void> {
  const [existing, workflows] = await Promise.all([chrome.alarms.getAll(), listWorkflows()])
  const known = new Set(
    workflows.filter((wf) => workflowAutoTrigger(wf)).map((wf) => workflowTriggerAlarmName(wf.id)),
  )
  for (const alarm of existing) {
    if (alarm.name.startsWith(WORKFLOW_TRIGGER_ALARM_PREFIX) && !known.has(alarm.name)) {
      await chrome.alarms.clear(alarm.name)
    }
  }
  for (const wf of workflows) {
    await scheduleWorkflowTrigger(wf.id)
  }
  // The observer registry is the other half of the trigger state: re-injecting
  // is what both arms a newly added `element-change` trigger and drops one whose
  // workflow was disabled, re-pointed or deleted.
  await refreshElementChangeObservers()
}

/**
 * Handles a workflow-trigger alarm firing: runs the workflow and re-arms if the
 * trigger recurs. A one-shot `date` trigger is cleared instead so it cannot
 * fire again.
 *
 * Scoped like every other automation path: while a panel window is open the
 * run acts inside it; with no panel open the legacy global resolution applies.
 */
export async function handleWorkflowTriggerAlarm(alarmName: string): Promise<void> {
  const workflowId = alarmName.slice(WORKFLOW_TRIGGER_ALARM_PREFIX.length)
  const wf = await getWorkflow(workflowId)
  if (!wf) {
    await chrome.alarms.clear(alarmName)
    return
  }
  const auto = workflowAutoTrigger(wf)
  if (auto && auto.kind === 'schedule') {
    // Re-arm the next firing before running so a crash does not strand the schedule.
    await scheduleWorkflowTrigger(workflowId)
  } else {
    // One-shot `date` trigger (or a now-invalid trigger): fire once, then stop.
    await chrome.alarms.clear(alarmName)
  }
  runWorkflowRef?.(workflowId, latestPluginWindowId())
}

// --- Element-change workflow triggers ----------------------------------------
//
// A workflow whose trigger block says `element-change` watches one element on
// the page and runs when it mutates. The observer lives in the PAGE (the
// service worker cannot see the DOM), so it is injected the same way the
// keyboard-shortcut listener is: a self-contained function plus an in-page
// registry that a re-injection replaces wholesale.
//
// Scope: an observer is only injected into tabs whose URL matches the trigger's
// `matchPattern`, and the run is scoped to the reporting tab's window — the
// mutation happened there, so that is where the workflow should act.

/** What one `element-change` trigger watches. */
export interface ElementChangeSpec {
  workflowId: string
  /** Element whose mutations fire the workflow. */
  selector: string
  /** URL glob the observer applies to; empty means "any http(s) page". */
  matchPattern: string
  options: {
    subtree: boolean
    childList: boolean
    attributes: boolean
    characterData: boolean
    /** Only watched when `attributes` is on. */
    attributeFilter: string[]
  }
}

/** The trigger block's `observeElement` payload, when the graph has one. */
function observeElementOf(wf: Workflow): Record<string, unknown> | undefined {
  const data = triggerNodeData(wf)
  const observe = data?.['observeElement']
  return observe && typeof observe === 'object' ? (observe as Record<string, unknown>) : undefined
}

/** Every workflow configured to fire on an element change. */
export async function elementChangeWorkflows(): Promise<ElementChangeSpec[]> {
  const all = await listWorkflows()
  const out: ElementChangeSpec[] = []
  for (const wf of all) {
    if (!triggerEnabled(wf) || effectiveTriggerKind(wf) !== 'element-change') continue
    const observe = observeElementOf(wf)
    const selector = typeof observe?.['selector'] === 'string' ? observe.selector.trim() : ''
    // Without a selector there is nothing to watch; `validateWorkflowForRun`
    // reports that separately.
    if (!selector) continue
    const raw = observe?.['targetOptions']
    const target = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const filter = Array.isArray(target['attributeFilter'])
      ? (target['attributeFilter'] as unknown[]).map(String).filter(Boolean)
      : []
    out.push({
      workflowId: wf.id,
      selector,
      matchPattern: typeof observe?.['matchPattern'] === 'string' ? observe.matchPattern : '',
      options: {
        // `childList` defaults on: watching an element for "it changed" without
        // noticing its children change is almost never what the user meant.
        subtree: target['subtree'] === true,
        childList: target['childList'] !== false,
        attributes: target['attributes'] === true,
        characterData: target['characterData'] === true,
        attributeFilter: filter,
      },
    })
  }
  return out
}

/**
 * Self-contained observer installer injected into each tab. Re-invocation
 * REPLACES the previous registry, which is also how a disabled / deleted /
 * re-pointed trigger is unregistered. No imports or closures (it is injected).
 */
export function elementChangeObserverInPage(specs: ElementChangeSpec[]): void {
  const w = window as unknown as { __bcElementWatch?: { stop: () => void } }
  if (w.__bcElementWatch) w.__bcElementWatch.stop()

  const observers: MutationObserver[] = []
  const timers = new Map<string, number>()

  // A mutation arrives in bursts; one run per burst is the useful granularity,
  // and it keeps a chatty DOM from queueing a run per node.
  const report = (workflowId: string): void => {
    if (timers.has(workflowId)) return
    timers.set(
      workflowId,
      window.setTimeout(() => {
        timers.delete(workflowId)
        try {
          // `sendMessage` returns a promise in MV3: an invalidated extension
          // context REJECTS it rather than throwing, so the `catch` below alone
          // would leave an unhandled rejection in the page's console.
          const sent: unknown = chrome.runtime.sendMessage({
            type: 'trigger:element-change',
            workflowId,
          })
          void Promise.resolve(sent).catch(() => {
            /* extension context gone */
          })
        } catch {
          /* context gone */
        }
      }, 500),
    )
  }

  for (const spec of specs) {
    const options: MutationObserverInit = {
      subtree: spec.options.subtree,
      childList: spec.options.childList,
      attributes: spec.options.attributes,
      characterData: spec.options.characterData,
    }
    if (spec.options.attributes && spec.options.attributeFilter.length > 0) {
      options.attributeFilter = spec.options.attributeFilter
    }

    const attach = (element: Element): void => {
      const observer = new MutationObserver(() => report(spec.workflowId))
      observer.observe(element, options)
      observers.push(observer)
    }

    const found = document.querySelector(spec.selector)
    if (found) {
      attach(found)
      continue
    }
    // The element may not exist yet (SPA, lazy render). Watch for it and attach
    // the real observer the moment it appears — without this the workflow would
    // silently never fire on any page that renders late. The placeholder itself
    // never reports: only a real match does.
    const placeholder = new MutationObserver(() => {
      const element = document.querySelector(spec.selector)
      if (!element) return
      placeholder.disconnect()
      attach(element)
    })
    placeholder.observe(document.documentElement, { childList: true, subtree: true })
    observers.push(placeholder)
  }

  w.__bcElementWatch = {
    stop() {
      for (const observer of observers) observer.disconnect()
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
      delete w.__bcElementWatch
    },
  }
}

/** Does this tab's URL fall inside the spec's match pattern? */
function tabMatchesPattern(url: string | undefined, matchPattern: string): boolean {
  if (!/^https?:/i.test(url ?? '')) return false
  if (!matchPattern) return true
  // Glob form (`https://example.com/*`): translate to a regex, like the
  // visit-web matcher does.
  const escaped = matchPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  try {
    return new RegExp(`^${escaped}$`, 'i').test(url!)
  } catch {
    return false
  }
}

/**
 * Inject the current observer registry into every matching tab.
 *
 * Called on startup, on navigation, and after any workflow save / delete /
 * toggle — re-injection is what both registers a new trigger and drops a
 * removed one, so it must run whenever the set changes.
 */
export async function refreshElementChangeObservers(): Promise<void> {
  let specs: ElementChangeSpec[]
  try {
    specs = await elementChangeWorkflows()
  } catch {
    return
  }
  let tabs: chrome.tabs.Tab[]
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return
  }
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue
    const url = tab.url
    if (!/^https?:/i.test(url ?? '')) continue
    const mine = specs.filter((spec) => tabMatchesPattern(url, spec.matchPattern))
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: elementChangeObserverInPage as unknown as (...args: unknown[]) => void,
        args: [mine],
      })
    } catch {
      /* ignore injection failures (restricted pages, tab gone) */
    }
  }
}

/** Workflows whose observer already fired a run that is still in flight. */
const elementChangeRunning = new Set<string>()

/**
 * Wire element-change workflows: install the observers in existing tabs and in
 * tabs that finish loading. Call once at service-worker startup.
 *
 * The navigation listener re-injects on every completed load because a new
 * document has no observer at all — the injected registry does not survive a
 * navigation.
 */
export function initElementChangeTriggers(): void {
  void refreshElementChangeObservers()
  chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId !== 0) return
    void (async () => {
      let specs: ElementChangeSpec[]
      try {
        specs = await elementChangeWorkflows()
      } catch {
        return
      }
      const mine = specs.filter((spec) => tabMatchesPattern(details.url, spec.matchPattern))
      try {
        await chrome.scripting.executeScript({
          target: { tabId: details.tabId, allFrames: false },
          func: elementChangeObserverInPage as unknown as (...args: unknown[]) => void,
          args: [mine],
        })
      } catch {
        /* ignore injection failures (restricted pages, tab gone) */
      }
    })()
  })
}

/** Release the re-entrancy guard once a triggered run settles. */
export function releaseElementChangeRun(workflowId: string): void {
  elementChangeRunning.delete(workflowId)
}

/**
 * Handle a `trigger:element-change` message from an injected observer; runs the
 * bound workflow. Returns false for unrelated messages.
 *
 * Re-entrancy: a workflow that is already running because of this trigger is
 * skipped. Without the guard, a workflow that itself mutates the observed
 * element would feed itself forever.
 */
export async function handleElementChange(
  message: unknown,
  sender?: chrome.runtime.MessageSender,
): Promise<boolean> {
  const msg = message as { type?: string; workflowId?: string } | null
  if (msg?.type !== 'trigger:element-change' || !msg.workflowId) return false
  const workflowId = msg.workflowId
  if (elementChangeRunning.has(workflowId)) return true
  // Re-validate against storage: the observer may outlive a workflow that was
  // disabled or deleted since it was injected.
  const wf = await getWorkflow(workflowId)
  if (!wf || !triggerEnabled(wf) || effectiveTriggerKind(wf) !== 'element-change') return true

  elementChangeRunning.add(workflowId)
  try {
    // Scoped to the window the mutation happened in, like the shortcut path:
    // the observed element lives there, so that is where the workflow acts.
    runWorkflowRef?.(workflowId, sender?.tab?.windowId)
  } finally {
    // `runWorkflowRef` is fire-and-forget, so release on the next tick; a
    // slower run is still protected by the observer's own debounce.
    setTimeout(() => releaseElementChangeRun(workflowId), 1000)
  }
  return true
}
