/**
 * Window selection for unattended runs.
 *
 * Unattended entry points — the local-agent bridge, scheduled tasks, Feishu
 * commands — may only act on "plugin windows" (panel connected OR minimized,
 * see `automation-scope`). With several plugin windows open, WHICH one to use
 * is policy, not chance:
 *
 * - `latest` (default): the most recently used plugin window — the plain
 *   {@link currentPluginScope} resolution, no window enumeration at all.
 * - `ask`: broadcast a `window.pick.request` to every connected side panel;
 *   the first `window.pick.response` wins. Nobody answers within
 *   {@link PICK_TIMEOUT_MS} → fall back to `latest`. With a single plugin
 *   window there is nothing to choose — it is used directly, and when no
 *   panel is connected (minimized-only setups) asking is impossible, so the
 *   fallback is immediate.
 * - `fixed`: the configured {@link Settings.unattendedWindowId} while it is
 *   still a plugin window; otherwise fall back to `latest` (never escape the
 *   operable set).
 *
 * The pure decision ({@link resolveUnattendedWindow}) is separated from the
 * async orchestration so the policy truth table is unit-testable without
 * `chrome`.
 *
 * The local-agent bridge has its own stricter resolution,
 * {@link resolveBridgeTarget}: each connected agent is assigned to a window via
 * `settings.localAgentBindings` (connection name -> window id, N:N), so several
 * agents can drive SEPARATE windows concurrently without leaking actions across
 * them. A per-worker `agentId -> windowId` session map provides exact matching
 * for the process-scoped random id and survives an agent rename until restart.
 *
 * @module background/window-policy
 */

import { messagesFor, type Locale } from '../lib/i18n'
import { getSettings, newId } from '../lib/storage'
import type { UnattendedWindowPolicy } from '../lib/types'
import type { WindowChoice, WindowPickRequest } from '../lib/messages'
import { getRun, listRunning, setRunWindow } from './running-tasks'
import {
  closeRunWindow,
  createRunWindow,
  currentPluginScope,
  hasPanelWindows,
  isPluginWindow,
  latestPluginWindowId,
  listNormalWindows,
  normalScopeFromWindowId,
  reclaimOrphanRunWindows,
  type ScopeWindow,
} from './automation-scope'

/** How long a `window.pick.request` waits for the user before falling back. */
export const PICK_TIMEOUT_MS = 30_000

/** Outcome of the pure policy decision. `none` = no plugin window anywhere. */
export type UnresolvedScope =
  { kind: 'scope'; windowId: number } | { kind: 'ask' } | { kind: 'none' }

/**
 * Decide the target window for an unattended run. `windows` are the ordinary
 * browser windows (any order, from {@link listNormalWindows});
 * `latestWindowId` is the most recently used plugin window
 * ({@link latestPluginWindowId}); `fixedWindowId` is the configured fixed
 * target, when the policy is `fixed`.
 */
export function resolveUnattendedWindow(
  policy: UnattendedWindowPolicy,
  windows: WindowChoice[],
  latestWindowId: number | undefined,
  fixedWindowId?: number,
): UnresolvedScope {
  const pluginWindows = windows.filter((w) => w.isPanel || w.isMinimized)
  if (pluginWindows.length === 0) return { kind: 'none' }

  // The latest plugin window, defensive against a stale latestWindowId.
  const latestId =
    typeof latestWindowId === 'number' && pluginWindows.some((w) => w.windowId === latestWindowId)
      ? latestWindowId
      : pluginWindows[pluginWindows.length - 1]!.windowId

  if (policy === 'ask') {
    // One candidate = nothing to choose; two+ = let the user pick (the
    // caller degrades to `latest` when no panel is around to ask).
    return pluginWindows.length === 1
      ? { kind: 'scope', windowId: pluginWindows[0]!.windowId }
      : { kind: 'ask' }
  }

  if (policy === 'fixed' && typeof fixedWindowId === 'number') {
    if (pluginWindows.some((w) => w.windowId === fixedWindowId)) {
      return { kind: 'scope', windowId: fixedWindowId }
    }
    // Fixed window closed, or its plugin is: stay inside the operable set
    // rather than falling out of "only plugin windows" scope.
  }

  return { kind: 'scope', windowId: latestId }
}

// --- Pick channel (wired by the background entry point) -----------------------

/** Broadcasts a pick request to every connected panel; answers may race. */
type PickRequester = (request: WindowPickRequest) => Promise<void>

let pickRequester: PickRequester | null = null

/** Registers the broadcast implementation (index.ts owns the chrome calls). */
export function setWindowPickRequester(fn: PickRequester | null): void {
  pickRequester = fn
}

const pendingPicks = new Map<string, (windowId: number | null) => void>()

/**
 * Delivers a panel's answer to the pending pick. Called from the generic
 * onMessage listener; unknown request ids (already timed out) are ignored.
 */
export function handleWindowPickResponse(requestId: string, windowId: number | null): void {
  const resolve = pendingPicks.get(requestId)
  if (!resolve) return
  pendingPicks.delete(requestId)
  resolve(windowId)
}

function requestPick(request: WindowPickRequest): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPicks.delete(request.requestId)
      resolve(null)
    }, PICK_TIMEOUT_MS)
    pendingPicks.set(request.requestId, (windowId) => {
      clearTimeout(timer)
      resolve(windowId)
    })
    if (pickRequester) {
      void pickRequester(request).catch(() => {
        /* broadcast failure → the timeout fallback answers null */
      })
    } else {
      clearTimeout(timer)
      pendingPicks.delete(request.requestId)
      resolve(null)
    }
  })
}

/**
 * The window scope for one unattended run, per the configured policy.
 * `undefined` = no scope = legacy global resolution (the plugin is closed
 * everywhere).
 */
export async function resolveUnattendedScope(): Promise<ScopeWindow | undefined> {
  const settings = await getSettings()
  const policy: UnattendedWindowPolicy = settings.unattendedWindowPolicy ?? 'latest'

  // Fast path: the default policy IS the plain plugin-window resolution —
  // no window enumeration, no behaviour change for existing setups.
  if (policy === 'latest') return currentPluginScope()

  const windows = await listNormalWindows()
  const decision = resolveUnattendedWindow(
    policy,
    windows,
    latestPluginWindowId(),
    settings.unattendedWindowId,
  )
  if (decision.kind === 'none') return undefined
  if (decision.kind === 'scope') {
    const scope = await normalScopeFromWindowId(decision.windowId)
    return scope && isPluginWindow(scope.windowId) ? scope : undefined
  }

  // ask: impossible without a connected panel (minimized windows have no UI
  // to answer) — degrade immediately instead of stalling the run for 30 s.
  if (!pickRequester || !hasPanelWindows()) return currentPluginScope()

  const choices = windows.filter((w) => w.isPanel || w.isMinimized)
  const picked = await requestPick({
    type: 'window.pick.request',
    requestId: newId(),
    windows: choices,
  })
  if (typeof picked !== 'number') return currentPluginScope() // timeout / cancel
  const scope = await normalScopeFromWindowId(picked)
  return scope && isPluginWindow(scope.windowId) ? scope : currentPluginScope()
}

// --- Run windows: parallel execution for colliding unattended runs ------------

/**
 * The window one unattended run drives, and who has to clean it up.
 *
 * Two runs cannot share a window: they would resolve to the same active tab and
 * step on each other's page. So a run that finds the board busy gets a window of
 * its own ({@link createRunWindow}) and closes it when it settles
 * ({@link releaseRunWindow}). A run that finds the board free behaves exactly as
 * before — the shared plugin window, no window churn at all.
 */
export interface RunWindowLease {
  /** Window to scope the run to; `undefined` = legacy global resolution. */
  windowId?: number
  /** True only when THIS run created that window and must release it. */
  dedicated: boolean
  /** Cascade slot held by a dedicated lease. */
  tier?: number
}

/**
 * How long a run may wait for a free dedicated window before its whole run
 * fails. It must stay under the keepalive's `MAX_HOLD_MS` (10 min): a waiter
 * that outlives the worker becomes exactly the zombie the running-tasks module
 * doc warns about. Nine minutes leaves a minute of slack for the run itself to
 * be recorded as failed.
 */
export const RUN_WINDOW_MAX_WAIT_MS = 9 * 60_000

/** Why a dedicated window could not be had. The caller turns this into copy. */
export type RunWindowFailureReason = 'capped' | 'cancelled'

export class RunWindowUnavailableError extends Error {
  constructor(
    readonly reason: RunWindowFailureReason,
    readonly max: number,
  ) {
    super(`run window unavailable (${reason}, cap ${max})`)
    this.name = 'RunWindowUnavailableError'
  }
}

/** Cascade slots in use: tier → window id (`undefined` = reserved, not created yet). */
const occupiedRunWindows = new Map<number, number | undefined>()

/** A run queued for a slot; the granter hands it the freed tier. */
interface RunWindowWaiter {
  grant: (tier: number) => void
  decline: (error: Error) => void
}

const runWindowWaiters: RunWindowWaiter[] = []

/** Lowest unused slot below `cap`, or undefined when every slot is taken. */
function nextFreeRunWindowTier(cap: number): number | undefined {
  for (let tier = 0; tier < cap; tier++) if (!occupiedRunWindows.has(tier)) return tier
  return undefined
}

/**
 * Take a slot now, or queue FIFO for one (mirroring the Runner's
 * `RunService.enqueue`, `server/src/run-service.ts`). The queue is in-memory by
 * design: a worker eviction drops it, and the alarm that woke the run re-arms
 * itself anyway.
 *
 * Rejects with {@link RunWindowUnavailableError} when the caller's abort signal
 * fires (terminate from the board) or after {@link RUN_WINDOW_MAX_WAIT_MS}.
 */
function acquireRunWindowTier(
  cap: number,
  signal?: AbortSignal,
  onWait?: () => void,
): Promise<number> {
  const free = nextFreeRunWindowTier(cap)
  if (free !== undefined) {
    occupiedRunWindows.set(free, undefined)
    return Promise.resolve(free)
  }
  return new Promise<number>((resolve, reject) => {
    onWait?.()
    const settle = () => {
      clearTimeout(timeout)
      if (signal) signal.removeEventListener('abort', onAbort)
      const index = runWindowWaiters.indexOf(waiter)
      if (index >= 0) runWindowWaiters.splice(index, 1)
    }
    const onAbort = () => waiter.decline(new RunWindowUnavailableError('cancelled', cap))
    const waiter: RunWindowWaiter = {
      grant: (tier) => {
        settle()
        occupiedRunWindows.set(tier, undefined)
        resolve(tier)
      },
      decline: (error) => {
        settle()
        reject(error)
      },
    }
    const timeout = setTimeout(
      () => waiter.decline(new RunWindowUnavailableError('capped', cap)),
      RUN_WINDOW_MAX_WAIT_MS,
    )
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    runWindowWaiters.push(waiter)
    if (signal?.aborted) onAbort()
  })
}

/**
 * Free a slot and hand it to the next queued run, if any. Called by
 * {@link releaseRunWindow} and when window creation fails.
 */
function releaseRunWindowTier(tier: number): void {
  occupiedRunWindows.delete(tier)
  runWindowWaiters.shift()?.grant(tier)
}

/**
 * The window for one unattended run. Callers that already know their window (a
 * user gesture: the panel's Run button, a shortcut, the context menu) never come
 * here — this is for the sender-less paths, which have no window of their own.
 *
 * `selfRunId` must be a run already on the board, and `signal` its abort
 * controller: the run announces itself before leasing, which is what lets two
 * alarms firing in the same instant both see each other as busy — and both take
 * a window of their own instead of racing for the shared one.
 */
export async function leaseRunWindow(
  selfRunId: string,
  signal?: AbortSignal,
  onWait?: () => void,
): Promise<RunWindowLease> {
  await reclaimRunWindowsOnce()
  const settings = await getSettings()
  const shared = await resolveUnattendedScope()
  // A run with no recorded window is a chat turn or a run still deciding: either
  // way it may be about to act in the shared window, so assume the worst and step
  // aside. Runs that recorded a DIFFERENT window cannot collide with us.
  const collides = listRunning().some(
    (run) =>
      run.runId !== selfRunId && (run.windowId === undefined || run.windowId === shared?.windowId),
  )
  const sharedLease: RunWindowLease = {
    ...(shared ? { windowId: shared.windowId } : {}),
    dedicated: false,
  }
  if (!collides) {
    if (shared) setRunWindow(selfRunId, shared.windowId, 'shared')
    return sharedLease
  }

  const tier = await acquireRunWindowTier(settings.maxConcurrentRunWindows, signal, onWait)
  const windowId = await createRunWindow(selfRunId, tier)
  if (windowId === undefined) {
    // Chrome refused the window: fall back to the shared scope, i.e. the
    // behaviour this run has always had, rather than failing the run over a
    // window.
    releaseRunWindowTier(tier)
    return sharedLease
  }
  occupiedRunWindows.set(tier, windowId)
  setRunWindow(selfRunId, windowId, 'dedicated')
  return { windowId, dedicated: true, tier }
}

/**
 * The run-visible wording for a failed lease. Lives next to the error it
 * describes so every caller (task runner, alarm workflow runner) reports the
 * same thing in the user's language.
 */
export function runWindowFailureText(error: RunWindowUnavailableError, locale: Locale): string {
  const t = messagesFor(locale)
  return error.reason === 'capped'
    ? t.taskRunWindowCapReached({ max: error.max })
    : t.taskRunCancelledWhileQueued
}

/**
 * Close a run's own window and free its slot. Idempotent, and safe to call for a
 * shared lease (it does nothing). Must run in the caller's `finally`: a leaked
 * window would sit on the user's desktop holding a slot forever.
 */
export async function releaseRunWindow(lease: RunWindowLease): Promise<void> {
  if (!lease.dedicated) return
  if (typeof lease.windowId === 'number') await closeRunWindow(lease.windowId)
  if (typeof lease.tier === 'number') releaseRunWindowTier(lease.tier)
}

/** Windows reclaimed since this worker woke; see {@link reclaimRunWindowsOnce}. */
let runWindowsReclaimed = false

/**
 * Close dedicated windows left behind by runs that died with an earlier service
 * worker: the window survives an eviction, the code that would have closed it
 * does not.
 */
export async function reclaimRunWindows(): Promise<number[]> {
  return reclaimOrphanRunWindows((runId) => !!getRun(runId))
}

/**
 * Reclaim for a waking worker (called by the background entry point at boot).
 * Marks the once-flag so {@link leaseRunWindow} does not repeat the sweep.
 */
export async function recallRunWindowsOnWake(): Promise<number[]> {
  runWindowsReclaimed = true
  return reclaimRunWindows()
}

/** Runs {@link reclaimRunWindows} at most once per worker lifetime. */
async function reclaimRunWindowsOnce(): Promise<void> {
  if (runWindowsReclaimed) return
  runWindowsReclaimed = true
  await reclaimRunWindows()
}

/**
 * Everything the run-window layer holds, for tests and for the board's own
 * diagnostics: live slots and queued runs.
 */
export function runWindowSlotState(): { occupied: number[]; queued: number } {
  return {
    occupied: [...occupiedRunWindows.keys()].sort((a, b) => a - b),
    queued: runWindowWaiters.length,
  }
}

// --- Local-agent bridge: per-connection window assignments (N:N) --------------

/** Identity carried by every adapter request (agentId is a per-process UUID). */
export interface BridgeIdentity {
  agentId?: string
  agentName?: string
}

/**
 * Process-scoped exact matches: the random `agentId` dies with every adapter
 * process, so it cannot be persisted, but within one worker lifetime it lets a
 * renamed agent keep its window (the panel assignment command seeds it; name
 * hits memoize into it lazily). Disposable module state — rebuilt per wake.
 */
const sessionAgentWindows = new Map<string, number>()

/** Records (or replaces) one connection's window for this worker lifetime. */
export function rememberAgentWindow(agentId: string | undefined, windowId: number): void {
  if (agentId) sessionAgentWindows.set(agentId, windowId)
}

/** Drops a connection's session binding (used when the assignment is removed). */
export function forgetAgentWindow(agentId: string | undefined): void {
  if (agentId) sessionAgentWindows.delete(agentId)
}

/** Outcome of the pure bridge-window decision. */
export type BridgeWindowDecision =
  | { kind: 'window'; windowId: number; source: 'session-id' | 'name' | 'legacy' }
  /** The user opted into assignments but this identity has none. */
  | { kind: 'unbound' }
  /** No usable assignment: fall back to the default unattended resolution. */
  | { kind: 'default' }

/**
 * Pure decision (unit-testable without `chrome`): which window a local-agent
 * request may use.
 *
 * Candidates are checked in priority order — the per-worker session id map,
 * then the persisted name binding, then the deprecated legacy pair (only when
 * its selected id matches) — and the FIRST one whose window currently hosts
 * the plugin (present in `windows`) wins. A configured-but-stale candidate
 * (window closed / panel gone) is skipped rather than fatal: when the identity
 * had ANY candidate the result is `default` (a bound connection must never be
 * silently swallowed), while an identity with no candidate at all is `unbound`
 * only once the user has created at least one binding. Zero bindings always
 * stays `default`, preserving the zero-setup out-of-box behaviour.
 */
export function resolveBridgeWindow(input: {
  identity?: BridgeIdentity
  /** Persisted `agentName -> windowId` assignments. */
  bindings: Record<string, number>
  /** This worker's `agentId -> windowId` exact matches. */
  sessionBindings: ReadonlyMap<string, number>
  /** Deprecated global selection, honoured only for the matching id. */
  legacy?: { activeAgentId?: string; windowId?: number }
  /** Window ids that currently exist, are `normal`, and host the plugin. */
  windows: ReadonlyArray<{ windowId: number }>
}): BridgeWindowDecision {
  const valid = new Set(input.windows.map((window) => window.windowId))
  const candidates: Array<{ windowId: number; source: 'session-id' | 'name' | 'legacy' }> = []

  const agentId = typeof input.identity?.agentId === 'string' ? input.identity.agentId : ''
  const agentName = typeof input.identity?.agentName === 'string' ? input.identity.agentName : ''

  if (agentId) {
    const sessionWindow = input.sessionBindings.get(agentId)
    if (typeof sessionWindow === 'number') {
      candidates.push({ windowId: sessionWindow, source: 'session-id' })
    }
  }
  if (agentName) {
    const nameWindow = input.bindings[agentName]
    if (typeof nameWindow === 'number') {
      candidates.push({ windowId: nameWindow, source: 'name' })
    }
  }
  if (
    agentId &&
    input.legacy?.activeAgentId === agentId &&
    typeof input.legacy.windowId === 'number'
  ) {
    candidates.push({ windowId: input.legacy.windowId, source: 'legacy' })
  }

  for (const candidate of candidates) {
    if (valid.has(candidate.windowId)) {
      return { kind: 'window', windowId: candidate.windowId, source: candidate.source }
    }
  }
  // The identity had a configured binding but every candidate is stale: serve
  // it through the default resolution rather than dropping the request.
  if (candidates.length > 0) return { kind: 'default' }
  // No candidate at all: once the user opted into ANY assignment, unknown
  // connections must be refused (the caller turns `unbound` into an actionable
  // error) instead of landing in whichever window was used last.
  if (Object.keys(input.bindings).length > 0) return { kind: 'unbound' }
  return { kind: 'default' }
}

/**
 * Window scope for one local-agent request.
 *
 * `{ scope, unbound: false }` — `scope` is the assigned window (validated at
 * use time: it must still exist, be `normal` and host the plugin — panel open
 * or minimized). A stale assignment degrades to the default unattended
 * resolution instead of failing, so a closed window never wedges an agent.
 *
 * `{ scope: undefined, unbound: true }` — assignments exist but this
 * connection has none; the caller refuses tool/prompt requests with an
 * actionable bilingual error (ping/tools.list stay open and simply skip
 * warmup).
 *
 * Each candidate window costs one `chrome.windows.get` (max three), never a
 * full `windows.getAll`, so the hot path stays as cheap as the old single pin
 * check.
 */
export async function resolveBridgeTarget(
  identity?: BridgeIdentity,
): Promise<{ scope: ScopeWindow | undefined; unbound: boolean }> {
  const settings = await getSettings()
  const bindings = settings.localAgentBindings ?? {}
  const legacy = {
    activeAgentId: settings.localAgentActiveAgent || undefined,
    windowId:
      typeof settings.localAgentWindowId === 'number' ? settings.localAgentWindowId : undefined,
  }

  // Collect the (max 3, de-duplicated) candidate window ids, then validate
  // each cheaply. The pure decision itself sees only the ones still usable.
  const candidateIds: number[] = []
  if (identity?.agentId) {
    const sessionWindow = sessionAgentWindows.get(identity.agentId)
    if (typeof sessionWindow === 'number') candidateIds.push(sessionWindow)
  }
  if (identity?.agentName && typeof bindings[identity.agentName] === 'number') {
    candidateIds.push(bindings[identity.agentName]!)
  }
  if (
    identity?.agentId &&
    settings.localAgentActiveAgent === identity.agentId &&
    typeof settings.localAgentWindowId === 'number'
  ) {
    candidateIds.push(settings.localAgentWindowId)
  }

  const windows: Array<{ windowId: number }> = []
  for (const windowId of [...new Set(candidateIds)]) {
    const scope = await normalScopeFromWindowId(windowId)
    if (scope && isPluginWindow(windowId)) windows.push({ windowId })
  }

  const decision = resolveBridgeWindow({
    identity,
    bindings,
    sessionBindings: sessionAgentWindows,
    legacy,
    windows,
  })

  if (decision.kind === 'window') {
    // Memoize the hit so a later rename of the connection keeps working for
    // the rest of this worker's life even though the persisted name key moved.
    if (identity?.agentId) sessionAgentWindows.set(identity.agentId, decision.windowId)
    return { scope: { windowId: decision.windowId }, unbound: false }
  }
  if (decision.kind === 'unbound') return { scope: undefined, unbound: true }
  return { scope: await resolveUnattendedScope(), unbound: false }
}

/** Test helper: clears pending picks, the wired requester, session binds and
 * the run-window slots (module state a test must not inherit from the last one). */
export function _resetWindowPolicyForTests(): void {
  pickRequester = null
  pendingPicks.clear()
  sessionAgentWindows.clear()
  occupiedRunWindows.clear()
  runWindowWaiters.splice(0)
  runWindowsReclaimed = false
}
