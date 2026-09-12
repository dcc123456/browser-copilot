/**
 * M4 · Failure memory (plan item 12/22) — structured self-healing context.
 *
 * The takeover loop retries a failed node, but each attempt starts a FRESH
 * conversation, so it re-discovers the same dead end. This module persists a
 * compact structured record of every failure (type / root cause / suggested
 * action / confidence) keyed by the failure signature, and renders it into a
 * hint that the next retry is primed with — so attempt 2 starts where attempt
 * 1 gave up.
 *
 * Storage is an injected interface (same pattern as checkpoints): in-memory by
 * default, durable backends supplied by the extension/server.
 *
 * @module lib/workflow/failure-memory
 */
import { failureSignature } from './ai-takeover'

/** One structured failure, keyed by its signature for lookup. */
export interface FailureMemoryEntry {
  workflowId?: string
  nodeId?: string
  /** Stable `nodeId::normalized-error` key (see `failureSignature`). */
  signature: string
  errorType?: string
  rootCause?: string
  suggestedAction?: string
  /** 0–1; how sure we are about `suggestedAction`. */
  confidence?: number
  /** How many times this signature has been seen. */
  occurrences: number
  at: number
}

export interface FailureMemoryStore {
  record(entry: FailureMemoryEntry): void
  query(filter: {
    workflowId?: string
    nodeId?: string
    signature?: string
    limit?: number
  }): FailureMemoryEntry[]
}

const DEFAULT_LIMIT = 100

/** In-memory failure memory (default). */
export function createMemoryFailureStore(limit = DEFAULT_LIMIT): FailureMemoryStore {
  const entries: FailureMemoryEntry[] = []
  return {
    record(entry) {
      const existing = entries.findIndex((e) => e.signature === entry.signature)
      if (existing >= 0) {
        const prev = entries[existing]!
        entries[existing] = {
          ...prev,
          ...entry,
          occurrences: prev.occurrences + 1,
          at: entry.at,
        }
        return
      }
      entries.push(entry)
      if (entries.length > limit) entries.splice(0, entries.length - limit)
    },
    query({ workflowId, nodeId, signature, limit = 5 }) {
      return entries
        .filter((e) => (workflowId ? e.workflowId === workflowId : true))
        .filter((e) => (nodeId ? e.nodeId === nodeId : true))
        .filter((e) => (signature ? e.signature === signature : true))
        .slice(-limit)
        .map((e) => ({ ...e }))
    },
  }
}

/** Inputs for {@link rememberFailure}. */
export interface RememberFailureInput {
  workflowId?: string
  nodeId: string
  error: string
  errorType?: string
  rootCause?: string
  suggestedAction?: string
  confidence?: number
  at?: number
}

/**
 * Records a failure, deriving the stable signature from the node + error so
 * the same dead end is recognised next time.
 */
export function rememberFailure(
  store: FailureMemoryStore,
  input: RememberFailureInput,
): FailureMemoryEntry {
  const entry: FailureMemoryEntry = {
    nodeId: input.nodeId,
    signature: failureSignature(input.nodeId, input.error),
    occurrences: 1,
    at: input.at ?? Date.now(),
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(input.errorType ? { errorType: input.errorType } : {}),
    ...(input.rootCause ? { rootCause: input.rootCause } : {}),
    ...(input.suggestedAction ? { suggestedAction: input.suggestedAction } : {}),
    ...(typeof input.confidence === 'number' ? { confidence: input.confidence } : {}),
  }
  store.record(entry)
  return entry
}

/**
 * Renders prior failures into a prompt-ready hint for the next retry.
 * Returns undefined when there is nothing worth injecting, so callers can
 * spread it into prompt parts without changing behaviour by default.
 */
export function buildFailureMemoryHint(entries: FailureMemoryEntry[]): string | undefined {
  if (entries.length === 0) return undefined
  const lines = entries.slice(-3).map((e) => {
    const parts: string[] = []
    if (e.rootCause) parts.push(`根因：${e.rootCause}`)
    else if (e.errorType) parts.push(`错误类型：${e.errorType}`)
    if (e.suggestedAction) parts.push(`建议：${e.suggestedAction}`)
    if (typeof e.confidence === 'number') parts.push(`置信度：${e.confidence}`)
    const body = parts.length > 0 ? parts.join('；') : '（无结构化信息）'
    return `- 已失败 ${e.occurrences} 次 → ${body}`
  })
  return `该节点此前的失败记忆（勿重复已证明无效的尝试）：\n${lines.join('\n')}`
}
