/**
 * Repair agent (spec §7).
 *
 * Builds the structured, minimized, redacted {@link RepairContext} for the AI
 * provider, invokes it, and parses the JSON response into a
 * {@link WorkflowPatchSet}. The model output NEVER lands directly: parse
 * failures, schema violations, out-of-scope node/path edits and evidence-less
 * operations are dropped here, and the Patch Engine re-checks everything.
 *
 * The chat/prompt construction stays here (background layer) while the
 * context data comes from the pure policy/engine.
 *
 * @module background/workflow-engine/repair/repair-agent
 */

import { PatchEngine } from '../../../lib/workflow/repair/patch-engine'
import { buildGoalRepairContext, renderGoalRepairContext } from '../../../lib/workflow/goal-repair-context'
import { allowedParamPathsOf } from '../../../lib/workflow/repair/patch-policy'
import type {
  FailureAnalysis,
  RepairContext,
  WorkflowPatchOperation,
  WorkflowPatchSet,
} from '../../../lib/workflow/repair/types'
import type { ExecutionTrace } from '../../../lib/workflow/repair/types'
import type { Workflow } from '../../../lib/workflow/types'

/** Chat message the completion provider accepts. */
export interface RepairChatMessage {
  role: 'system' | 'user'
  content: string
}

/** Completion call: returns the raw assistant text. */
export type RepairCompletion = (messages: RepairChatMessage[]) => Promise<string>

/**
 * Build the repair context (spec §7). The variable evidence carries only
 * existence / type / length / emptiness; page evidence only the local
 * locator candidates. No raw secret value is present.
 */
export function buildRepairContext(
  workflow: Workflow,
  trace: ExecutionTrace,
  analysis: FailureAnalysis,
  history: RepairContext['repairHistory'] = [],
): RepairContext {
  const patchEngine = new PatchEngine()
  const allowedNodeIds = patchEngine.allowedNodeIds(analysis)
  const failedNode = workflow.drawflow.nodes.find((node) => node.id === analysis.failedNodeId)
  return {
    failedNodeId: analysis.failedNodeId,
    rootCauseNodeIds: analysis.rootCauseNodeIds,
    failureType: analysis.failureType,
    dependencyChain: analysis.dependencyChain,
    variableEvidence: analysis.variableEvidence,
    pageEvidence: analysis.pageEvidence,
    allowedNodeIds,
    allowedParamPaths: (() => {
      const out: Record<string, string[]> = {}
      for (const nodeId of allowedNodeIds) {
        out[nodeId] = allowedParamPathsOf(workflow, analysis, nodeId)
      }
      return out
    })(),
    recentTrace: trace.events.slice(-20),
    repairHistory: history,
    ...(failedNode
      ? { goalRepairContext: buildGoalRepairContext(workflow, failedNode) }
      : {}),
  }
}

/** System instructions enforcing the JSON contract. */
export const REPAIR_SYSTEM_PROMPT = `You are a workflow repair agent. You propose a MINIMAL, atomic patch set.

Rules:
- Modify ONLY nodes in allowedNodeIds and param paths in allowedParamPaths.
- Every operation must cite evidence ids and include the current value in "before".
- Do not change blockId, disableBlock, onError, goal/trigger, or conditions that define success.
- Do not introduce static bulk page content; keep {{variable}} references.
- If no safe minimal patch exists, return {"operations": []}.

Respond with ONLY a JSON object matching:
{"patchSetId": string, "reason": string, "confidence": number,
 "expectedEffect": string, "replayFromNodeId"?: string,
 "operations": [{"operationId": string, "nodeId": string,
   "kind": "SET_PARAM"|"REMOVE_PARAM"|"REPLACE_TARGET"|"REPLACE_INPUT_REF"|"REPLACE_OUTPUT",
   "path": string, "before": unknown, "after": unknown,
   "reason": string, "evidenceIds": string[]}]}`

/** Assemble the prompt messages for a repair context. */
export function buildRepairMessages(context: RepairContext): RepairChatMessage[] {
  return [
    { role: 'system', content: REPAIR_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        context.goalRepairContext ? renderGoalRepairContext(context.goalRepairContext) : '',
        `Repair context (redacted):\n${JSON.stringify(
          { ...context, ...(context.goalRepairContext ? { goalRepairContext: '[rendered above]' } : {}) },
          null,
          2,
        )}`,
      ].filter(Boolean).join('\n\n'),
    },
  ]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse + structurally validate the model output.
 *
 * Returns null on any parse/schema failure; operations outside the allowed
 * nodes/paths or without evidence are removed, and an empty remainder yields
 * null. This is defense before the Patch Engine, which still re-validates.
 */
export function parseRepairProposal(raw: string, context: RepairContext): WorkflowPatchSet | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJson(raw))
  } catch {
    return null
  }
  if (!isObject(parsed)) return null
  const operationsRaw = parsed['operations']
  if (!Array.isArray(operationsRaw)) return null

  const allowedNodes = new Set(context.allowedNodeIds)
  const operations: WorkflowPatchOperation[] = []
  const operationIds = new Set<string>()

  for (const item of operationsRaw) {
    if (!isObject(item)) return null
    const operationId = String(item['operationId'] ?? `op-${operations.length}`)
    if (operationIds.has(operationId)) return null
    operationIds.add(operationId)
    const nodeId = String(item['nodeId'] ?? '')
    const path = String(item['path'] ?? '')
    const kind = item['kind']
    if (
      kind !== 'SET_PARAM' &&
      kind !== 'REMOVE_PARAM' &&
      kind !== 'REPLACE_TARGET' &&
      kind !== 'REPLACE_INPUT_REF' &&
      kind !== 'REPLACE_OUTPUT'
    ) {
      return null
    }
    if (!allowedNodes.has(nodeId)) return null
    const permitted = new Set(context.allowedParamPaths[nodeId] ?? [])
    if (!permitted.has(path.split('.')[0] ?? path)) return null
    const evidenceIds = Array.isArray(item['evidenceIds'])
      ? (item['evidenceIds'] as unknown[]).map(String)
      : []
    if (evidenceIds.length === 0) return null
    operations.push({
      operationId,
      nodeId,
      kind,
      path,
      ...(item['before'] !== undefined ? { before: item['before'] } : {}),
      ...(item['after'] !== undefined ? { after: item['after'] } : {}),
      reason: String(item['reason'] ?? ''),
      evidenceIds,
    })
  }

  if (operations.length === 0) return null
  const confidence = Number(parsed['confidence'] ?? 0)
  return {
    patchSetId: String(parsed['patchSetId'] ?? `patch-${Date.now()}`),
    analysisId: '',
    operations,
    reason: String(parsed['reason'] ?? ''),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    expectedEffect: String(parsed['expectedEffect'] ?? ''),
    ...(parsed['replayFromNodeId'] ? { replayFromNodeId: String(parsed['replayFromNodeId']) } : {}),
  }
}

/** Extract the first JSON object from a possibly fenced / noisy response. */
function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced ? fenced[1]! : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return body
  return body.slice(start, end + 1)
}

/** Build a provider: context → completion → parsed patch set (or null). */
export function createRepairAgent(completion: RepairCompletion): {
  propose(context: RepairContext): Promise<WorkflowPatchSet | null>
} {
  return {
    async propose(context) {
      const raw = await completion(buildRepairMessages(context))
      return parseRepairProposal(raw, context)
    },
  }
}
