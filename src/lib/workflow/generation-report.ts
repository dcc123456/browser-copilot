/**
 * Generation pipeline stage reporting (spec §6 · Commit 07).
 *
 * The generation path is a formal pipeline:
 *
 * ```text
 * Normalize → Generalize Inputs → Harden Targets → Build Reliability
 *          → Static Validate → Independent Verify
 * ```
 *
 * Every stage produces one {@link GenerationStageReport} describing what it
 * did, so the generation UI can show the work instead of a single
 * "generation succeeded" line.
 *
 * Pure data module: no `chrome`, no DOM, no I/O.
 *
 * @module lib/workflow/generation-report
 */

export type GenerationStageId =
  | 'NORMALIZE'
  | 'GENERALIZE_INPUTS'
  | 'HARDEN_TARGETS'
  | 'BUILD_RELIABILITY'
  | 'STATIC_VALIDATE'
  | 'INDEPENDENT_VERIFY'

export type GenerationStageStatus = 'ok' | 'warn' | 'skipped' | 'pending'

export interface GenerationStageReport {
  stage: GenerationStageId
  status: GenerationStageStatus
  /** Short human-readable summary of what the stage did (dev/log neutral). */
  summary: string
  /** Optional structured counts, when the stage has them. */
  counts?: Record<string, number>
}

/** Stable display order of the pipeline stages. */
export const GENERATION_STAGE_ORDER: readonly GenerationStageId[] = [
  'NORMALIZE',
  'GENERALIZE_INPUTS',
  'HARDEN_TARGETS',
  'BUILD_RELIABILITY',
  'STATIC_VALIDATE',
  'INDEPENDENT_VERIFY',
]

/** Build a report for a stage. */
export function stageReport(
  stage: GenerationStageId,
  status: GenerationStageStatus,
  summary: string,
  counts?: Record<string, number>,
): GenerationStageReport {
  return { stage, status, summary, ...(counts ? { counts } : {}) }
}
