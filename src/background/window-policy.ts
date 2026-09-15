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

import { getSettings, newId } from '../lib/storage'
import type { UnattendedWindowPolicy } from '../lib/types'
import type { WindowChoice, WindowPickRequest } from '../lib/messages'
import {
  currentPluginScope,
  hasPanelWindows,
  isPluginWindow,
  latestPluginWindowId,
  listNormalWindows,
  normalScopeFromWindowId,
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
      typeof settings.localAgentWindowId === 'number'
        ? settings.localAgentWindowId
        : undefined,
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

/** Test helper: clears pending picks, the wired requester and session binds. */
export function _resetWindowPolicyForTests(): void {
  pickRequester = null
  pendingPicks.clear()
  sessionAgentWindows.clear()
}
