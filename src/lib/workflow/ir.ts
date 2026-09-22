/**
 * Workflow Intermediate Representation (计划 T01.1).
 *
 * The LLM and the trace adapter never author final Workflow JSON: they produce
 * an IR — semantic actions, dataflow (value refs), pre/post conditions and
 * side-effect levels over a small step/edge graph. A deterministic compiler
 * (`compileIR`) turns the IR into the editor/engine Workflow shape.
 *
 * Separation of concerns:
 *
 *   IR        — semantics, dataflow, control flow, goal, risk.
 *   Workflow  — blocks, block params, the editor graph.
 *
 * The Workflow JSON can never flow back into the semantic model: compilation
 * is one-way. Import/export of workflows is untouched.
 *
 * The compiler in this module is intentionally minimal (structural mapping);
 * the capability-driven compiler with full params/readiness/goal evidence is
 * T02.5.
 *
 * @module lib/workflow/ir
 */

import type { WorkflowCondition } from './conditions'
import type { SemanticLocator } from './element-fingerprint'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'
import { targetSpecFromSemantic } from './element-fingerprint'

// --- Version --------------------------------------------------------------------

export const IR_VERSION = 1

// --- Semantic vocabulary --------------------------------------------------------

/**
 * Semantic actions — what a step MEANS, independent of which block implements it.
 */
export type SemanticAction =
  | { kind: 'navigate'; to?: string }
  | { kind: 'click' }
  | { kind: 'fill'; value?: string }
  | { kind: 'select'; option?: string }
  | { kind: 'check'; checked?: boolean }
  | { kind: 'submit' }
  | { kind: 'read-text' }
  | { kind: 'read-attribute'; name?: string }
  | { kind: 'wait-element' }
  | { kind: 'wait-time'; ms?: number }
  | { kind: 'scroll'; amount?: number }
  | { kind: 'press-key'; key?: string }
  | { kind: 'hover' }
  | { kind: 'element-exists' }
  | { kind: 'execute-js'; code?: string }

export const SEMANTIC_ACTION_KINDS: readonly SemanticAction['kind'][] = [
  'navigate',
  'click',
  'fill',
  'select',
  'check',
  'submit',
  'read-text',
  'read-attribute',
  'wait-element',
  'wait-time',
  'scroll',
  'press-key',
  'hover',
  'element-exists',
  'execute-js',
]

/** A reference to a value: a variable, an IR input, or a literal. */
export type ValueRef =
  | { ref: string }
  | { input: string }
  | { literal: unknown }

/** The semantic target of an element-acting step. */
export interface SemanticTarget {
  /** The recorded semantic identity. */
  semantic?: SemanticLocator
  /** A previously observed selector, kept as a hint (never the only evidence). */
  selectorHint?: string
}

/** Checkable facts at the IR level (same vocabulary as workflow conditions). */
export type ConditionIR = WorkflowCondition

/** The goal contract at IR level. */
export interface GoalIR {
  summary: string
  successConditions?: ConditionIR[]
  terminalStateConditions?: ConditionIR[]
}

/** One workflow input declared by the IR. */
export interface InputIR {
  name: string
  description?: string
  required?: boolean
  defaultValue?: string
  secret?: boolean
}

/** Side-effect levels (mirror the reliability contract's idempotency). */
export type IdempotencyIR = 'safe' | 'conditional' | 'unsafe'

/** One IR step. */
export interface WorkflowStepIR {
  id: string
  /** Why this step exists (intent language; drives debug diagnosis). */
  intent: string
  action: SemanticAction
  target?: SemanticTarget
  inputs?: ValueRef[]
  outputs?: ValueRef[]
  preconditions?: ConditionIR[]
  postconditions?: ConditionIR[]
  idempotency: IdempotencyIR
  /** Trace events this step was derived from (provenance). */
  sourceTraceIds: string[]
}

/** A directed edge between IR steps. */
export interface StepEdgeIR {
  id: string
  source: string
  target: string
  /** Branch label for conditional steps. */
  branch?: 'true' | 'false'
}

/** IR metadata. */
export interface WorkflowIRMetadata {
  originUrl?: string
  createdAt?: number
}

/** The complete intermediate representation. */
export interface WorkflowIR {
  version: number
  goal: GoalIR
  inputs: InputIR[]
  steps: WorkflowStepIR[]
  edges: StepEdgeIR[]
  metadata: WorkflowIRMetadata
}

// --- Structural validation ------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSemanticAction(value: unknown): value is SemanticAction {
  return (
    isRecord(value) &&
    typeof value['kind'] === 'string' &&
    (SEMANTIC_ACTION_KINDS as readonly string[]).includes(value['kind'])
  )
}

function isIdempotencyIR(value: unknown): value is IdempotencyIR {
  return value === 'safe' || value === 'conditional' || value === 'unsafe'
}

/**
 * Structural validator for an untrusted IR. Checks the version, the goal
 * summary, step uniqueness, action vocabulary and edge endpoints.
 */
export function isWorkflowIR(value: unknown): value is WorkflowIR {
  if (!isRecord(value)) return false
  if (value['version'] !== IR_VERSION) return false
  const goal = value['goal']
  if (!isRecord(goal) || typeof goal['summary'] !== 'string' || !goal['summary'].trim()) {
    return false
  }
  const steps = value['steps']
  if (!Array.isArray(steps) || steps.length === 0) return false
  const ids = new Set<string>()
  for (const step of steps) {
    if (!isRecord(step)) return false
    if (typeof step['id'] !== 'string' || !step['id']) return false
    if (ids.has(step['id'])) return false
    ids.add(step['id'])
    if (typeof step['intent'] !== 'string') return false
    if (!isSemanticAction(step['action'])) return false
    if (!isIdempotencyIR(step['idempotency'])) return false
    if (!Array.isArray(step['sourceTraceIds'])) return false
  }
  const edges = value['edges']
  if (!Array.isArray(edges)) return false
  for (const edge of edges) {
    if (!isRecord(edge)) return false
    if (typeof edge['source'] !== 'string' || typeof edge['target'] !== 'string') return false
    if (!ids.has(edge['source']) || !ids.has(edge['target'])) return false
  }
  if (!Array.isArray(value['inputs'])) return false
  return isRecord(value['metadata'])
}

/** Parse untrusted JSON text into an IR; returns null on any invalid input. */
export function workflowIRFromJSON(text: string): WorkflowIR | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return isWorkflowIR(parsed) ? parsed : null
  } catch {
    return null
  }
}

// --- Normalization --------------------------------------------------------------

/**
 * Return a structurally clean copy of an IR: only the recognized fields.
 * Does not change semantics — unknown optional fields are dropped.
 */
export function normalizeIR(ir: WorkflowIR): WorkflowIR {
  return structuredClone(ir)
}

// --- Minimal compiler -----------------------------------------------------------

let nodeSeq = 0
function uniqueId(prefix: string): string {
  nodeSeq = (nodeSeq + 1) % Number.MAX_SAFE_INTEGER
  return `${prefix}-${nodeSeq}`
}

/** Map a semantic action kind to its implementing block id. */
function blockIdForAction(action: SemanticAction): string {
  switch (action.kind) {
    case 'navigate':
      return 'new-tab'
    case 'click':
      return 'event-click'
    case 'fill':
    case 'select':
    case 'check':
    case 'submit':
      return 'forms'
    case 'read-text':
      return 'get-text'
    case 'read-attribute':
      return 'attribute-value'
    case 'wait-element':
      return 'delay'
    case 'wait-time':
      return 'delay'
    case 'scroll':
      return 'element-scroll'
    case 'press-key':
      return 'press-key'
    case 'hover':
      return 'hover-element'
    case 'element-exists':
      return 'element-exists'
    case 'execute-js':
      return 'javascript-code'
  }
}

/** The minimal block params for one IR step (structural, not capability-driven). */
function paramsForStep(step: WorkflowStepIR): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  const semantic = step.target?.semantic
  if (semantic) {
    const spec = targetSpecFromSemantic(semantic)
    if (spec) params['target'] = { primary: spec, fallbacks: [] }
  }
  if (step.target?.selectorHint) params['selector'] = step.target.selectorHint

  switch (step.action.kind) {
    case 'navigate':
      params['url'] = step.action.to ?? ''
      break
    case 'fill':
      params['action'] = 'fill'
      params['value'] = step.action.value ?? ''
      break
    case 'select':
      params['action'] = 'select'
      params['value'] = step.action.option ?? ''
      break
    case 'check':
      params['action'] = 'checkbox'
      params['value'] = step.action.checked ?? true
      break
    case 'submit':
      params['action'] = 'submit'
      break
    case 'read-text':
      params['action'] = 'text'
      break
    case 'wait-time':
      params['timeout'] = step.action.ms ?? 1000
      break
    default:
      break
  }
  return params
}

/**
 * Compile a validated IR into a Workflow with a trigger head.
 *
 * Steps are emitted in declared order; when the IR carries no explicit edges
 * (a linear IR), consecutive nodes are chained. Provenance and origin are
 * stamped so the generated workflow behaves as an AI-generated graph.
 */
export function compileIR(ir: WorkflowIR): Workflow {
  const now = Date.now()
  const nodes: WorkflowNode[] = []
  const edges: WorkflowEdge[] = []

  const triggerId = 'trigger'
  nodes.push({
    id: triggerId,
    label: 'trigger',
    position: { x: 160, y: 0 },
    data: { blockId: 'trigger', type: 'manual', description: '' },
  })

  ir.steps.forEach((step, index) => {
    const blockId = blockIdForAction(step.action)
    nodes.push({
      id: step.id,
      label: blockId,
      position: { x: 160, y: 80 + index * 140 },
      data: { blockId, description: step.intent, ...paramsForStep(step) },
    })
  })

  const hasExplicitEdges = ir.edges.length > 0
  if (hasExplicitEdges) {
    // An explicit edge out of the first step replaces the trigger chain.
    const firstStepId = ir.steps[0]!.id
    edges.push({
      id: uniqueId('edge'),
      source: triggerId,
      target: firstStepId,
      sourceHandle: 'trigger-output-1',
      targetHandle: `${blockIdForAction(ir.steps[0]!.action)}-input-1`,
    })
    for (const stepEdge of ir.edges) {
      const sourceStep = ir.steps.find((s) => s.id === stepEdge.source)!
      const targetStep = ir.steps.find((s) => s.id === stepEdge.target)!
      edges.push({
        id: stepEdge.id,
        source: stepEdge.source,
        target: stepEdge.target,
        sourceHandle: `${blockIdForAction(sourceStep.action)}-output-1`,
        targetHandle: `${blockIdForAction(targetStep.action)}-input-1`,
      })
    }
  } else {
    // Linear chain: trigger → step 1 → step 2 …
    let prevId = triggerId
    let prevBlock = 'trigger'
    for (const step of ir.steps) {
      const blockId = blockIdForAction(step.action)
      edges.push({
        id: uniqueId('edge'),
        source: prevId,
        target: step.id,
        sourceHandle: `${prevBlock}-output-1`,
        targetHandle: `${blockId}-input-1`,
      })
      prevId = step.id
      prevBlock = blockId
    }
  }

  return {
    id: uniqueId('workflow'),
    name: ir.goal.summary,
    description: ir.goal.summary,
    createdAt: now,
    updatedAt: now,
    drawflow: { nodes, edges },
    trigger: { type: 'manual', enabled: true },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
      provenance: 'chat-generate',
      ...(ir.metadata.originUrl ? { generationOriginUrl: ir.metadata.originUrl } : {}),
    },
  }
}
