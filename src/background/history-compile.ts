/**
 * Compile a conversation's recorded actions into a runnable workflow, and
 * decide what the save card should show.
 *
 * Workflow generation's PRIMARY path is operator-direct: the model calls
 * `wf_op_*` tools, each call records a node, and the draft is saved as-is. This
 * module is the FALLBACK for a conversation whose draft is empty — a model that
 * only read the page, or an older conversation recorded before the tool surface
 * changed. See `specs/2026-09-18-record-then-compile-design.md` for the history
 * path's design and `specs/2026-09-18-record-then-compile-plan.md` for the
 * operator-direct reversal.
 *
 * The mapping itself is `workflowFromHistory`'s job (action → block, trigger
 * head, post-navigation waits, OCR hand-off, node descriptions). This module
 * owns only what the compiler cannot know:
 *
 *   - history is stored newest-first; the compiler wants chronological order;
 *   - a failed action is not a step — replaying it would only fail again;
 *   - only this conversation's actions belong in this workflow;
 *   - and, for {@link resolveWorkflowForSave}, which of the two sources wins
 *     and what to tell the user when neither has anything.
 *
 * @module background/history-compile
 */

import type { HistoryEntry } from '../lib/types'
import { listHistory, workflowFromHistory } from '../lib/storage'
import type { WorkflowDraftEmptyReason } from '../lib/messages'
import {
  buildVariableIndex,
  mergeTriggerInputs,
  rewriteDataParams,
} from '../lib/workflow/dynamic-data'
import type { Workflow } from '../lib/workflow/types'
import { composeWorkflowFromDraft } from './operator-tool-handler'

export interface HistoryCompileResult {
  /** Null when the conversation recorded nothing the compiler can turn into a step. */
  workflow: Workflow | null
  /** Actions this conversation recorded. */
  recorded: number
  /** Of those, how many failed and were left out. */
  failed: number
  /** Nodes the compiled graph holds, trigger excluded. */
  steps: number
  /** Workflow inputs the compiler had to declare so the graph carries no dead data. */
  declaredInputs: string[]
}

/** Is this the graph's trigger head? */
function isTrigger(node: { data?: Record<string, unknown> }): boolean {
  return node.data?.['blockId'] === 'trigger'
}

/**
 * Replace business literals with `{{reference}}`s and declare whatever the
 * graph cannot produce on its own as a workflow input.
 *
 * Without this the compiled workflow is a dead recording: it would type the
 * keyword the user happened to ask for on the day it was generated, forever.
 * The operator path has always done this; the history path did not, which is
 * why compiling from history used to be rejected as a source
 * (`specs/2026-09-17-workflow-generation-mode-design.md`, "已否决的备选").
 *
 * The variable index is empty on purpose. Native actions do not write session
 * variables — there is no `set-variable` among them — so every business literal
 * genuinely has no producer and becomes a declared input. That is the correct
 * answer here, not a shortcut.
 */
function applyDynamicData(workflow: Workflow): string[] {
  const trigger = workflow.drawflow.nodes.find(isTrigger)
  if (!trigger) return []

  const declared = new Map<string, string>()
  const added: string[] = []

  for (const node of workflow.drawflow.nodes) {
    if (isTrigger(node)) continue
    const blockId = node.data?.['blockId']
    if (typeof blockId !== 'string' || !blockId) continue

    const result = rewriteDataParams({
      blockId,
      data: { ...node.data },
      variableIndex: buildVariableIndex({}, undefined),
      declared,
    })
    node.data = result.data

    if (result.newInputs.length === 0) continue
    const merged = mergeTriggerInputs(trigger.data ?? {}, result.newInputs)
    trigger.data = merged.data
    for (const input of result.newInputs) {
      if (declared.has(input.name)) continue
      declared.set(input.name, input.defaultValue)
      added.push(input.name)
    }
  }

  return added
}

/** Does an entry belong to this conversation and deserve a node? */
function usable(entry: HistoryEntry, conversationId: string): boolean {
  return entry.conversationId === conversationId && entry.ok !== false
}

/** Why a conversation has nothing worth saving. */
export type SaveEmptyReason = WorkflowDraftEmptyReason

/**
 * What the panel should put on the end-of-turn save card.
 *
 * A discriminated union rather than `Workflow | null`, because "nothing to
 * save" is not an error and must not be reported as one. Treating it as an
 * error is precisely how the save card disappeared: the command returned early
 * on an empty draft, so the history fallback below never ran and the panel got
 * no workflow and no explanation.
 */
export type SaveResolution =
  { workflow: Workflow; source: 'draft' | 'history' } | { empty: SaveEmptyReason }

/** Nodes the graph holds apart from its trigger head. */
function actionNodeCount(workflow: Workflow): number {
  return workflow.drawflow.nodes.filter((node) => node.data?.['blockId'] !== 'trigger').length
}

/**
 * Decide what this conversation can be saved as, and say so either way.
 *
 * Order matters and is deliberate:
 *
 *   1. **The operator draft wins.** A model that called `wf_op_*` tools has
 *      already decided what the graph should be; compiling the action history
 *      on top of that would second-guess it.
 *   2. **Otherwise compile the action history.** Reachable now that an empty
 *      draft no longer short-circuits this function — which is the bug this
 *      shape exists to prevent.
 *   3. **Otherwise report WHY it is empty**, so the panel can tell the user
 *      "the model did nothing" instead of leaving them to guess whether the
 *      feature is broken.
 *
 * `composeWorkflowFromDraft` is called with `save: false`, so its error result
 * has exactly one cause — an empty draft — and is treated as "no draft" rather
 * than as a failure.
 */
export async function resolveWorkflowForSave(
  conversationId: string,
  name: string,
): Promise<SaveResolution> {
  const out = await composeWorkflowFromDraft(conversationId, { save: false })
  const draft = 'error' in out ? null : out.workflow
  if (draft && actionNodeCount(draft) > 0) return { workflow: draft, source: 'draft' }

  const compiled = await compileConversationHistory(conversationId, name)
  if (compiled.workflow) return { workflow: compiled.workflow, source: 'history' }

  // Actions were recorded but none of them produced a node: the model tried and
  // every attempt failed. Distinct from "it never touched the page", because
  // only one of the two is worth telling the user to retry.
  return { empty: compiled.recorded > 0 ? 'all-failed' : 'no-actions' }
}

export async function compileConversationHistory(
  conversationId: string,
  name: string,
): Promise<HistoryCompileResult> {
  const all = await listHistory()
  const mine = all.filter((entry) => entry.conversationId === conversationId)
  const failed = mine.length - mine.filter((entry) => entry.ok !== false).length
  // `listHistory` sorts newest-first; the compiler walks the steps in the order
  // they happened.
  const chronological = mine
    .filter((entry) => usable(entry, conversationId))
    .sort((a, b) => a.at - b.at)
  const workflow = workflowFromHistory(chronological, name)
  if (workflow) {
    // Provenance + best-effort page origin, same fields the operator-draft
    // path stamps: the run gate's "open the page first" warning reads them.
    // History entries only carry a host (no scheme/path), so the origin is
    // reconstructed — a hint, not a guarantee.
    workflow.settings.provenance = 'chat-history'
    const host = chronological.find((entry) => entry.host)?.host
    if (host) workflow.settings.generationOriginUrl = `https://${host}`
  }
  const steps = workflow
    ? workflow.drawflow.nodes.filter((node) => node.data?.['blockId'] !== 'trigger').length
    : 0
  const declaredInputs = workflow ? applyDynamicData(workflow) : []
  return { workflow, recorded: mine.length, failed, steps, declaredInputs }
}
