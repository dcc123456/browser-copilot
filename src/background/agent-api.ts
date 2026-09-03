/**
 * Local-agent protocol: the shared request processor used by the plugin's
 * WebSocket client connection to the local adapter.
 *
 * ## WebSocket protocol
 *
 * The MV3 service worker connects OUT as a WebSocket *client* to a local
 * adapter running on this machine (`ws://127.0.0.1:8765`, see
 * {@link normalizeLocalAgentUrl}). The plugin no longer exposes
 * `chrome.runtime.onMessageExternal`, so sender-URL validation is unnecessary:
 * loopback is already enforced when the client's destination URL is
 * normalized. The local adapter sends requests over the WebSocket and the
 * plugin is the WS client that replies.
 *
 * Requests sent by the local adapter (and replies) are JSON:
 *
 * - `{ id, type: 'ping' }` → liveness check.
 * - `{ id, type: 'tools.list' }` → the JSON schemas of every tool, so an agent
 *   can discover click/fill/… without hard-coding them.
 * - `{ id, type: 'tool', tool, args?, token? }` → run exactly one tool
 *   (precise control). The result is the same object the model loop would see.
 * - `{ id, type: 'prompt', prompt, token? }` → run a full unattended agent turn
 *   in full-auto mode and return its final answer.
 *
 * `id` lets the WS client correlate a reply to its request; the processor below
 * does not echo it back — the WS client wraps the response with the request's
 * `id` when sending it.
 *
 * ## Security
 *
 * Two gates remain: the bridge must be enabled in settings, and, when a token
 * is configured, every request must carry it. Per-tool confirmation is
 * intentionally skipped: an unattended agent cannot click a side-panel button,
 * and the user opted in by enabling the bridge. Tools the user disabled in
 * settings are still refused.
 *
 * @module background/agent-api
 */

import { newId } from '../lib/storage'
import type { Settings } from '../lib/types'
import { TOOLS, runToolStandalone } from './agent'
import { runUnattendedPrompt } from './agent-unattended'
import { currentPanelScope } from './automation-scope'
import { execOnActiveTab, resolveAutomationTab } from './driver'
import { ensureTabMonitor } from './cdp-monitor'

/**
 * Session warmup, run when a remote agent pings or lists tools: resolve the
 * automation tab (fills the resolution cache), attach the CDP monitor and
 * prime the resident kernel in the tab, so the FIRST real tool call doesn't
 * pay cold-start costs (tab search chain + kernel injection). Best-effort —
 * any failure just means the first call warms up instead. Scoped to the panel
 * window when one is open, matching {@link runToolStandalone}.
 */
async function warmupAutomation(): Promise<void> {
  try {
    const scope = await currentPanelScope()
    const tab = await resolveAutomationTab(undefined, scope)
    if (!tab || typeof tab.id !== 'number') return
    await ensureTabMonitor(tab.id)
    await execOnActiveTab({ action: 'page_signature' }, undefined, undefined, scope).catch(() => {})
  } catch {
    /* best-effort */
  }
}

/** Requests the local adapter can send over the WebSocket connection. */
export type ExternalAgentRequest =
  | { type: 'ping' }
  | { type: 'tools.list' }
  | {
      type: 'tool'
      tool: string
      args?: Record<string, unknown>
      token?: string
      /**
       * 发出请求的 Agent 连接 id（由适配器附带）。仅当用户在设置里选中了一个
       * 连接、且该连接仍在当前已接入列表（`activeAgentIds`）中时，才用它拒绝
       * 其它连接发来的 tool/prompt 请求；选中连接过期（已断开）时不参与过滤。
       */
      agentId?: string
    }
  | {
      type: 'prompt'
      prompt: string
      token?: string
      /**
       * 发出请求的 Agent 连接 id（由适配器附带）。仅当用户在设置里选中了一个
       * 连接、且该连接仍在当前已接入列表（`activeAgentIds`）中时，才用它拒绝
       * 其它连接发来的 tool/prompt 请求；选中连接过期（已断开）时不参与过滤。
       */
      agentId?: string
    }

/** Replies the plugin returns to the local adapter. */
export type ExternalAgentResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string }

/**
 * Processes one request from the local adapter. Synchronous validation first,
 * then async tool execution; the caller (the WebSocket client) keeps the
 * response channel open and sends the result back tagged with the request's
 * `id`.
 *
 * @param message  The parsed request from the local adapter.
 * @param settings The settings used to open the current connection.
 * @param activeAgentIds
 *   Ids of the agent connections currently attached to the socket (from the
 *   latest `agents.update`). When undefined (the caller could not supply the
 *   list), the per-connection pin is not enforced — matching the stale-pin
 *   case, requests are never silently dropped.
 */
export async function processAgentRequest(
  message: unknown,
  settings: Settings,
  activeAgentIds?: string[],
): Promise<ExternalAgentResponse> {
  if (!message || typeof message !== 'object') {
    return { ok: false, error: 'Malformed message.' }
  }
  const req = message as ExternalAgentRequest

  if (!settings.localAgentEnabled) {
    return {
      ok: false,
      error: 'The local-agent bridge is disabled. Enable it in the plugin settings.',
    }
  }
  if (settings.localAgentToken) {
    const provided = 'token' in req ? (req as { token?: string }).token : undefined
    if (provided !== settings.localAgentToken) {
      return { ok: false, error: 'Invalid token.' }
    }
  }

  // Multiple agents may be connected at once; when the user has pinned the
  // plugin to serve exactly one connection, only that agent's tool/prompt
  // requests are executed (ping / tools.list stay open to every connection).
  // The pin is enforced only while the pinned id is still in the *current*
  // connected list (`activeAgentIds`): a stale pin (the selected connection
  // already dropped) must never silently swallow requests — it falls back to
  // serving every connection until the user re-picks.
  if (
    (req.type === 'tool' || req.type === 'prompt') &&
    settings.localAgentActiveAgent &&
    Array.isArray(activeAgentIds) &&
    activeAgentIds.includes(settings.localAgentActiveAgent) &&
    (req as { agentId?: string }).agentId !== settings.localAgentActiveAgent
  ) {
    return {
      ok: false,
      error:
        '本插件当前只服务所选连接：请在插件设置里选择本连接，或改为“全部连接”。' +
        'The plugin is serving only the selected connection: pick this agent in the plugin settings, or choose "all connections".',
    }
  }

  switch (req.type) {
    case 'ping':
      // Await (not fire-and-forget): the reply doubles as a "warmed up" signal,
      // and awaiting keeps the service worker alive through the work.
      await warmupAutomation()
      return { ok: true, data: { pong: true } }

    case 'tools.list':
      await warmupAutomation()
      return { ok: true, data: { tools: TOOLS } }

    case 'tool': {
      if (!req.tool || typeof req.tool !== 'string') {
        return { ok: false, error: 'A tool name is required.' }
      }
      const args =
        req.args && typeof req.args === 'object' && !Array.isArray(req.args)
          ? req.args
          : {}
      try {
        const result = await runToolStandalone(req.tool, args)
        return { ok: true, data: result }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    case 'prompt': {
      if (!req.prompt || typeof req.prompt !== 'string') {
        return { ok: false, error: 'A prompt is required.' }
      }
      // Full autonomy: the caller explicitly asked the agent to "go do this",
      // with no human to approve each step. History id is namespaced so these
      // turns never collide with side-panel conversations.
      const result = await runUnattendedPrompt(req.prompt, `external:${newId()}`, 'full')
      if (result.cancelled) return { ok: false, error: 'Cancelled.' }
      if (!result.ok) return { ok: false, error: result.error ?? result.answer }
      return { ok: true, data: { answer: result.answer } }
    }

    default:
      return {
        ok: false,
        error: `Unknown request type: ${String((req as { type?: unknown }).type)}`,
      }
  }
}
