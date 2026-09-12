/**
 * Structured tool-failure context (结构化错误上下文).
 *
 * A bare error string makes a model guess why a call failed and often repeat
 * the same call. Classifying the failure and attaching concrete recovery steps
 * (plus the recent failed attempts) measurably shortens retry loops.
 *
 * This module is pure and chrome-free so both the extension agent loop and the
 * server agent loop can share it.
 *
 * @module lib/tool-error
 */

/** Coarse failure classes a tool error can fall into. */
export type ToolErrorType =
  | 'ELEMENT_NOT_FOUND'
  | 'STALE_REF'
  | 'TIMEOUT'
  | 'NAVIGATION_FAILED'
  | 'PERMISSION'
  | 'NETWORK'
  | 'UNKNOWN'

/** Concrete next steps per failure class (short, imperative, actionable). */
const RECOVERY: Record<ToolErrorType, string[]> = {
  STALE_REF: [
    'Refs are invalidated by navigation or a new snapshot — call snapshot_page again and use the fresh refs; do not reuse old ones.',
  ],
  ELEMENT_NOT_FOUND: [
    'Take a fresh snapshot_page and act on a ref that exists right now.',
    'If the target is below the fold, scroll it into view first.',
    'If the page is still rendering, wait_for the element and retry once.',
  ],
  TIMEOUT: [
    'The page may still be loading — wait_for the element, then retry once.',
    'If it never appears, the selector is wrong: locate the real target in a fresh snapshot.',
  ],
  NAVIGATION_FAILED: [
    'Confirm the URL is reachable and allowed (ordinary http/https pages only).',
    'Take a fresh snapshot to see where the page actually is now.',
  ],
  PERMISSION: [
    'This is a mode/permission block, not a page problem — explain what you need instead of retrying.',
  ],
  NETWORK: ['Transient network or endpoint failure — pause briefly and retry once.'],
  UNKNOWN: [
    'Read the error, take a fresh snapshot, and change your approach — never repeat the identical call.',
  ],
}

/**
 * Classifies a tool error message into a {@link ToolErrorType}. Keyword-based
 * (Chinese + English) and deliberately ordered: a stale-ref hint wins over a
 * generic "not found", since their fixes differ.
 */
export function classifyToolError(message: string): ToolErrorType {
  const text = message.toLowerCase()
  if (/unknown ref|ref .*(stale|invalid|expired)|失效|已过期/.test(text)) return 'STALE_REF'
  if (/timeout|timed out|超时/.test(text)) return 'TIMEOUT'
  if (
    /not found|no element|no matching|element .*missing|未找到|找不到|不存在|没有匹配/.test(text)
  ) {
    return 'ELEMENT_NOT_FOUND'
  }
  if (
    /navigat|net::err|off limits|not allowed|only ordinary|chrome:\/\/|无法访问|不允许/.test(text)
  ) {
    return 'NAVIGATION_FAILED'
  }
  if (/disabled|declined|read-only|readonly|chat mode|not approved|拒绝|禁用/.test(text)) {
    return 'PERMISSION'
  }
  if (/network|failed to fetch|econn|enotfound|断网|网络/.test(text)) return 'NETWORK'
  return 'UNKNOWN'
}

/** The structured context attached to a failed tool result. */
export interface ToolErrorContext {
  errorMessage: string
  errorType: ToolErrorType
  suggestedRecovery: string[]
}

/** Builds the structured context for a raw tool error message. */
export function buildToolErrorContext(message: string): ToolErrorContext {
  const errorType = classifyToolError(message)
  return {
    errorMessage: message,
    errorType,
    suggestedRecovery: RECOVERY[errorType],
  }
}

/** One recorded prior attempt at the same tool (fed back to the model). */
export interface PriorAttempt {
  action: string
  result: string
}

/**
 * Extracts up to `limit` recent FAILED results for `name` from the transcript's
 * tool messages, oldest first. Each tool result is a JSON string; entries that
 * parse without an `error` field are successes and are skipped.
 */
export function recentFailedAttempts(
  history: readonly { role: string; name?: string; content?: unknown }[],
  name: string,
  limit = 3,
): PriorAttempt[] {
  const out: PriorAttempt[] = []
  for (const message of history) {
    if (message.role !== 'tool') continue
    if (message.name !== name) continue
    if (typeof message.content !== 'string') continue
    let parsed: { error?: unknown } | undefined
    try {
      parsed = JSON.parse(message.content) as { error?: unknown }
    } catch {
      continue
    }
    if (!parsed || typeof parsed.error !== 'string') continue
    out.push({ action: name, result: parsed.error.slice(0, 200) })
  }
  return out.slice(-limit)
}
