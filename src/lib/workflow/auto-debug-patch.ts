/**
 * Shared workflow-debug types + the param-patch operation.
 *
 * The AI debug flow is a RUNTIME TAKEOVER (see `lib/workflow/ai-takeover` and
 * `background/workflow-engine/ai-takeover`): a failed node is handed to the AI
 * agent mid-run, the agent completes that step on the live page, and the graph
 * fixes it proposes are applied ONLY after the user confirms them. What
 * survives here is:
 *
 * - the debug-session result shape shared with the panel,
 * - `patchNodeParams`, the single graph op used when the user APPLIES the
 *   takeover's proposed fixes,
 * - `describeNodeParams`, the compact per-node param summary for run logs.
 *
 * Everything is pure: the input workflow is never mutated (the op works on a
 * `structuredClone`), so callers can apply, inspect and discard fixes safely.
 *
 * @module lib/workflow/auto-debug-patch
 */
import type { TakeoverFix, TakeoverReport } from './ai-takeover'
import type { Workflow, WorkflowNode } from './types'

/** One recorded engine step line, used for failure attribution and context. */
export interface DebugStepLine {
  kind: string
  nodeId?: string
  text: string
}

/** Final result of a debug session, sent to the panel. */
export interface WorkflowDebugResult {
  ok: boolean
  cancelled?: boolean
  /** Number of engine attempts behind the session (a takeover does not re-run). */
  attempts: number
  summary: string
  error?: string
  /** Run id of the attempt, so the panel can deep-link into History. */
  lastRunId?: string
  /**
   * True when the FINAL workflow version completed a takeover-free run: the
   * fixes (if any) were verified to work WITHOUT AI help. A session that only
   * succeeded via AI reports verified=false with the fixes left pending.
   */
  verified?: boolean
  /** How many apply-fix + verify rounds the session ran (1-based). */
  rounds?: number
  /** Takeover episodes of the session, in the order they happened. */
  takeovers: TakeoverReport[]
  /** Node fixes awaiting user confirmation (persisted until applied/discarded). */
  pendingChanges: TakeoverFix[]
  /**
   * The replay+audit path's outcome: a WHOLE-GRAPH rewrite that passed the
   * takeover-free verify run and waits for the user's confirmation
   * (takeoverApply replaces the graph). Present only when `ok`.
   */
  rewrite?: { diagnosis: string; changes: string[] }
  /** Per-node audit verdicts (shown in the panel even when the rewrite failed). */
  audit?: { nodeId: string; nodeLabel: string; verdict: string; note: string }[]
  /**
   * Result of the goal-completion judge (目标达成判定): undefined when the
   * judge was unavailable (no provider) and the no-error standard applied.
   * A run WITHOUT errors but WITHOUT goal achievement is a failed debug.
   */
  goalAchieved?: boolean
  /** The judge's one-line Chinese reasoning (basis of achievement / the gap). */
  goalNote?: string
}

/** Raised by the AI layer when no model provider / API key is configured. */
export class NoProviderError extends Error {}

// --- Small helpers -----------------------------------------------------------

/** Human-readable node name for change notes: label + description when set. */
function describeNode(node: WorkflowNode): string {
  const desc = typeof node.data?.['description'] === 'string' ? node.data['description'] : ''
  return desc ? `${node.label}（${desc}）` : node.label
}

/** Truncates a value for inline change notes. */
function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

// --- Patch operation ---------------------------------------------------------

/**
 * Merges corrected params flat onto one node's `data` (the canonical shape).
 * `blockId` / `disableBlock` are protected: the AI must not re-type a node or
 * silently disable it.
 */
export function patchNodeParams(
  workflow: Workflow,
  nodeId: string,
  patch: Record<string, unknown>,
): { workflow: Workflow; changed: boolean; changes: string[] } {
  const node = workflow.drawflow.nodes.find((n) => n.id === nodeId)
  if (!node) return { workflow, changed: false, changes: [`未找到节点 ${nodeId}，未修改参数`] }
  const entries = Object.entries(patch).filter(
    ([key]) => key !== 'blockId' && key !== 'disableBlock',
  )
  if (entries.length === 0) return { workflow, changed: false, changes: ['参数修改内容为空'] }
  const wf = structuredClone(workflow)
  const target = wf.drawflow.nodes.find((n) => n.id === nodeId)!
  const keys: string[] = []
  for (const [key, value] of entries) {
    target.data[key] = value
    keys.push(`${key}: ${preview(node.data[key])} → ${preview(value)}`)
  }
  return {
    workflow: wf,
    changed: true,
    changes: [`修正「${describeNode(node)}」参数：${keys.join('；')}`],
  }
}

// --- Run-log summaries -------------------------------------------------------

/** Params that never belong in a compact log line. */
const PARAM_NOISE_KEYS = new Set(['description', 'blockId', 'disableBlock'])

/** Cap per param value in the compact log line. */
const PARAM_VALUE_CAP = 50

/**
 * Compact "key=value" summary of a node's params for live run logs, so the
 * user can see WHICH node runs with WHAT configuration. Noise keys are
 * skipped, long values truncated, the retry policy collapsed to one token.
 */
export function describeNodeParams(node: WorkflowNode): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(node.data ?? {})) {
    if (PARAM_NOISE_KEYS.has(key)) continue
    if (value === undefined || value === null || value === '' || value === false) continue
    if (key === 'onError') {
      const policy = value as Record<string, unknown>
      if (policy['retry'] === true) {
        const interval = policy['retryInterval']
        parts.push(`onError=重试×${String(policy['retryTimes'] ?? '?')}${interval ? `/${String(interval)}s` : ''}`)
      }
      continue
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
    parts.push(`${key}=${text.length > PARAM_VALUE_CAP ? `${text.slice(0, PARAM_VALUE_CAP)}…` : text}`)
  }
  return parts.join(', ')
}
