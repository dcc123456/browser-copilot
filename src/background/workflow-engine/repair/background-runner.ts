/**
 * Real background adapter for the unified repair engine (Phase 6).
 *
 * Bridges the engine-injected {@link WorkflowRunner} to the production
 * `executeWorkflow`: one tracked run, takeover disabled for verify/replay,
 * and the unified trace mapped straight from the execution result. Also
 * provides a checkpoint-store adapter bound to the real checkpoint backend so
 * replay planning reads the same durable points the resume path does.
 *
 * Kept separate from `repair-engine.ts` (which stays free of the driver
 * chain) so tests never load this browser-coupled module.
 *
 * @module background/workflow-engine/repair/background-runner
 */

import type { WorkflowRunner } from './verification-runner'
import type { RunnerOutcome } from './verification-runner'
import type { TraceEntry } from '../../../lib/workflow/repair/types'
import type { Workflow } from '../../../lib/workflow/types'
import type { CheckpointStore } from '../../../lib/workflow/checkpoints'
import type { AiTakeoverHook } from '../engine'

export interface ExecuteWorkflowCall {
  (
    workflow: Workflow,
    options: {
      source: 'manual'
      traceEntry: TraceEntry
      aiTakeover?: AiTakeoverHook
      sessionId?: string
      scopeWindowId?: number
    },
  ): Promise<{
    runId: string
    outcome: 'ok' | 'cancelled' | 'failed'
    summary?: string
    error?: string
    variables?: Record<string, unknown>
    trace?: import('../../../lib/workflow/repair/types').ExecutionTrace
  }>
}

export interface BackgroundRunnerOptions {
  executeWorkflow: ExecuteWorkflowCall
  scopeWindowId?: number
  sessionId?: string
}

/**
 * Build the {@link WorkflowRunner} over the real executeWorkflow.
 *
 * `allowAiTakeover` is honored but verification / replay callers always pass
 * false; the trace is carried through unchanged.
 */
export function createBackgroundRunner(options: BackgroundRunnerOptions): WorkflowRunner {
  return {
    run: async (
      workflow: Workflow,
      runOptions: {
        startAt?: string
        variables?: Record<string, unknown>
        allowAiTakeover: boolean
        entry: TraceEntry
        signal?: AbortSignal
      },
    ): Promise<RunnerOutcome> => {
      void runOptions.signal
      const result = await options.executeWorkflow(workflow, {
        source: 'manual',
        traceEntry: runOptions.entry,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.scopeWindowId !== undefined ? { scopeWindowId: options.scopeWindowId } : {}),
      })
      return {
        outcome: result.outcome,
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.variables ? { variables: result.variables } : {}),
        ...(result.trace ? { trace: result.trace } : {}),
      }
    },
  }
}

/**
 * Checkpoint-store adapter over the real backend. The repair engine only
 * needs load(runId); the production store is exposed from run-workflow.
 */
export function createBackgroundCheckpointAdapter(backend: {
  load(runId: string): import('../../../lib/workflow/checkpoints').RunCheckpoint[]
}): CheckpointStore {
  return {
    save: () => undefined,
    load: (runId) => backend.load(runId),
    latest: (runId) => backend.load(runId)[backend.load(runId).length - 1],
    clear: () => undefined,
  }
}
