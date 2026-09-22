/**
 * Patch policy (spec §7, §8 · Phase 4).
 *
 * Derives the CONSTRAINT under which the AI may propose changes:
 *
 *   - allowedNodeIds    — root-cause nodes + direct consumers that must change
 *     to keep the data flow valid;
 *   - allowedParamPaths — per node, the parameter paths the block semantics
 *     permit;
 *   - protected paths   — blockId / disableBlock / goal / trigger / onError
 *     manipulation to forge success.
 *
 * Also holds the {@link ReplaySafety} metadata per block (spec §9.3) and the
 * transform block classification reused by the provenance layer.
 *
 * Pure table logic.
 *
 * @module lib/workflow/repair/patch-policy
 */

import { isDataParam } from '../data-params'
import type { FailureAnalysis, ReplaySafety } from './types'
import type { Workflow, WorkflowNode } from '../types'

/** Param paths never modifiable unless the analysis explicitly authorizes. */
export const PROTECTED_PARAMS: ReadonlySet<string> = new Set([
  'blockId',
  'disableBlock',
  'onError',
  'goal',
  'goalSpec',
  'postconditions',
  'preconditions',
])

/**
 * Side-effect / replay safety per block id (spec §9.3).
 *
 * Unknown blocks default to REQUIRES_STATE_CHECK — the conservative choice:
 * a block not on the safe list may have effects the patch loop cannot prove.
 */
const REPLAY_SAFETY: Readonly<Record<string, ReplaySafety>> = {
  delay: 'SAFE',
  'get-text': 'SAFE',
  'read-page': 'SAFE',
  'attribute-value': 'SAFE',
  'element-exists': 'SAFE',
  conditions: 'SAFE',
  'take-screenshot': 'IDEMPOTENT',
  'new-tab': 'IDEMPOTENT',
  'switch-tab': 'IDEMPOTENT',
  'close-tab': 'IDEMPOTENT',
  'loop-data': 'SAFE',
  'loop-elements': 'SAFE',
  'repeat-task': 'REQUIRES_STATE_CHECK',
  'while-loop': 'REQUIRES_STATE_CHECK',
  'set-variable': 'SAFE',
  'regex-variable': 'SAFE',
  'slice-variable': 'SAFE',
  'increase-variable': 'SAFE',
  'data-mapping': 'SAFE',
  'sort-data': 'SAFE',
  'export-data': 'SAFE',
  'save-local': 'IDEMPOTENT',
  clipboard: 'SAFE',
  // Irreversible business effects.
  forms: 'REQUIRES_STATE_CHECK',
  'event-click': 'REQUIRES_STATE_CHECK',
  click: 'REQUIRES_STATE_CHECK',
  'press-key': 'REQUIRES_STATE_CHECK',
  webhook: 'REQUIRES_STATE_CHECK',
  'upload-file': 'REQUIRES_STATE_CHECK',
  cookie: 'REQUIRES_STATE_CHECK',
  notification: 'REQUIRES_CONFIRMATION',
}

/** Blocks whose effects can never be automatically replayed. */
const FORBIDDEN_BLOCKS: ReadonlySet<string> = new Set<string>([])

/** Replay safety of a block id, conservatively defaulting. */
export function replaySafetyOfBlock(blockId: string, data?: Record<string, unknown>): ReplaySafety {
  const explicit = data?.['replaySafety']
  if (
    explicit === 'SAFE' ||
    explicit === 'IDEMPOTENT' ||
    explicit === 'REQUIRES_STATE_CHECK' ||
    explicit === 'REQUIRES_CONFIRMATION' ||
    explicit === 'FORBIDDEN_AUTO_REPLAY'
  ) {
    return explicit
  }
  if (FORBIDDEN_BLOCKS.has(blockId)) return 'FORBIDDEN_AUTO_REPLAY'
  return REPLAY_SAFETY[blockId] ?? 'REQUIRES_STATE_CHECK'
}

/** Replay safety of a placed node. */
export function replaySafetyOfNode(node: WorkflowNode): ReplaySafety {
  const blockId =
    typeof node.data?.['blockId'] === 'string' ? (node.data['blockId'] as string) : node.label
  return replaySafetyOfBlock(blockId, node.data ?? {})
}

/** Block id of a node from data, falling back to label. */
function blockIdOf(node: WorkflowNode): string {
  const raw = node.data?.['blockId']
  return typeof raw === 'string' && raw ? raw : node.label
}

/**
 * The nodes a patch may touch:
 *
 *   - every root-cause node;
 *   - when the root is upstream, the failed node IF the change is to a consumer
 *     reference bound to the root-cause variable (§8.1);
 *   - the failed node when it is itself the root.
 *
 * Order is deterministic (sorted).
 */
export function allowedNodeIdsOf(analysis: FailureAnalysis): string[] {
  const allowed = new Set<string>(analysis.rootCauseNodeIds)
  if (analysis.repairTarget === 'UPSTREAM_NODE' || analysis.repairTarget === 'MULTIPLE_NODES') {
    // The failed (symptom) node is allowed ONLY for consumer-reference edits;
    // the patch engine re-checks the specific path. Include it so a valid
    // REPLACE_INPUT_REF can apply.
    allowed.add(analysis.failedNodeId)
  }
  return [...allowed].filter(Boolean).sort()
}

/**
 * The parameter paths a node permits, from its block definition plus the
 * data/structural classification. Protects identity fields by default.
 */
export function allowedParamPathsOf(
  workflow: Workflow,
  analysis: FailureAnalysis,
  nodeId: string,
): string[] {
  const node = workflow.drawflow.nodes.find((item) => item.id === nodeId)
  if (!node) return []
  void blockIdOf
  // The catalog entry carries no per-param definitions; allowed paths derive
  // from the node's CURRENT, non-protected keys, so a SET_PARAM only reaches
  // a parameter the block actually has.
  const paths = new Set<string>()
  for (const key of Object.keys(node.data ?? {})) {
    if (PROTECTED_PARAMS.has(key)) continue
    paths.add(key)
  }

  // The symptom node is restricted to the consumer reference paths bound to
  // an abnormal root-cause variable — it is not generally editable.
  if (nodeId === analysis.failedNodeId && !analysis.rootCauseNodeIds.includes(nodeId)) {
    const abnormal = new Set(
      analysis.variableEvidence
        .filter((row) => row.kind === 'MISSING' || row.kind === 'EMPTY' || row.kind === 'TYPE')
        .map((row) => row.variable),
    )
    const permitted = new Set<string>()
    for (const path of paths) {
      const value = node.data?.[path]
      if (
        typeof value === 'string' &&
        [...value.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].some((match) =>
          abnormal.has(match[1]!.split('.')[0]!),
        )
      ) {
        permitted.add(path)
      }
    }
    return [...permitted].sort()
  }

  return [...paths].sort()
}

/** Is `path` a business-data param for this block (vs structural)? */
export function isDataPath(blockId: string, path: string): boolean {
  return isDataParam(blockId, path.split('.')[0] ?? path)
}
