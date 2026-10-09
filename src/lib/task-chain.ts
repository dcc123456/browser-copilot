/**
 * Cross-task handoff: what a chained scheduled task can read from the task it
 * follows.
 *
 * A chain is one task pointing at another (`followsTaskId`) and referencing what
 * that run produced through `{{upstream.<key>}}`. Resolution happens at the
 * CHILD's run time, not when it is written — which is the whole point: a comment
 * task is created before the note it will comment on exists, so the value cannot
 * be baked in.
 *
 * Chrome-free by design (AGENTS §5.7). The caps that make a handoff bag safe to
 * persist live here too, so the producer, the store and the reader cannot
 * disagree about what "small" means.
 *
 * @module lib/task-chain
 */

import { capPersistedStrings, jsonBytes, shedBulkDataUrls } from './persist-budget'
import type { TaskRunLog } from './scheduler-types'
import { isSensitiveName, summarizeValue } from './workflow/repair/redaction'
import { interpolate, leftoverTokens } from './workflow/interpolate'

/** Reference root a chained task reads its parent's output through. */
export const UPSTREAM_ROOT = 'upstream'

/**
 * Names the interpolation layer already owns, so a task's own `variables` must
 * not shadow them: `{{refData}}` means "the upstream block" inside a running
 * graph, and `{{upstream}}` is this module's.
 */
export const RESERVED_VARIABLE_NAMES: readonly string[] = [UPSTREAM_ROOT, 'refData']

/** A handoff key has to survive `{{name}}`, so it must be a plain identifier. */
export const OUTPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** How many named values one run hands on: a chain passes ids and URLs, not datasets. */
export const MAX_OUTPUT_KEYS = 8

/** Longest single handed-off string. Anything longer was bulk content. */
export const MAX_OUTPUT_STRING = 512

/** JSON budget for one run's handoff bag, enforced by dropping whole keys. */
export const MAX_RUN_OUTPUTS_BYTES = 4096

/**
 * The parent's handed-off values plus its summary.
 *
 * `summary` is always present so a chain can at least pass prose ("what the run
 * concluded"), which is all an `agent-prompt` parent can offer. It is truncated
 * here rather than trusted: an agent task's summary is its entire model answer,
 * and interpolating that into the next task's prompt would ship a whole article
 * through a channel built for URLs.
 */
export function buildUpstream(parentRun: TaskRunLog | undefined): Record<string, unknown> {
  if (!parentRun) return {}
  const capped = capPersistedStrings(parentRun.summary ?? '', MAX_OUTPUT_STRING)
  return { ...(parentRun.outputs ?? {}), summary: capped }
}

/**
 * Reduce a run's final variable bag to what it declares it hands on.
 *
 * Three guards, in this order: only the declared names (when the task declared
 * any — an undeclared run hands over its whole small bag), never a credential
 * (`isSensitiveName`, so the handoff is not a secret channel), and never more
 * than the byte budget (keys past it are dropped, oldest-declared last first).
 * Oversize strings keep a marker instead of vanishing, per `capPersistedStrings`.
 */
export function clampHandoffBag(
  variables: Record<string, unknown> | undefined,
  declared?: readonly string[],
): Record<string, unknown> | undefined {
  if (!variables) return undefined
  const names = declared?.length ? declared : Object.keys(variables)
  const out: Record<string, unknown> = {}
  let bytes = 2
  for (const name of names) {
    if (Object.keys(out).length >= MAX_OUTPUT_KEYS) break
    if (isSensitiveName(name)) continue
    const value = variables[name]
    if (value === undefined) continue
    const trimmed = capPersistedStrings(shedBulkDataUrls(value), MAX_OUTPUT_STRING)
    const cost = jsonBytes({ [name]: trimmed })
    if (bytes + cost > MAX_RUN_OUTPUTS_BYTES) continue
    out[name] = trimmed
    bytes += cost
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** What the bag is missing, in the shape a run log or error message can show. */
export interface UnresolvedUpstream {
  /** The `{{upstream.…}}` tokens nothing answered. */
  tokens: string[]
  /** Names the parent did produce — the hint that makes the fix obvious. */
  availableKeys: string[]
}

/**
 * Replace every `{{upstream.*}}` in a task's stored inputs with the parent's value.
 *
 * Only `upstream`-rooted tokens are judged. Any other `{{…}}` is left verbatim,
 * exactly as the engine leaves it: prompt text routinely contains literal braces
 * (JSON examples, template snippets), and failing on those would break tasks
 * that work today.
 */
export function resolveTaskInputs(
  task: { prompt?: string; variables?: Record<string, unknown> },
  upstream: Record<string, unknown>,
): { variables?: Record<string, unknown>; prompt?: string; unresolved: UnresolvedUpstream } {
  const bag = { [UPSTREAM_ROOT]: upstream }
  const tokens: string[] = []
  const note = (text: string): string => {
    for (const token of leftoverTokens(text)) {
      if (token.split('.')[0] === UPSTREAM_ROOT) tokens.push(token)
    }
    return text
  }

  const variables = task.variables
    ? Object.fromEntries(
        Object.entries(task.variables).map(([key, value]) => [
          key,
          typeof value === 'string'
            ? note(interpolate(value, bag))
            : Array.isArray(value)
              ? value.map((item) =>
                  typeof item === 'string' ? note(interpolate(item, bag)) : item,
                )
              : value,
        ]),
      )
    : undefined
  const prompt = task.prompt === undefined ? undefined : note(interpolate(task.prompt, bag))

  return {
    ...(variables ? { variables } : {}),
    ...(prompt === undefined ? {} : { prompt }),
    unresolved: { tokens: [...new Set(tokens)], availableKeys: Object.keys(upstream) },
  }
}

/**
 * The message for a chain that did not land.
 *
 * Names the token, not the value, and lists the keys the parent DID produce —
 * enough to fix the graph or the declaration without opening a second tool.
 * Values never appear here, consistent with the redaction culture in
 * `workflow/repair/redaction`.
 */
export function describeUnresolved(
  unresolved: UnresolvedUpstream,
  parentName: string,
  parentRun?: TaskRunLog,
): string {
  const lines = [
    `This task reads ${unresolved.tokens.map((token) => `{{${token}}}`).join(', ')} from the task it follows, but that task has not produced them.`,
    `Upstream: 「${parentName}」`,
  ]
  if (unresolved.availableKeys.length > 0) {
    const summaries = unresolved.availableKeys.slice(0, MAX_OUTPUT_KEYS).map((key) => {
      const value = summarizeValue(parentRun?.outputs?.[key], key)
      return `· ${key} (${value.type}${value.isEmpty ? ', empty' : ''})`
    })
    lines.push(`It did produce:`, ...summaries)
  } else {
    lines.push('Its last run recorded no handoff keys at all.')
  }
  return lines.join('\n')
}
