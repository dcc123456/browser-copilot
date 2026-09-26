/**
 * Node Goal Contract — the per-node "why does this node exist" metadata.
 *
 * Every AI-generated action node carries one structured contract under the
 * dedicated `__workflowAi` metadata namespace so the goal, success criteria and
 * repair hints are not buried inside block-specific params or an invisible
 * `description`. Old workflows (no `__workflowAi`) keep loading unchanged —
 * every field is optional and accessors degrade gracefully.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/node-goal-contract
 */

import type { WorkflowCondition } from './conditions'
import { workflowConditionsOf } from './conditions'

/** The metadata namespace stored on `node.data`. */
export const WORKFLOW_AI_NAMESPACE = '__workflowAi'

/** Versioned node goal contract. */
export interface WorkflowNodeGoalContract {
  version: 1
  /** The instantiated goal — what THIS call must achieve, not the tool docs. */
  goal: string
  /** Machine-verifiable facts that must hold after the node ran. */
  successCriteria: WorkflowCondition[]
  /** Facts that must hold before the node may run. */
  preconditions?: WorkflowCondition[]
  /** Human meanings of failure for this specific node. */
  failureMeaning?: string[]
  /** Where to find supporting data at repair time. */
  evidence?: EvidenceSpec[]
  /** Deterministic repair guidance, ordered by preference. */
  repairHints?: RepairHint[]
}

/** A pointer to evidence a node relies on. */
export interface EvidenceSpec {
  kind: 'variable' | 'element' | 'url' | 'screenshot' | 'trace'
  /** Variable name, selector or trace reference, depending on `kind`. */
  ref: string
  note?: string
}

/** One deterministic repair hint. */
export interface RepairHint {
  /** What to repair. */
  target: 'locator' | 'parameter' | 'precondition' | 'postcondition' | 'capability'
  /** What to do, in one short instruction. */
  action: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && !!item.trim())
}

function evidenceList(value: unknown): EvidenceSpec[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((raw) => {
      const kind = raw['kind']
      if (
        kind !== 'variable' &&
        kind !== 'element' &&
        kind !== 'url' &&
        kind !== 'screenshot' &&
        kind !== 'trace'
      ) {
        return null
      }
      if (typeof raw['ref'] !== 'string' || !raw['ref'].trim()) return null
      return {
        kind,
        ref: raw['ref'],
        ...(typeof raw['note'] === 'string' ? { note: raw['note'] } : {}),
      }
    })
    .filter((item): item is EvidenceSpec => item !== null)
}

function repairHintList(value: unknown): RepairHint[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((raw) => {
      const target = raw['target']
      if (
        target !== 'locator' &&
        target !== 'parameter' &&
        target !== 'precondition' &&
        target !== 'postcondition' &&
        target !== 'capability'
      ) {
        return null
      }
      if (typeof raw['action'] !== 'string' || !raw['action'].trim()) return null
      return { target, action: raw['action'] }
    })
    .filter((item): item is RepairHint => item !== null)
}

/**
 * Normalise an untrusted node-goal-contract shape. Returns undefined when the
 * shape lacks a non-empty goal or any well-formed success criterion.
 */
export function normalizeNodeGoalContract(value: unknown): WorkflowNodeGoalContract | undefined {
  if (!isRecord(value)) return undefined
  if (value['version'] !== 1 && value['version'] !== undefined) return undefined
  if (typeof value['goal'] !== 'string' || !value['goal'].trim()) return undefined
  const successCriteria = workflowConditionsOf(value['successCriteria'])
  if (successCriteria.length === 0) return undefined
  const preconditions = workflowConditionsOf(value['preconditions'])
  const failureMeaning = stringList(value['failureMeaning'])
  const evidence = evidenceList(value['evidence'])
  const repairHints = repairHintList(value['repairHints'])
  return {
    version: 1,
    goal: value['goal'],
    successCriteria,
    ...(preconditions.length ? { preconditions } : {}),
    ...(failureMeaning.length ? { failureMeaning } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...(repairHints.length ? { repairHints } : {}),
  }
}

/** Read the goal contract off a node's `data`, or undefined when absent/invalid. */
export function nodeGoalContractOf(data: Record<string, unknown>): WorkflowNodeGoalContract | undefined {
  const namespace = data[WORKFLOW_AI_NAMESPACE]
  if (!isRecord(namespace)) return undefined
  return normalizeNodeGoalContract(namespace['goalContract'])
}

/** Attach a goal contract to a node's `data`, returning the updated copy. */
export function withNodeGoalContract(
  data: Record<string, unknown>,
  contract: WorkflowNodeGoalContract,
): Record<string, unknown> {
  const existing = isRecord(data[WORKFLOW_AI_NAMESPACE]) ? data[WORKFLOW_AI_NAMESPACE] : {}
  return {
    ...data,
    [WORKFLOW_AI_NAMESPACE]: { ...existing, goalContract: contract },
  }
}

/** Whether a node already carries a valid goal contract. */
export function hasNodeGoalContract(data: Record<string, unknown>): boolean {
  return nodeGoalContractOf(data) !== undefined
}
