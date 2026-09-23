/**
 * Variable contract extension (spec §5.3 · P2).
 *
 * The {@link VariableContract} type already existed, but nothing evaluated it
 * and nothing derived a contract from the graph. This module fills both:
 *
 *   - {@link evaluateContract} checks one produced value against a contract,
 *     distinguishing — exactly as §5.3 requires —
 *       • the variable was never produced (MISSING),
 *       • it exists but is empty (EMPTY),
 *       • its type is wrong (TYPE),
 *       • a minLength / pattern constraint is violated;
 *
 *   - {@link contractOfNode} / {@link contractsForWorkflow} derive the contract
 *     a producer node imposes on its own output, from explicit metadata
 *     (`__contract`) or deterministic block semantics.
 *
 * §5.3 boundary: when a contract cannot be proven (no contract known, or the
 * value is not inspectable), the result is `unknown: true` with a warning — it
 * can NEVER by itself block a save or a formal commit.
 *
 * Pure — no browser / provider.
 *
 * @module lib/workflow/variable-contract
 */

import type { VariableContract, VariableContractResult } from './repair/types'
import type { Workflow, WorkflowNode } from './types'

/** Extended contract result carrying the classified state + an unknown flag. */
export interface EvaluatedContract extends VariableContractResult {
  /** Classified primary state; 'ok' when the contract holds. */
  state: 'MISSING' | 'EMPTY' | 'TYPE' | 'LENGTH' | 'PATTERN' | 'ok'
  /** No contract was available / value not inspectable — do not block save. */
  unknown: boolean
}

const TYPE_NAMES = ['string', 'number', 'boolean', 'array', 'object'] as const

/** JS runtime class mapped to the contract vocabulary. */
export function valueTypeOf(value: unknown): VariableContract['type'] | 'null' | 'undefined' {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const primitive = typeof value
  if (primitive === 'string' || primitive === 'number' || primitive === 'boolean') {
    return primitive
  }
  if (primitive === 'object') return 'object'
  return 'undefined'
}

function lengthOf(value: unknown): number | undefined {
  if (typeof value === 'string' || Array.isArray(value)) return value.length
  return undefined
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' || Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as object).length === 0
  return false
}

/**
 * Evaluate one produced value against a contract.
 *
 * @param input.produced whether the variable exists at all (false ⇒ MISSING).
 */
export function evaluateContract(
  value: unknown,
  contract: VariableContract | undefined,
  input: { produced: boolean } = { produced: true },
): EvaluatedContract {
  if (!contract) {
    // No contract to check: unknown, never a blocker.
    return { valid: true, violations: [], state: 'ok', unknown: true }
  }

  const violations: string[] = []

  if (!input.produced) {
    violations.push('variable was not produced')
    return { valid: false, violations, state: 'MISSING', unknown: false }
  }

  const required = contract.required ?? true
  const allowEmpty = contract.allowEmpty ?? false

  if (required && isEmpty(value)) {
    if (!allowEmpty) {
      violations.push('variable is empty')
      return { valid: false, violations, state: 'EMPTY', unknown: false }
    }
  }

  if (contract.type) {
    const actual = valueTypeOf(value)
    if (actual !== contract.type) {
      violations.push(`expected type ${contract.type}, got ${actual}`)
      return { valid: false, violations, state: 'TYPE', unknown: false }
    }
  }

  if (contract.minLength !== undefined) {
    const length = lengthOf(value)
    if (length !== undefined && length < contract.minLength) {
      violations.push(`length ${length} is below minLength ${contract.minLength}`)
      return { valid: false, violations, state: 'LENGTH', unknown: false }
    }
  }

  if (contract.pattern) {
    if (typeof value === 'string') {
      let regex: RegExp
      try {
        regex = new RegExp(contract.pattern)
      } catch {
        // An uncompilable pattern cannot be proven: a warning, not a failure.
        return {
          valid: true,
          violations: ['contract pattern is not a valid regular expression'],
          state: 'ok',
          unknown: true,
        }
      }
      if (!regex.test(value)) {
        violations.push(`value does not match pattern ${contract.pattern}`)
        return { valid: false, violations, state: 'PATTERN', unknown: false }
      }
    }
  }

  return { valid: true, violations, state: 'ok', unknown: false }
}

const CONTRACT_KEY = '__contract'

/** Explicit contract metadata a producer node may carry. */
export function explicitContractOf(node: WorkflowNode): VariableContract | undefined {
  const raw = node.data?.[CONTRACT_KEY]
  if (raw && typeof raw === 'object') return normalizeContract(raw)
  return undefined
}

function normalizeContract(raw: object): VariableContract | undefined {
  const source = raw as Record<string, unknown>
  const contract: VariableContract = {}
  const type = source['type']
  if (typeof type === 'string' && (TYPE_NAMES as readonly string[]).includes(type)) {
    contract.type = type as VariableContract['type']
  }
  if (typeof source['required'] === 'boolean') contract.required = source.required
  if (typeof source['allowEmpty'] === 'boolean') contract.allowEmpty = source.allowEmpty
  if (typeof source['minLength'] === 'number' && Number.isFinite(source['minLength'])) {
    contract.minLength = Math.trunc(source['minLength'])
  }
  if (typeof source['pattern'] === 'string') contract.pattern = source['pattern']
  return Object.keys(contract).length > 0 ? contract : undefined
}

/**
 * Default contract derived from a producer block's own semantics.
 *
 * Only emitted for blocks that PRODUCE a named variable; keeps the invariant
 * that a transform/producer output is a required, non-empty value unless the
 * block explicitly declares otherwise. Never invents a pattern.
 */
export function defaultContractOfNode(node: WorkflowNode): VariableContract | undefined {
  const variableName = node.data?.['variableName']
  if (typeof variableName !== 'string' || !variableName.trim()) return undefined
  const blockId =
    typeof node.data['blockId'] === 'string' ? (node.data['blockId'] as string) : node.label
  // Numeric producers produce numbers, not strings.
  if (blockId === 'increase-variable') {
    return { type: 'number', required: true, allowEmpty: false }
  }
  // Collection / mapping producers output arrays.
  if (blockId === 'data-mapping' || blockId === 'slice-variable' || blockId === 'sort-data') {
    return { type: 'array', required: true, allowEmpty: true }
  }
  return { required: true, allowEmpty: false }
}

/** Contract a producer node imposes: explicit metadata wins over the default. */
export function contractOfNode(node: WorkflowNode): VariableContract | undefined {
  return explicitContractOf(node) ?? defaultContractOfNode(node)
}

/** variable name → contract, across every producer node in the workflow. */
export function contractsForWorkflow(workflow: Workflow): Map<string, VariableContract> {
  const out = new Map<string, VariableContract>()
  for (const node of workflow.drawflow.nodes) {
    const variableName = node.data?.['variableName']
    if (typeof variableName !== 'string' || !variableName.trim()) continue
    const contract = contractOfNode(node)
    if (contract) out.set(variableName.trim(), contract)
  }
  return out
}
