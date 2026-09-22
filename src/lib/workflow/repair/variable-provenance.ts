/**
 * Variable provenance (spec §5.2).
 *
 * Answers "where does this variable come from?" from the static graph plus,
 * when available, the actual execution trace. Sources:
 *
 *   - WORKFLOW_INPUT — declared on the trigger (`trigger.parameters`);
 *   - NODE_OUTPUT    — produced by a block's `variableName`;
 *   - ENGINE_ALIAS   — fixed names the engine writes (`lastText`, …);
 *   - TRANSFORM      — produced by a transform block from another variable;
 *   - LOOP_CONTEXT   — `loopIndex` / `loopItem` / `loopElementSelector`;
 *   - UNKNOWN        — nothing statically produces it (dangling).
 *
 * Pure analysis — no browser / provider.
 *
 * @module lib/workflow/repair/variable-provenance
 */

import type { ExecutionTrace, VariableProvenance } from './types'
import type { Workflow, WorkflowNode } from '../types'

/** Fixed variable names the engine itself provides (mirrors integrity.ts). */
export const ENGINE_ALIASES: Readonly<Map<string, VariableProvenance>> = new Map(
  [
    'refData',
    'dataTable',
    'lastText',
    'lastValue',
    'lastExport',
    'lastMappedData',
    'lastResult',
    'lastState',
    'lastAIResponse',
  ].map((name) => [name, { variable: name, producerKind: 'ENGINE_ALIAS' }]),
)

/** Loop-context variables published by the run loop. */
export const LOOP_CONTEXT_NAMES: ReadonlyMap<string, VariableProvenance> = new Map(
  ['loopIndex', 'loopItem', 'loopElementSelector'].map((name) => [
    name,
    { variable: name, producerKind: 'LOOP_CONTEXT' },
  ]),
)

/**
 * Block ids that TRANSFORM one or more input variables into a new one.
 *
 * The `sourceVariable` is derived from the node's params (see
 * {@link transformSourceOf}); the node's `variableName` is the output.
 */
export const TRANSFORM_BLOCK_IDS: ReadonlySet<string> = new Set([
  'set-variable',
  'data-mapping',
  'regex-variable',
  'slice-variable',
  'increase-variable',
  'conditions',
])

/** Candidate param keys a transform reads its source variable from. */
const TRANSFORM_SOURCE_KEYS: readonly string[] = [
  'variable',
  'sourceVariable',
  'fromVariable',
  'inputVariable',
  'variableId',
  'data',
  'sources',
  'value',
]

/** Read a transform node's source variable name from its params, if any. */
export function transformSourceOf(node: WorkflowNode): string | undefined {
  const data = node.data ?? {}
  for (const key of TRANSFORM_SOURCE_KEYS) {
    const raw = data[key]
    if (typeof raw === 'string') {
      const match = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/.exec(raw)
      if (match) return match[1]!.split('.')[0]
      if (raw.trim() !== '' && key !== 'value') return raw.trim()
    }
  }
  return undefined
}

/** Names the workflow declares as inputs (node + top-level trigger mirror). */
export function workflowInputNames(workflow: Workflow): Set<string> {
  const names = new Set<string>()
  const collect = (parameters: unknown): void => {
    if (!Array.isArray(parameters)) return
    for (const parameter of parameters) {
      const name = (parameter as { name?: unknown } | null)?.name
      if (typeof name === 'string' && name.trim()) names.add(name.trim())
    }
  }
  for (const node of workflow.drawflow.nodes) {
    if (node.data?.['blockId'] === 'trigger') collect(node.data['parameters'])
  }
  collect(workflow.trigger?.parameters)
  return names
}

/** Is this the trigger head node? */
function isTrigger(node: WorkflowNode): boolean {
  return node.data?.['blockId'] === 'trigger'
}

/**
 * Build the static provenance index: variable name → every statically-possible
 * producer, sorted by node id for deterministic output.
 */
export function buildProvenanceIndex(workflow: Workflow): Map<string, VariableProvenance[]> {
  const index = new Map<string, VariableProvenance[]>()
  const add = (provenance: VariableProvenance): void => {
    const list = index.get(provenance.variable)
    if (list) list.push(provenance)
    else index.set(provenance.variable, [provenance])
  }

  for (const alias of ENGINE_ALIASES.values()) add(alias)
  for (const loop of LOOP_CONTEXT_NAMES.values()) add(loop)
  for (const name of workflowInputNames(workflow)) {
    add({ variable: name, producerKind: 'WORKFLOW_INPUT' })
  }

  for (const node of workflow.drawflow.nodes) {
    if (isTrigger(node)) continue
    const variableName = node.data?.['variableName']
    if (typeof variableName !== 'string' || !variableName.trim()) continue
    const output = variableName.trim()
    const blockId = typeof node.data['blockId'] === 'string' ? (node.data['blockId'] as string) : ''
    if (TRANSFORM_BLOCK_IDS.has(blockId)) {
      add({
        variable: output,
        producerNodeId: node.id,
        producerKind: 'TRANSFORM',
        sourceVariable: transformSourceOf(node),
      })
    } else {
      add({ variable: output, producerNodeId: node.id, producerKind: 'NODE_OUTPUT' })
    }
  }

  for (const list of index.values()) {
    list.sort((a, b) => (a.producerNodeId ?? '').localeCompare(b.producerNodeId ?? ''))
  }
  return index
}

/**
 * Provenance of a variable, using the trace to disambiguate multi-producer
 * cases by "last node that actually wrote it". Falls back to the static list
 * when no trace evidence applies.
 */
export function provenanceOf(
  variable: string,
  index: ReadonlyMap<string, VariableProvenance[]>,
  trace?: ExecutionTrace,
): VariableProvenance[] {
  const staticList = index.get(variable) ?? []
  if (!trace) return staticList

  // Actual producers from the trace, in the order they executed.
  const actual = trace.nodeExecutions
    .filter(
      (record) =>
        record.status !== 'skipped' &&
        record.outputVariables.some((output) => output.variable === variable),
    )
    .map((record) => ({
      variable,
      producerNodeId: record.nodeId,
      producerKind: staticList.some(
        (item) => item.producerNodeId === record.nodeId && item.producerKind === 'TRANSFORM',
      )
        ? ('TRANSFORM' as const)
        : ('NODE_OUTPUT' as const),
      sourceVariable: staticList.find((item) => item.producerNodeId === record.nodeId)
        ?.sourceVariable,
    }))

  if (actual.length === 0) return staticList
  // Prefer the last actual producer, but keep every static candidate that the
  // trace agrees with so the analyzer can report ambiguity honestly.
  const last = actual[actual.length - 1]!
  return [last, ...staticList.filter((item) => item.producerNodeId !== last.producerNodeId)]
}
