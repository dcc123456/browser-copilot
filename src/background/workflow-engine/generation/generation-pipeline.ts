/**
 * Generation pipeline (spec §6 · Commit 07).
 *
 * Formalizes the assembly of a captured draft into a ready workflow as a
 * sequence of stages, each returning a report:
 *
 * ```text
 * Normalize → Generalize Inputs → Harden Targets → Build Reliability
 *          → Static Validate → Independent Verify
 * ```
 *
 * The first four transform the draft and are implemented here; the last two
 * run over the compiled workflow and are added by {@link staticValidateStage}
 * / {@link independentVerifyStage} from the compose path, so every stage is
 * reported to the generation UI rather than a bare "success".
 *
 * Pure module: hardening is structural (no live page); an optional probe may
 * be supplied by callers that have a page, but it is never required.
 *
 * @module background/workflow-engine/generation/generation-pipeline
 */

import type { WorkflowDraft } from '../../../lib/workflow/draft-types'
import { normalizeWorkflowDraft } from './normalize'
import { generalizeInputs } from '../../../lib/workflow/input-generalization'
import {
  autoCompleteReliability,
} from '../../../lib/workflow/auto-contract'
import {
  mergeTriggerInputs,
  type DeclaredInput,
} from '../../../lib/workflow/dynamic-data'
import { defaultReadinessFor } from '../../../lib/workflow/readiness'
import {
  stageReport,
  type GenerationStageReport,
} from '../../../lib/workflow/generation-report'
import type { WorkflowNode } from '../../../lib/workflow/types'

/** The canonical trigger block id used on the draft's head node. */
const TRIGGER_BLOCK_ID = 'trigger'

function isTriggerNode(node: WorkflowNode): boolean {
  return blockIdOf(node) === TRIGGER_BLOCK_ID
}

/** Ensure the draft starts with a trigger node (mirrors the handler helper). */
function ensureHead(input: WorkflowDraft): void {
  if (input.nodes.some(isTriggerNode)) return
  const head: WorkflowNode = {
    id: 'trigger',
    label: TRIGGER_BLOCK_ID,
    position: { x: 0, y: 0 },
    data: { blockId: TRIGGER_BLOCK_ID, type: 'manual' },
  }
  input.nodes.unshift(head)
  const tailId = input.nodes[1]?.id
  if (tailId) input.edges.unshift({ id: 'gen-head', source: head.id, target: tailId })
  if (!input.tail) input.tail = input.nodes.at(-1)?.id ?? null
}

/** Names already declared on the trigger head (from its parameters). */
function declaredInputNames(draft: WorkflowDraft): Set<string> {
  const head = draft.nodes.find(isTriggerNode)
  const params = head?.data?.['parameters']
  if (!Array.isArray(params)) return new Set()
  const names = new Set<string>()
  for (const param of params) {
    if (param && typeof param === 'object' && typeof (param as { name?: unknown }).name === 'string') {
      names.add((param as { name: string }).name)
    }
  }
  return names
}

/** Merge declared inputs onto the trigger head without handler coupling. */
function declareInputs(draft: WorkflowDraft, inputs: readonly DeclaredInput[]): void {
  if (inputs.length === 0) return
  ensureHead(draft)
  const node = draft.nodes.find(isTriggerNode)
  if (!node) return
  const { data } = mergeTriggerInputs(node.data, inputs, declaredInputNames(draft))
  node.data = data
}

/** Mutable draft plus the reports accumulated so far. */
export interface GenerationPipelineState {
  draft: WorkflowDraft
  stages: GenerationStageReport[]
}

function blockIdOf(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  return typeof fromData === 'string' && fromData ? fromData : node.label
}

/**
 * Structural target hardening (§6.6): every key element action should carry
 * either a CSS selector or a rich semantic target. Without a live page this
 * can only check the recorded evidence; missing ones are a warning, never a
 * block (the reliability engine re-resolves at run time).
 */
function hardenTargets(draft: WorkflowDraft): GenerationStageReport {
  let elementActions = 0
  let weak = 0
  for (const node of draft.nodes) {
    const blockId = blockIdOf(node)
    if (blockId === 'trigger' || defaultReadinessFor(blockId, node.data ?? {}) === undefined) {
      continue
    }
    elementActions += 1
    const hasSelector = typeof node.data?.['selector'] === 'string' && node.data['selector']
    const hasTarget = Boolean(node.data?.['target'])
    const hasSemantic = Boolean(node.data?.['semantic'])
    if (!hasSelector && !hasTarget && !hasSemantic) weak += 1
  }
  if (elementActions === 0) {
    return stageReport('HARDEN_TARGETS', 'skipped', 'no element actions to harden')
  }
  return stageReport(
    'HARDEN_TARGETS',
    weak > 0 ? 'warn' : 'ok',
    weak > 0 ? `${weak}/${elementActions} element actions lack a recorded locator` : 'all element actions carry a locator',
    { elementActions, weak },
  )
}

/**
 * Run the draft-transforming stages (Normalize → Generalize → Harden → Build
 * Reliability). The input draft is not mutated; the resulting draft and stage
 * reports are returned.
 */
export function runDraftPipeline(input: WorkflowDraft): GenerationPipelineState {
  const stages: GenerationStageReport[] = []

  // 1. Normalize
  const normalized = normalizeWorkflowDraft(input)
  let draft: WorkflowDraft = normalized.draft
  stages.push(
    stageReport(
      'NORMALIZE',
      normalized.removedNodeIds.length > 0 ? 'ok' : 'skipped',
      normalized.removedNodeIds.length > 0
        ? `removed ${normalized.removedNodeIds.length} redundant node(s)`
        : 'no redundant actions',
      { removed: normalized.removedNodeIds.length, inputCandidates: normalized.inputCandidates.length },
    ),
  )

  // 2. Generalize Inputs
  const generalized = generalizeInputs(draft)
  draft = generalized.draft
  if (generalized.declarations.length > 0) {
    // Merge declarations onto the trigger head (mutates the draft nodes).
    declareInputs(draft, generalized.declarations)
  }
  stages.push(
    stageReport(
      'GENERALIZE_INPUTS',
      generalized.declarations.length > 0 ? 'ok' : 'skipped',
      generalized.declarations.length > 0
        ? `declared ${generalized.declarations.length} runtime input(s)`
        : 'no business inputs to generalize',
      { declared: generalized.declarations.length, blockedSensitive: generalized.blockedSensitive.length },
    ),
  )

  // 3. Harden Targets (structural)
  stages.push(hardenTargets(draft))

  // 4. Build Reliability Contract
  const beforeCount = draft.nodes.filter((n) => n.data?.['__reliability']).length
  const touched = autoCompleteReliability(draft.nodes)
  const afterCount = draft.nodes.filter((n) => n.data?.['__reliability']).length
  stages.push(
    stageReport(
      'BUILD_RELIABILITY',
      touched > 0 ? 'ok' : 'skipped',
      touched > 0 ? `completed contract on ${touched} node(s)` : 'contracts already complete',
      { touched, withContract: afterCount - beforeCount },
    ),
  )

  return { draft, stages }
}

/** Compose a Static Validate stage report from two validation reports. */
export function staticValidateStage(
  runErrors: number,
  generatedErrors: number,
): GenerationStageReport {
  const total = runErrors + generatedErrors
  return stageReport(
    'STATIC_VALIDATE',
    total > 0 ? 'warn' : 'ok',
    total > 0 ? `${total} non-blocking validation finding(s)` : 'static validation passed',
    { runErrors, generatedErrors },
  )
}

/**
 * Independent Verify stage. Verification requires a live replay, which is not
 * available at assembly time, so it is reported as pending (ready on the
 * first run) rather than faked as success.
 */
export function independentVerifyStage(): GenerationStageReport {
  return stageReport(
    'INDEPENDENT_VERIFY',
    'pending',
    'pending first run — goal is verified on replay',
  )
}
