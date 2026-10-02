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
import { interpolate } from '../../lib/workflow/interpolate'
import type { WorkflowNode } from '../../lib/workflow/types'
import type { Target } from '../../lib/ops'

/** The result of one probe observation. */
export interface ReadinessCheckResult {
  satisfied: boolean
  /** Why it was not satisfied yet — surfaced in the timeout failure. */
  detail?: string
  /**
   * Polling will never help: the requirement is unsatisfiable IN PRINCIPLE for
   * this element (a click waiting for a file input to become visible). End the
   * wait now with this detail instead of spending the window on it. The failure
   * keeps the `READINESS_TIMEOUT` code — one less axis for the repair budgets and
   * the dashboards to classify — and the detail carries the truth.
   */
  hopeless?: boolean
}

/**
 * One readiness observation. Implementations must be FRESH every call (re-
 * resolve the element, re-read the state) — a cached first answer is exactly
 * the stale-observation bug this engine exists to prevent.
 *
 * `nodeTarget` is the locator chain the node's own executor will use
 * (`executors.targetFrom`). A probe that observes anything narrower is
 * observing a different element than the action will act on — or, for a node
 * located by text/role with an empty `selector`, nothing at all.
 */
export type ReadinessProbe = (
  requirement: ReadinessRequirement,
  nodeSelector: string,
  signal: AbortSignal,
  nodeTarget?: Target,
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
  /** The node's full locator chain, for nodes a flat selector cannot express. */
  nodeTarget?: Target
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
        check = await probe(requirement, nodeSelector, signal, options.nodeTarget)
      } catch (e) {
        check = { satisfied: false, detail: e instanceof Error ? e.message : String(e) }
      }
      if (check.satisfied) {
        pending.delete(requirement)
        continue
      }
      lastDetail = check.detail
      if (check.hopeless) {
        unsatisfied = requirement
        break
      }
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
 * Resolve the `{{tokens}}` a stored requirement still holds.
 *
 * An explicit `__reliability.readiness` contract is written at GENERATION time,
 * when the value it expects was still a `{{variable}}` template — and only the
 * template was carried into the graph. The step's own `value` param, by
 * contrast, goes through `interpolateParams` before the executor sees it. So
 * without this pass the after-gate compares the live control against the literal
 * braces: the fill worked, the AI title is on the page, and the step times out
 * on `expected "{{noteTitle}}"`. The default table has no such problem — it
 * builds its expectation out of the already-interpolated params.
 *
 * A token that the run's variables cannot resolve stays as written, exactly as
 * `interpolate` behaves everywhere else: the gate then fails on a graph with a
 * hole in it, which is the honest answer.
 */
function resolveRequirements(
  requirements: readonly ReadinessRequirement[],
  vars: Record<string, unknown> | undefined,
): readonly ReadinessRequirement[] {
  if (!vars) return requirements
  return requirements.map((requirement) =>
    typeof requirement.value === 'string' && requirement.value.includes('{{')
      ? { ...requirement, value: interpolate(requirement.value, vars) }
      : requirement,
  )
}

/**
 * Pre-action wait: poll the spec's `before` requirements (empty → no wait).
 */
export async function prepareNodeExecution(args: {
  node: WorkflowNode
  blockId: string
  params: Record<string, unknown>
  nodeSelector: string
  nodeTarget?: Target
  signal: AbortSignal
  probe?: ReadinessProbe
  /** The run's variable bag, for a stored expectation still written as a token. */
  vars?: Record<string, unknown>
}): Promise<ReadinessOutcome> {
  const spec = effectiveReadinessSpec(args.node, args.blockId, args.params)
  const requirements = resolveRequirements(spec?.before ?? [], args.vars)
  if (requirements.length === 0 || !args.probe) return { ok: true, waitedMs: 0 }
  return awaitReadiness({
    requirements,
    nodeSelector: args.nodeSelector,
    ...(args.nodeTarget ? { nodeTarget: args.nodeTarget } : {}),
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
  nodeTarget?: Target
  signal: AbortSignal
  probe?: ReadinessProbe
  /** The run's variable bag, for a stored expectation still written as a token. */
  vars?: Record<string, unknown>
}): Promise<ReadinessOutcome> {
  const spec = effectiveReadinessSpec(args.node, args.blockId, args.params)
  const requirements = resolveRequirements(spec?.after ?? [], args.vars)
  if (requirements.length === 0 || !args.probe) return { ok: true, waitedMs: 0 }
  return awaitReadiness({
    requirements,
    nodeSelector: args.nodeSelector,
    ...(args.nodeTarget ? { nodeTarget: args.nodeTarget } : {}),
    signal: args.signal,
    probe: args.probe,
    ...(spec?.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec?.pollIntervalMs !== undefined ? { pollIntervalMs: spec.pollIntervalMs } : {}),
  })
}
