/**
 * Barrel for the unified workflow repair engine.
 *
 * @module background/workflow-engine/repair
 */

export { WorkflowRepairEngine } from './repair-engine'
export type { RepairEngineDeps, RepairProposalProvider } from './repair-engine'
export { analyzeFailure } from './failure-analyzer'
export { canonicalizeAnalysis, rankCandidates, sameAnalysis } from './root-cause-analyzer'
export {
  planReplay,
  executeReplay,
  type ReplayDecision,
  type ReplayKind,
  type ReplayRunner,
} from './replay-engine'
export {
  buildVerificationResult,
  verifyThroughRunner,
  type RunnerOutcome,
  type WorkflowRunner,
} from './verification-runner'
export {
  buildRepairContext,
  buildRepairMessages,
  parseRepairProposal,
  createRepairAgent,
  REPAIR_SYSTEM_PROMPT,
} from './repair-agent'
export type { RepairChatMessage, RepairCompletion } from './repair-agent'
export {
  runUnifiedDebug,
  type UnifiedDebugMode,
  type UnifiedDebugDeps,
  type UnifiedDebugResult,
} from './unified-debug'
export {
  finalizeGeneratedWorkflow,
  type GenerationRepairStatus,
  type GenerationRepairDeps,
  type GenerationRepairResult,
} from './generation-repair'
export { createBackgroundRunner, createBackgroundCheckpointAdapter } from './background-runner'
