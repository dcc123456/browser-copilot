/**
 * Repair reflection — the shared "why did that round fail, change approach" layer.
 *
 * Every repair loop in this repo runs more than one round, and until now each
 * one threw away what it had just learned: the ladder advanced to the next
 * strategy without telling the model what the previous candidate did, the patch
 * loop serialized an always-empty `repairHistory`, and only the AI takeover
 * kept any cross-round memory — in a shape nothing else could reuse. This module
 * is the single vocabulary all three now speak.
 *
 * A reflection is deliberately NOT a patch. It never proposes edits; it states
 * why the last round failed, what the page actually showed, and what must
 * change in the next attempt. The proposing, validating and applying of patches
 * stay exactly where they were — a reflection that mangled its JSON degrades to
 * `null` and the caller behaves as if reflection never happened, so this layer
 * can never become a new way for a repair to fail.
 *
 * Pure module: no `chrome`, no DOM.
 *
 * @module lib/workflow/repair-reflection
 */

/** The conclusion drawn from one failed repair round. */
export interface RepairReflection {
  /** Why the round failed, in the model's own words. */
  rootCause: string
  /** What the live page actually showed (the grounded part). */
  evidence: string
  /** What the next attempt must do differently. */
  nextApproach: string
  /**
   * The strategy the next round should use. A PROPOSAL only — the caller's
   * policy gate still decides whether it is legal and affordable.
   */
  suggestedStrategy?: string
  /** 0–1. A low-confidence strategy suggestion is ignored, never applied. */
  confidence: number
}

/**
 * Below this, a reflection's `suggestedStrategy` is treated as absent. A model
 * that is not sure should not get to reroute the ladder.
 */
export const REFLECTION_MIN_STRATEGY_CONFIDENCE = 0.5

/** How many past reflections are rendered into the next prompt. */
const HISTORY_LIMIT = 5

/** Cap per reflection field so one verbose model cannot blow the context. */
const FIELD_CAP = 400

// --- Prompt -------------------------------------------------------------------

/** Plain-data payload for {@link buildReflectionMessages} (no graph types). */
export interface ReflectionPromptParts {
  workflowName?: string
  /** The step that keeps failing. */
  failedNode: {
    nodeId: string
    blockId: string
    intent?: string
    /** The selector the failed step uses, when it has one. */
    locator?: unknown
  }
  /** The original failure that started the repair. */
  originalFailure: string
  /** What the last round actually changed. */
  attemptedStrategy: string
  /** The last round's own justification, as it claimed it. */
  attemptedReason?: string
  /** Why the replay did not verify. */
  outcome: string
  /**
   * Live inspection of the page as it stands AFTER the failed round — the
   * failure scene itself, which is why it is worth more here than before the
   * candidate was ever applied.
   */
  pageInspection?: unknown
  /** Reflections from earlier rounds, oldest first. */
  history?: RepairReflection[]
  /** Strategies the caller has already tried and abandoned. */
  exhaustedStrategies?: string[]
}

/**
 * Builds the reflection prompt. English scaffolding (models follow it
 * reliably) — the rendered output is diagnostic, not user-facing copy.
 */
export function buildReflectionMessages(parts: ReflectionPromptParts): {
  role: 'system' | 'user'
  content: string
}[] {
  const system = [
    'You are the reflection step of a browser-automation workflow repair loop.',
    'A repair round already ran, changed the workflow, replayed it, and STILL failed.',
    'Your only job is to work out WHY that round did not fix it, using the live page evidence — not to propose new patches.',
    '',
    'Rules:',
    '- Ground the root cause in the page evidence you are given. If the evidence contradicts the recorded selector or assumption, say so explicitly.',
    '- If the recorded selector still matches but the step still failed, the cause is NOT the selector — say what else it could be (page state, timing, an upstream value, the wrong target entirely).',
    '- nextApproach must name something CONCRETE to change, not "try harder" or "check the page".',
    '- suggestedStrategy is optional. Name one only when you are confident the current strategy is fundamentally wrong for this failure.',
    '',
    'Respond with ONLY a JSON object, no prose and no markdown fence:',
    '{"rootCause":"why the last round failed","evidence":"the page fact that proves it","nextApproach":"what the next round must change","suggestedStrategy":"one of the known strategies, or omit","confidence":0.8}',
  ].join('\n')

  const user = JSON.stringify(
    {
      workflowName: parts.workflowName,
      failedNode: parts.failedNode,
      originalFailure: parts.originalFailure,
      lastRound: {
        strategy: parts.attemptedStrategy,
        ...(parts.attemptedReason ? { claimedFix: parts.attemptedReason } : {}),
        outcome: parts.outcome,
      },
      ...(parts.pageInspection ? { pageEvidenceAfterFailure: parts.pageInspection } : {}),
      ...(parts.history && parts.history.length > 0
        ? { earlierReflections: renderReflectionHistory(parts.history) }
        : {}),
      ...(parts.exhaustedStrategies && parts.exhaustedStrategies.length > 0
        ? { alreadyTriedAndAbandoned: parts.exhaustedStrategies }
        : {}),
    },
    null,
    2,
  )

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

// --- Parsing ------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Trims and caps one reflection field; empty becomes undefined. */
function fieldOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > FIELD_CAP ? `${text.slice(0, FIELD_CAP)}…` : text
}

/** Extracts the first balanced JSON object from a text blob. */
function extractJson(text: string): unknown {
  const start = text.search(/[{]/)
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (char === '\\') escaped = !escaped
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * Parses an untrusted reflection reply. Returns `null` on any parse or shape
 * failure — a reflection is an enhancement, so the caller's no-reflection path
 * must stay reachable no matter how mangled the reply was. `rootCause` and
 * `nextApproach` are required; `evidence` and `suggestedStrategy` are not.
 */
export function parseRepairReflection(raw: unknown): RepairReflection | null {
  const value = typeof raw === 'string' ? extractJson(raw) : raw
  if (!isRecord(value)) return null

  const rootCause = fieldOf(value['rootCause'])
  const nextApproach = fieldOf(value['nextApproach'])
  if (!rootCause || !nextApproach) return null

  const confidence =
    typeof value['confidence'] === 'number' && Number.isFinite(value['confidence'])
      ? Math.min(1, Math.max(0, value['confidence']))
      : 0.5
  const suggested = fieldOf(value['suggestedStrategy'])
  return {
    rootCause,
    evidence: fieldOf(value['evidence']) ?? '(no page evidence reported)',
    nextApproach,
    ...(suggested && confidence >= REFLECTION_MIN_STRATEGY_CONFIDENCE && isStrategyName(suggested)
      ? { suggestedStrategy: suggested }
      : {}),
    confidence,
  }
}

/**
 * The strategy names a reflection may name. Kept as a loose check rather than
 * an import of `REPAIR_STRATEGIES`: the patch loop and the takeover do not share
 * the ladder's enum, and importing it would make this module depend on the
 * ladder's vocabulary. The caller still validates against what IT knows.
 */
const STRATEGY_PATTERN = /^[a-z][a-z0-9-]{2,47}$/

function isStrategyName(value: string): boolean {
  return STRATEGY_PATTERN.test(value)
}

// --- Rendering ----------------------------------------------------------------

/**
 * Renders past reflections into one prompt block. Newest last, capped — the
 * point is to stop a fresh attempt from re-walking a proven dead end, which
 * only needs the recent ones.
 */
export function renderReflectionHistory(reflections: readonly RepairReflection[]): string {
  const recent = reflections.slice(-HISTORY_LIMIT)
  return recent
    .map(
      (reflection, index) =>
        `- round ${index + 1}: ${reflection.rootCause}` +
        ` | evidence: ${reflection.evidence}` +
        ` | do instead: ${reflection.nextApproach}`,
    )
    .join('\n')
}

/**
 * The strategy suggestion a reflection is allowed to make, or `undefined` when
 * it has none or is not confident enough. The caller must still run it through
 * its own policy gate — this only filters out the noise.
 */
export function strategySuggestionOf(
  reflection: RepairReflection | null | undefined,
): string | undefined {
  if (!reflection) return undefined
  if (reflection.confidence < REFLECTION_MIN_STRATEGY_CONFIDENCE) return undefined
  return reflection.suggestedStrategy
}
