/**
 * Generation save gate (spec §29, Commit 6).
 *
 * The unified gate every generated workflow passes BEFORE it is saved:
 *
 * ```text
 * 1. graph validation       connectivity / reachability / integrity
 * 2. goal gate              generated-strict requires a verifiable goal
 * 3. reliability gate       key nodes carry intent / idempotency / postconditions
 * 4. selector probe         (live; injected) re-pick / harden selectors
 * 5. wait persistence       default element waits persisted into the graph
 * 6. strict mode check      provenance + reliabilityMode agree on strict
 * 7. origin provenance      generation origin URL is present when needed
 * ```
 *
 * Layers 1-3 and 5-7 are pure (no browser); layer 4 needs the live page so
 * it is an injected async probe and is optional (a closed page degrades to
 * the old behavior with a warning instead of blocking the save).
 *
 * @module lib/workflow/save-gate
 */
import { checkWorkflowIntegrity } from './integrity'
import { goalSpecOf, isGeneratedStrict, nodeReliabilityOf } from './reliability'
import { persistDefaultWaits } from './runnability'
import { validateGeneratedWorkflow } from './generated-validation'
import type { Workflow, WorkflowNode } from './types'

export interface SaveGateIssue {
  code: string
  message: string
  nodeId?: string
}

export interface WorkflowSaveGateResult {
  ok: boolean
  blockers: SaveGateIssue[]
  warnings: SaveGateIssue[]
  /** The hardened workflow (waits persisted; selectors hardened when probed). */
  hardenedWorkflow: Workflow
}

/** Live selector probe / hardening (spec layer 4). Optional input. */
export interface SelectorProbe {
  /**
   * Re-pick/harden element selectors against the live page. Returns the
   * hardened workflow plus any non-blocking warning.
   */
  harden: (workflow: Workflow) => Promise<{ workflow: Workflow; warning?: string }>
}

function blockIdOf(node: WorkflowNode): string {
  const value = node.data?.['blockId']
  return typeof value === 'string' ? value : ''
}

/** Element-bearing blocks must carry a locator (selector or semantic). */
function hasLocator(node: WorkflowNode): boolean {
  const data = node.data ?? {}
  if (typeof data['selector'] === 'string' && data['selector']) return true
  if (typeof data['cssSelector'] === 'string' && data['cssSelector']) return true
  const reliability = nodeReliabilityOf(node)
  if (reliability?.locator?.semantic) return true
  return false
}

export interface ValidateSaveInput {
  workflow: Workflow
  /** Live selector hardener; omit when no page is available. */
  probe?: SelectorProbe
}

/**
 * Run the full save gate. Blockers fail the save; warnings annotate. The
 * returned workflow carries persisted waits (and hardened selectors when a
 * probe was supplied).
 */
export async function validateGeneratedWorkflowForSave(
  input: ValidateSaveInput,
): Promise<WorkflowSaveGateResult> {
  const blockers: SaveGateIssue[] = []
  const warnings: SaveGateIssue[] = []
  let workflow = input.workflow

  // 6. Strict-mode check (do this early; later gates read the same decision).
  const strict = isGeneratedStrict(workflow)
  if (strict) {
    if (workflow.settings.provenance !== 'chat-generate' && workflow.settings.provenance !== 'chat-history') {
      warnings.push({
        code: 'PROVENANCE_MISMATCH',
        message: 'strict mode without a generation provenance',
      })
    }
  }

  // 1. Graph validation — generated validation report + integrity.
  const report = validateGeneratedWorkflow(workflow)
  for (const issue of report.errors) {
    blockers.push({
      code: issue.code,
      message: issue.message,
      ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
    })
  }
  for (const issue of report.warnings) {
    warnings.push({
      code: issue.code,
      message: issue.message,
      ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
    })
  }

  const integrity = checkWorkflowIntegrity(workflow)
  for (const id of integrity.orphanNodes) {
    blockers.push({ code: 'ORPHAN_NODE', message: `node is not reachable from trigger: ${id}`, nodeId: id })
  }
  for (const dangling of integrity.danglingVars) {
    blockers.push({
      code: 'DANGLING_VAR',
      message: `variable "${dangling.reference}" is referenced but never produced`,
      nodeId: dangling.nodeId,
    })
  }

  // 2. Goal gate.
  if (strict) {
    const goal = goalSpecOf(workflow)
    if (!goal) {
      blockers.push({ code: 'GOAL_MISSING', message: 'a generated-strict workflow must state a verifiable goal' })
    } else if (goal.successConditions.length === 0) {
      blockers.push({ code: 'GOAL_EMPTY', message: 'the goal spec has no success conditions' })
    }
  }

  // 3. Reliability gate — element blocks carry a locator and key blocks carry
  //    intent.
  for (const node of workflow.drawflow.nodes) {
    if (!blockIdOf(node) || blockIdOf(node) === 'trigger') continue
    const reliability = nodeReliabilityOf(node)
    if (!reliability?.intent) {
      warnings.push({ code: 'INTENT_MISSING', message: `node has no recorded intent: ${node.id}`, nodeId: node.id })
    }
    const elementBlock = report.issues.some(
      (issue) => issue.nodeId === node.id && issue.code.startsWith('LOCATOR'),
    )
    if (elementBlock && !hasLocator(node)) {
      blockers.push({ code: 'LOCATOR_MISSING', message: `element node has no locator: ${node.id}`, nodeId: node.id })
    }
  }

  // 7. Origin provenance — a workflow whose first action touches an element
  //    with no navigation before it should carry the generation origin.
  const firstAction = workflow.drawflow.nodes.find((node) => blockIdOf(node) !== 'trigger')
  if (firstAction && !workflow.settings.generationOriginUrl) {
    const navigates = firstAction ? blockIdOf(firstAction) === 'open-url' || blockIdOf(firstAction) === 'navigate' : true
    if (!navigates) {
      warnings.push({
        code: 'ORIGIN_MISSING',
        message: 'no generation origin URL recorded; the workflow may run on the wrong page',
      })
    }
  }

  // 4. Selector probe / hardening (live; optional).
  if (input.probe) {
    try {
      const hardened = await input.probe.harden(workflow)
      workflow = hardened.workflow
      if (hardened.warning) {
        warnings.push({ code: 'SELECTOR_HARDENING_PARTIAL', message: hardened.warning })
      }
    } catch (error) {
      warnings.push({
        code: 'SELECTOR_HARDENING_FAILED',
        message: error instanceof Error ? error.message : 'selector hardening failed',
      })
    }
  } else {
    warnings.push({ code: 'SELECTOR_PROBE_SKIPPED', message: 'selector hardening skipped: no live page available' })
  }

  // 5. Wait persistence (pure structural transform).
  workflow = persistDefaultWaits(workflow)

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    hardenedWorkflow: workflow,
  }
}
