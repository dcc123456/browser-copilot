/**
 * Generation coverage bookkeeping (spec B1).
 *
 * A generated workflow can be "complete" to the model while the draft is
 * missing whole steps: an operator call that failed during generation leaves
 * no node behind (`executeOperatorNode` → `status:'failed'` → the bridge
 * returns without appending), and the model is not forced to retry it before
 * declaring the task done. That is a silent hole — the graph simply has fewer
 * steps than the task required, and every replay fails on the page state it
 * assumed would exist.
 *
 * This module tracks, per conversation, which operator calls failed during
 * generation and never recovered with a successful retry; composes the
 * bilingual `saveWarnings` lines the save card surfaces; and (for a fully
 * "executed" draft) emits nothing.
 *
 * Pure data + string building with no `chrome` dependency, so both the
 * execution bridge (`background/operator-tool-run`) and the compose path
 * (`background/operator-tool-handler`) can import it without a cycle, and so
 * the warning text is unit-testable.
 *
 * @module lib/workflow/generation-coverage
 */

import { operatorExecClass } from './operator-class'
import { BLOCK_BY_ID } from './blocks/palette'

/** Display name of a block, for the warning copy. */
export function coverageBlockName(blockId: string): string {
  return BLOCK_BY_ID.get(blockId)?.name ?? blockId
}

/**
 * In-memory on purpose, like the selector-trace ring: a soft coverage warning
 * is best-effort. If the service worker is evicted between a failure and the
 * save, the warning is simply not shown — saving is never blocked (§B1 soft).
 */
const failedBlocks = new Map<string, Set<string>>()

/** Optional cap so abandoned conversations cannot grow the map without bound. */
const FAILED_BLOCKS_CAP = 64

function failedSetFor(conversationId: string): Set<string> {
  const existing = failedBlocks.get(conversationId)
  if (existing) return existing
  const set = new Set<string>()
  failedBlocks.set(conversationId, set)
  while (failedBlocks.size > FAILED_BLOCKS_CAP) {
    const oldest = failedBlocks.keys().next().value
    if (oldest === undefined || oldest === conversationId) break
    failedBlocks.delete(oldest)
  }
  return set
}

/** Record that an operator call of `blockId` failed during generation. */
export function markOperatorFailure(conversationId: string, blockId: string): void {
  failedSetFor(conversationId).add(blockId)
}

/**
 * A successful retry of the same block fills the hole it left. A later failure
 * of a *different* element acts on the same block id, so this is approximate —
 * acceptable because the warning is informational, not a run gate.
 */
export function markOperatorRecovery(conversationId: string, blockId: string): void {
  failedBlocks.get(conversationId)?.delete(blockId)
}

/** Drop a conversation's coverage state (when its draft is cleared). */
export function forgetCoverage(conversationId: string): void {
  failedBlocks.delete(conversationId)
}

/** Block ids that failed during generation and were never recovered. */
export function failedBlockIdsOf(conversationId: string): string[] {
  return [...(failedBlocks.get(conversationId) ?? [])]
}

/** Whether a block is recorded without running during generation. */
export function isRecordOnlyBlock(blockId: string): boolean {
  return operatorExecClass(blockId) === 'record-only'
}

/** Inputs the compose path assembles from the draft + the coverage tracker. */
export interface CoverageWarningInput {
  /** Blocks that failed during generation and never recovered. */
  failedBlockIds: string[]
  /** Record-only action blocks left in the draft (run first on replay). */
  recordOnlyBlockIds: string[]
  /** The draft was compiled from action history (path B), not live-verified. */
  fromHistory: boolean
}

/**
 * Compose the bilingual `saveWarnings` lines for a coverage gap. Empty when the
 * session recovered every failure and produced a live-verified, fully-executed
 * draft (a normal, clean generation).
 */
export function coverageWarningLines(input: CoverageWarningInput): string[] {
  const lines: string[] = []
  const failedNames = input.failedBlockIds.map(coverageBlockName)
  if (failedNames.length > 0) {
    lines.push(
      `Generation coverage gap: ${failedNames.length} operator step(s) failed during generation ` +
        `and were not retried (${failedNames.join(', ')}), so the workflow is missing them. ` +
        `生成覆盖缺口：${failedNames.length} 个算子步骤生成时失败且未重试成功（${failedNames.join('、')}），工作流缺少这些步骤。`,
    )
  }
  const recordOnlyNames = input.recordOnlyBlockIds.map(coverageBlockName)
  if (recordOnlyNames.length > 0) {
    lines.push(
      `Recorded without running: ${recordOnlyNames.length} step(s) were captured but not executed ` +
        `during generation (${recordOnlyNames.join(', ')}); they run for the first time on replay. ` +
        `生成期未实跑：${recordOnlyNames.length} 个步骤仅记录未执行（${recordOnlyNames.join('、')}），回放时才首次运行。`,
    )
  }
  if (input.fromHistory) {
    lines.push(
      'Generated from action history (lower fidelity): selectors and inputs were compiled from ' +
        'recorded steps rather than live-verified. ' +
        '由操作历史编译生成（低保真）：选择器与输入来自历史步骤推演，未经实时校验。',
    )
  }
  return lines
}