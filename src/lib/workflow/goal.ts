/**
 * Workflow goal — the "what does DONE mean" contract, pure layer.
 *
 * The goal spec lives on `settings.goalSpec` (see `lib/workflow/reliability`
 * for access + the strict gate). This module adds the pieces that stay pure:
 * normalization of untrusted goal shapes, and the derivation of a goal spec
 * from a generation draft — so a generated workflow's goal is GROUNDED in what
 * its nodes actually verify, not invented beside the graph.
 *
 * @module lib/workflow/goal
 */
import { workflowConditionsOf, type WorkflowCondition } from './conditions'
import { nodeReliabilityOf } from './reliability'
import type { WorkflowGoalSpec } from './reliability'
import { conditionRequiresBaseline } from './conditions'
import { provesLandedEffect } from './repair-verification'
import type { WorkflowNode } from './types'

/**
 * Normalize an untrusted goal-spec shape: a non-empty summary and at least one
 * well-formed success condition, plus optional terminal-state conditions.
 * Garbage in → `undefined` (the strict gate then reports the missing goal).
 */
export function normalizeGoalSpec(value: unknown): WorkflowGoalSpec | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw['summary'] !== 'string' || !raw['summary'].trim()) return undefined
  const successConditions = workflowConditionsOf(raw['successConditions'])
  if (successConditions.length === 0) return undefined
  const terminalStateConditions = workflowConditionsOf(raw['terminalStateConditions'])
  return {
    summary: raw['summary'],
    successConditions,
    ...(terminalStateConditions.length ? { terminalStateConditions } : {}),
  }
}

/** Drafts and graphs both reduce to "nodes + name" for derivation. */
export interface GoalDerivationSource {
  name: string
  nodes: Pick<WorkflowNode, 'id' | 'label' | 'data'>[]
}

/**
 * Derive a goal spec from a generated graph.
 *
 * The derivation is GROUNDED: the success conditions are exactly the
 * postconditions the nodes declare (via `__reliability`), in graph order —
 * a goal is what the graph can actually VERIFY, nothing more. A graph with no
 * postconditions derives nothing (`undefined`), which is why the generation
 * contract requires postconditions on key actions (spec §8/§12): without them
 * the workflow cannot state its own goal, and a generated-strict save is
 * blocked by the validator instead of silently claiming success.
 *
 * `goalText` (the user's request that started the generation) becomes the
 * summary when available — it is the honest statement of intent.
 */
export function deriveGoalSpecFromNodes(
  source: GoalDerivationSource,
  goalText?: string,
): WorkflowGoalSpec | undefined {
  const successConditions: WorkflowCondition[] = []
  const terminalStateConditions: WorkflowCondition[] = []
  for (const node of source.nodes) {
    const spec = nodeReliabilityOf(node as WorkflowNode)
    if (!spec) continue
    if (spec.postconditions?.length) successConditions.push(...spec.postconditions)
    // An UNSAFE action's postconditions describe the terminal state ("已登录",
    // "订单已提交") — they are exactly the already-satisfied evidence a resume
    // needs, so they double as terminal-state conditions.
    if (spec.idempotency === 'unsafe' && spec.postconditions?.length) {
      terminalStateConditions.push(...spec.postconditions)
    }
  }
  if (successConditions.length === 0) return undefined
  const summary = (goalText ?? '').trim() || source.name.trim() || '工作流目标'
  return {
    summary,
    successConditions,
    ...(terminalStateConditions.length ? { terminalStateConditions } : {}),
  }
}

/** Whole-token `indexOf`: `noteTitle` must not match inside `noteTitleActual`. */
function mentionsName(haystack: string, name: string): boolean {
  const isWordChar = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9_]/.test(ch)
  let from = 0
  for (;;) {
    const at = haystack.indexOf(name, from)
    if (at === -1) return false
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + name.length])) return true
    from = at + name.length
  }
}

/**
 * Ground a goal-first contract in the graph that was actually built.
 *
 * `prepare_workflow_goal` runs on the FIRST turn, before a single node exists,
 * so its success conditions name the variables the model EXPECTED to write. The
 * graph then writes its own (`xhsTitle`, `noteBody`, …), and a 「变量
 * xiaohongshuTitle 存在」 row can never hold: the replay runs 26/26 clean, the
 * goal is permanently uncertifiable, and the one number everyone was supposed to
 * trust becomes the thing you learn to ignore. An unverifiable row is not a
 * strict goal — it is a broken instrument, and a broken instrument reads false
 * even when the goal landed.
 *
 * The test is deliberately the WEAKEST claim of "this graph knows the name":
 * the name appears anywhere in a node's data, or is declared as a run input.
 * An exact producer-field whitelist would be stricter, but the set of blocks
 * that write a variable is wider than any list here keeps current (see
 * `VARIABLE_PRODUCER_FIELD`, which had already drifted once) — and a row that
 * drops a checkable goal is a silent weakening, while a row kept on a name the
 * graph genuinely writes can still fail on its merits.
 *
 * Dropping loses evidence, so the graph's own verified postconditions
 * (`deriveGoalSpecFromNodes`) fill in, and they are added only as needed to
 * restore a landed-effect proof — a URL row cannot be that proof, and a goal
 * reduced to one is not a goal. If the graph offers nothing, the contract is
 * returned untouched: better a loud, permanent failure than a certificate for a
 * run that did nothing.
 */
/**
 * The words a step's locator really matched, with the prose that describes it
 * kept OUT.
 *
 * A recorded target carries `{how:'text'|'role', value}` and the fingerprint's
 * `accessibleName`/`label`/`text` — all copied off the page — while the node's
 * own label and intent are sentences someone wrote about it. Round 80's graph
 * ends on a step labelled 「点击暂存离开按钮保存草稿」 whose target text is
 * 「暂存离开」: the prose names a control the page never showed, and only the
 * target knows what the page does show. `elementWordsOf` mixes the two because a
 * COMMIT policy has to read both, which is the wrong corpus for this question.
 */
function recordedPageWords(node: GoalDerivationSource['nodes'][number]): string[] {
  const data = (node.data ?? {}) as Record<string, unknown>
  const target = data['target'] as
    | {
        label?: unknown
        primary?: { how?: unknown; value?: unknown }
        fallbacks?: { how?: unknown; value?: unknown }[]
      }
    | undefined
  const parts: string[] = []
  for (const spec of [target?.primary, ...(target?.fallbacks ?? [])]) {
    if (!spec || typeof spec.value !== 'string') continue
    if (spec.how !== 'text' && spec.how !== 'role') continue
    parts.push(spec.value)
  }
  if (typeof target?.label === 'string') parts.push(target.label)
  const locator = (data['__reliability'] as { locator?: Record<string, unknown> } | undefined)
    ?.locator
  for (const key of ['accessibleName', 'label', 'text']) {
    const value = locator?.[key]
    if (typeof value === 'string') parts.push(value)
  }
  return [...new Set(parts.map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean))]
}

/** The sentences written ABOUT a step: its label, its declared intent. */
function stepProse(node: GoalDerivationSource['nodes'][number]): string {
  const reliability = node.data?.['__reliability'] as { intent?: unknown } | undefined
  return [node.label ?? '', typeof reliability?.intent === 'string' ? reliability.intent : ''].join(
    ' ',
  )
}

/**
 * Re-word a presence row that quotes the TASK instead of the PAGE.
 *
 * `prepare_workflow_goal` runs before a single page is read, so the model names a
 * control in the words the user used: 「元素存在 "保存草稿"」, and 小红书's button
 * reads 「暂存离开」. That row can never hold, and the verdict blames the run
 * (`元素不存在`) for a defect in the instrument — round 80 replayed 18/18 clean and
 * saved a real draft, and its goal still read false over those two words.
 *
 * The rewrite is only allowed where the graph itself resolves the ambiguity: the
 * row's words appear in one step's PROSE, that step recorded PAGE words, and the
 * page never showed the row's words. Then the row aims at the same control by the
 * name the page has, and `describeCondition` renders the words a reader can check.
 * A row naming words no
 * step ever spoke is left alone — a goal may legitimately aim at state that
 * appears after the last recorded step, and silently re-wording a guess would be
 * the same fabrication this file exists to remove.
 */
function alignRowWordsToPage(
  conditions: WorkflowCondition[],
  nodes: GoalDerivationSource['nodes'],
  isTrigger: (node: Pick<WorkflowNode, 'data'>) => boolean,
): WorkflowCondition[] {
  const steps = nodes.filter((node) => !isTrigger(node))
  const page = steps.map(recordedPageWords)
  const prose = steps.map(stepProse)
  return conditions.map((condition) => {
    if (condition.kind !== 'elementExists' && condition.kind !== 'elementVisible') return condition
    const target = (condition as unknown as { target?: Record<string, unknown> }).target
    const words = typeof target?.['text'] === 'string' ? (target['text'] as string).trim() : ''
    if (!words) return condition
    if (page.some((seen) => seen.some((word) => word.includes(words)))) return condition
    const index = prose.findIndex((text) => text.includes(words))
    if (index < 0) return condition
    const seen = (page[index] ?? []).slice().sort((a, b) => a.length - b.length)[0]
    if (!seen || seen === words) return condition
    return { ...condition, target: { ...target, text: seen } } as unknown as WorkflowCondition
  })
}

export function groundGoalSpecToGraph(
  goalSpec: WorkflowGoalSpec,
  source: GoalDerivationSource,
): { goalSpec: WorkflowGoalSpec; dropped: WorkflowCondition[] } {
  const nodes = source.nodes
  const isTrigger = (node: Pick<WorkflowNode, 'data'>): boolean =>
    node.data?.['blockId'] === 'trigger'
  const haystack = [
    nodes
      .filter((node) => !isTrigger(node))
      .map((node) => JSON.stringify(node.data ?? {}))
      .join('\n'),
    JSON.stringify(nodes.find(isTrigger)?.data?.['parameters'] ?? ''),
  ].join('\n')

  const dropped: WorkflowCondition[] = []
  const aligned = alignRowWordsToPage(goalSpec.successConditions, nodes, isTrigger)
  const reworded = JSON.stringify(aligned) !== JSON.stringify(goalSpec.successConditions)
  const specWith = (successConditions: WorkflowCondition[]): WorkflowGoalSpec => ({
    summary: goalSpec.summary,
    successConditions,
    ...(goalSpec.terminalStateConditions?.length
      ? { terminalStateConditions: goalSpec.terminalStateConditions }
      : {}),
  })
  const kept = aligned.filter((condition) => {
    if (condition.kind !== 'variableExists' && condition.kind !== 'variableEquals') return true
    if (mentionsName(haystack, condition.name)) return true
    dropped.push(condition)
    return false
  })
  if (dropped.length === 0)
    return { goalSpec: reworded ? specWith(aligned) : goalSpec, dropped: [] }

  const successConditions = [...kept]
  if (!successConditions.some(provesLandedEffect)) {
    const derived = deriveGoalSpecFromNodes(source)?.successConditions ?? []
    // A CHANGE row (「the draft list grew」, 「the dialog vanished」) is the better
    // proof, and it used to be the forbidden one: nothing remembered the page
    // from before its step, so installing one meant a goal that read false no
    // matter what happened. A run now carries that snapshot and both goal layers
    // read it, which leaves the other direction as the real risk — a plain
    // presence row is satisfied by standing page furniture, and a goal that the
    // untouched page already meets is the broken instrument again, one layer up.
    const candidates = [
      ...derived.filter(conditionRequiresBaseline),
      ...derived.filter((condition) => !conditionRequiresBaseline(condition)),
    ]
    for (const condition of candidates) {
      if (successConditions.some((c) => JSON.stringify(c) === JSON.stringify(condition))) continue
      successConditions.push(condition)
      if (successConditions.some(provesLandedEffect)) break
    }
  }
  if (successConditions.length === 0) return { goalSpec, dropped: [] }
  return {
    goalSpec: {
      summary: goalSpec.summary,
      successConditions,
      ...(goalSpec.terminalStateConditions?.length
        ? { terminalStateConditions: goalSpec.terminalStateConditions }
        : {}),
    },
    dropped,
  }
}
