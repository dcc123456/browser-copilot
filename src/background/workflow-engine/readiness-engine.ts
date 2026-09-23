/**
 * The readiness engine — "the page is ready for this step" as a runtime.
 *
 * The readiness CONTRACT lives in `lib/workflow/readiness` (states, the
 * per-block default table, normalization). This module is its RUNTIME half:
 * before a node executes on a generated-strict run it polls the `before`
 * requirements until they hold or the window expires, and after the executor
 * succeeded it verifies the `after` ones. Every poll RE-CHECKS through the
 * injected probe — a readiness wait is a sequence of fresh observations, not
 * a sleep (spec §7.1: 不允许用固定 sleep 掩盖 runtime 问题).
 *
 * The engine stays chrome-free: the probe is injected per run (the
 * integration layer builds one over the driver; tests inject deterministic
 * stubs). When a runner provides no probe, readiness is skipped for that run
 * — the engine never fails merely because a probe was not wired.
 *
 * @module background/workflow-engine/readiness-engine
 */
import type { ReadinessRequirement, ReadinessSpec, ReadinessState } from '../../lib/workflow/readiness'
import {
  DEFAULT_READINESS_POLL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  defaultReadinessFor,
} from '../../lib/workflow/readiness'
import type { NodeReliabilitySpec } from '../../lib/workflow/reliability'
import { nodeReliabilityOf } from '../../lib/workflow/reliability'
import type { WorkflowNode } from '../../lib/workflow/types'

/** The result of one probe observation. */
export interface ReadinessCheckResult {
  satisfied: boolean
  /** Why it was not satisfied yet — surfaced in the timeout failure. */
  detail?: string
}

/**
 * One readiness observation. Implementations must be FRESH every call (re-
 * resolve the element, re-read the state) — a cached first answer is exactly
 * the stale-observation bug this engine exists to prevent.
 */
export type ReadinessProbe = (
  requirement: ReadinessRequirement,
  nodeSelector: string,
  signal: AbortSignal,
) => Promise<ReadinessCheckResult>

/** The outcome of a readiness wait. */
export interface ReadinessOutcome {
  ok: boolean
  /** How long the wait took (0 when the first check already held). */
  waitedMs: number
  /** Set when `ok: false`. */
  code?: 'READINESS_TIMEOUT'
  /** The state that never became ready. */
  state?: ReadinessState
  /** The last probe detail, for the failure evidence. */
  detail?: string
}

export interface ReadinessWaitOptions {
  requirements: readonly ReadinessRequirement[]
  /** The node's own element selector (requirements may default to it). */
  nodeSelector: string
  signal: AbortSignal
  probe: ReadinessProbe
  /** Window for the whole wait (ms); per-requirement overrides win. */
  timeoutMs?: number
  pollIntervalMs?: number
  /** Injectable sleep (tests); defaults to a real abort-aware sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Poll the requirements until ALL hold or the window expires. Hit-and-return:
 * the first fully-satisfied observation ends the wait. Each poll re-invokes
 * the probe.
 */
export async function awaitReadiness(options: ReadinessWaitOptions): Promise<ReadinessOutcome> {
  const {
    requirements,
    nodeSelector,
    signal,
    probe,
    pollIntervalMs = DEFAULT_READINESS_POLL_MS,
    sleep = defaultSleep,
  } = options
  if (requirements.length === 0) return { ok: true, waitedMs: 0 }
  const startedAt = Date.now()
  const deadlineFor = (requirement: ReadinessRequirement): number => {
    const per = typeof requirement.timeoutMs === 'number' && requirement.timeoutMs > 0
      ? requirement.timeoutMs
      : options.timeoutMs && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_READINESS_TIMEOUT_MS
    return startedAt + per
  }
  const pending = new Map(requirements.map((r) => [r, deadlineFor(r)]))
  let lastDetail: string | undefined
  for (;;) {
    let unsatisfied: ReadinessRequirement | undefined
    for (const [requirement, deadline] of pending) {
      let check: ReadinessCheckResult
      try {
        check = await probe(requirement, nodeSelector, signal)
      } catch (e) {
        check = { satisfied: false, detail: e instanceof Error ? e.message : String(e) }
      }
      if (check.satisfied) {
        pending.delete(requirement)
        continue
      }
      lastDetail = check.detail
      if (Date.now() >= deadline) {
        unsatisfied = requirement
        break
      }
    }
    if (pending.size === 0) return { ok: true, waitedMs: Date.now() - startedAt }
    if (unsatisfied) {
      return {
        ok: false,
        waitedMs: Date.now() - startedAt,
        code: 'READINESS_TIMEOUT',
        state: unsatisfied.state,
        ...(lastDetail ? { detail: lastDetail } : {}),
      }
    }
    await sleep(Math.min(pollIntervalMs, 1000), signal)
  }
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The effective readiness spec of a node: the explicit `__reliability.readiness`
 * contract when present, otherwise the block's default (§7.3), otherwise none.
 */
export function effectiveReadinessSpec(
  node: WorkflowNode,
  blockId: string,
  params: Record<string, unknown>,
): ReadinessSpec | undefined {
  const spec: NodeReliabilitySpec | undefined = nodeReliabilityOf(node)
  if (spec?.readiness) return spec.readiness
  return defaultReadinessFor(blockId, params)
}

/**
 * Pre-action wait: poll the spec's `before` requirements (empty → no wait).
 */
export async function prepareNodeExecution(args: {
  node: WorkflowNode
  blockId: string
  params: Record<string, unknown>
  nodeSelector: string
  signal: AbortSignal
  probe?: ReadinessProbe
}): Promise<ReadinessOutcome> {
  const spec = effectiveReadinessSpec(args.node, args.blockId, args.params)
  const requirements = spec?.before ?? []
  if (requirements.length === 0 || !args.probe) return { ok: true, waitedMs: 0 }
  return awaitReadiness({
    requirements,
    nodeSelector: args.nodeSelector,
    signal: args.signal,
    probe: args.probe,
    ...(spec?.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec?.pollIntervalMs !== undefined ? { pollIntervalMs: spec.pollIntervalMs } : {}),
  })
}

/**
 * Post-action verification: poll the spec's `after` requirements (value
 * committed, navigation settled…). Same freshness and hit-and-return rules.
 */
export async function verifyPostActionReadiness(args: {
  node: WorkflowNode
  blockId: string
  params: Record<string, unknown>
  nodeSelector: string
  signal: AbortSignal
  probe?: ReadinessProbe
}): Promise<ReadinessOutcome> {
  const spec = effectiveReadinessSpec(args.node, args.blockId, args.params)
  const requirements = spec?.after ?? []
  if (requirements.length === 0 || !args.probe) return { ok: true, waitedMs: 0 }
  return awaitReadiness({
    requirements,
    nodeSelector: args.nodeSelector,
    signal: args.signal,
    probe: args.probe,
    ...(spec?.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec?.pollIntervalMs !== undefined ? { pollIntervalMs: spec.pollIntervalMs } : {}),
  })
}
