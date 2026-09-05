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
  | { kind: 'scope'; windowId: number }
  | { kind: 'ask' }
  | { kind: 'none' }

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
    typeof latestWindowId === 'number' &&
    pluginWindows.some((w) => w.windowId === latestWindowId)
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

/** Test helper: clears pending picks and the wired requester. */
export function _resetWindowPolicyForTests(): void {
  pickRequester = null
  pendingPicks.clear()
}
