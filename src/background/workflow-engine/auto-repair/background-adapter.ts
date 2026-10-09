/**
 * Real background adapter for autonomous repair (spec §12–§24).
 *
 * Wires the pure orchestrator's injected primitives to the real extension
 * infrastructure:
 *
 *   - `produceCandidate`     a strategy-specific completion call returning a
 *                            JSON {@link RepairCandidate};
 *   - `attemptReadinessRecovery` deterministic wait / scroll / focus, then
 *                            re-observe;
 *   - `resumeRun`            executeWorkflow from the checkpoint node with
 *                            the checkpoint variable snapshot;
 *   - `verification`         live condition evaluation via the driver probe;
 *   - `commit`               commitWorkflowRevision(source:'ai-repair') +
 *                            saveWorkflow;
 *   - `emit`                 remember the session events + forward them to
 *                            the panel.
 *
 * Also owns the active-repair registry (one repair per workflow), the event
 * replay for late subscribers and the cancellation signals.
 *
 * @module background/workflow-engine/auto-repair/background-adapter
 */
import { streamCompletion } from '../../../lib/llm'
import { normalScopeFromWindowId } from '../../automation-scope'
import { createDriverConditionProbe, evaluateAllConditions } from '../condition-runtime'
import { createDriverReadinessProbe, executeWorkflow } from '../run-workflow'
import { effectiveReadinessSpec, prepareNodeExecution } from '../readiness-engine'
import { targetFrom } from '../executors'
import { nodeReliabilityOf } from '../../../lib/workflow/reliability'
import { commitWorkflowRevision } from '../../../lib/workflow/workflow-revision'
import {
  runAutoRepair,
  type CandidateContext,
  type RepairProgressEvent,
  type ResumeResult,
} from './orchestrator'
import type { AutoRepairDeps } from './orchestrator'
import type { FailureSnapshot } from '../../../lib/workflow/repair-session'
import type { Workflow } from '../../../lib/workflow/types'
import type { WorkflowCondition } from '../../../lib/workflow/conditions'

// --- Active repair registry ---------------------------------------------------

interface ActiveRepairEntry {
  workflowId: string
  runId: string
  controller: AbortController
  events: RepairProgressEvent[]
  startedAt: number
  /** Sink that forwards events to the connected panel(s). */
  forward?: (event: RepairProgressEvent) => void
  settled?: boolean
}

const active = new Map<string, ActiveRepairEntry>()

/** Whether an autonomous repair is running for the workflow. */
export function autoRepairRunning(workflowId: string): boolean {
  const entry = active.get(workflowId)
  return !!entry && !entry.settled
}

/** Events already emitted (for a late subscriber / status query). */
export function autoRepairEvents(workflowId: string): RepairProgressEvent[] {
  return (active.get(workflowId)?.events ?? []).map((event) => ({ ...event }))
}

/** Cancel an active autonomous repair. Returns true when one was stopped. */
export function cancelAutoRepair(workflowId: string): boolean {
  const entry = active.get(workflowId)
  if (!entry || entry.settled) return false
  entry.controller.abort()
  return true
}

// --- Model config -------------------------------------------------------------

export interface RepairRuntimeModelConfig {
  apiKey: string
  baseUrl: string
  model: string
  headers?: Record<string, string>
}

// --- Candidate production -----------------------------------------------------

const CANDIDATE_TIMEOUT_MS = 45_000

function systemPromptFor(strategy: string): string {
  return [
    'You are the workflow repair component of a browser-automation extension.',
    'You receive a failed workflow step, its intent, the live failure and the strategy to apply.',
    `Apply the "${strategy}" strategy and return ONE JSON object — no prose, no markdown fence — with this shape:`,
    JSON.stringify({
      strategy,
      reason: 'why this change fixes the failure',
      nodePatches: [
        {
          op: 'update-node | insert-node | delete-node',
          nodeId: 'target node id (update/delete)',
          changes: { selector: 'new value' },
          node: '{ id, label, position, data } (insert)',
        },
      ],
      edgePatches: [{ op: 'connect | disconnect', source: 'node id', target: 'node id' }],
      expectedPostconditions: [{ kind: 'urlContains', value: '/done' }],
      confidence: 0.8,
    }),
    'Only reference facts present in the failure evidence. When the strategy cannot produce a change, return {"strategy":"' +
      strategy +
      '","reason":"no viable change"} with empty nodePatches and edgePatches.',
  ].join('\n')
}

function makeCandidateProducer(
  config: RepairRuntimeModelConfig | undefined,
): (context: CandidateContext) => Promise<unknown> {
  return async (context: CandidateContext): Promise<unknown> => {
    if (!config) {
      // No model configured: produce an empty result so the ladder advances.
      return {
        strategy: context.strategy,
        reason: 'no repair model configured',
        nodePatches: [],
        edgePatches: [],
      }
    }
    const result = await streamCompletion(
      {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        headers: config.headers,
        signal: AbortSignal.timeout(CANDIDATE_TIMEOUT_MS),
        messages: [
          { role: 'system', content: systemPromptFor(context.strategy) },
          {
            role: 'user',
            content: JSON.stringify(
              {
                workflowId: context.workflow.id,
                workflowName: context.workflow.name,
                failedNode: {
                  nodeId: context.failure.nodeId,
                  blockId: context.failure.blockId,
                  intent: context.failure.intent,
                  errorType: context.failure.errorType,
                  errorMessage: context.failure.errorMessage,
                  locator: context.failure.locator,
                  page: context.failure.page,
                },
                ...(context.previousIssues
                  ? { previousInvalidIssues: context.previousIssues }
                  : {}),
              },
              null,
              2,
            ),
          },
        ],
      },
      {},
    )
    const text = result.content
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
}

// --- Readiness recovery (S1) --------------------------------------------------

/**
 * Deterministic readiness recovery (S1): re-OBSERVE the page against the failed
 * step's own readiness states and preconditions.
 *
 * The previous version slept 300 ms and reported success. That is not recovery:
 * it is a coin toss dressed up as a strategy, and the "no graph change" note it
 * returned let the orchestrator bank a verification pass the run had never
 * earned. Polling the real probe costs nothing when the page is already ready
 * (the first check answers) and fixes the transient case when it is not.
 */
export function makeReadinessRecovery(
  signal: AbortSignal,
  scopeWindowId: number | undefined,
): AutoRepairDeps['attemptReadinessRecovery'] {
  return async (workflow, failure) => {
    const node = workflow.drawflow.nodes.find((candidate) => candidate.id === failure.nodeId)
    if (!node) return { ok: false, note: 'the failed step is no longer in the graph' }
    const params = (node.data ?? {}) as Record<string, unknown>
    const requirements = effectiveReadinessSpec(node, failure.blockId, params)?.before ?? []
    const preconditions = nodeReliabilityOf(node)?.preconditions ?? []
    if (requirements.length === 0 && preconditions.length === 0) {
      // The step declared nothing the page could be late with. Waiting on a
      // step that is not waiting on anything is how S1 used to fake a fix;
      // hand it to a strategy that can actually change something.
      return { ok: false, note: 'this step declares no readiness or precondition to re-observe' }
    }
    const scope =
      scopeWindowId !== undefined
        ? await normalScopeFromWindowId(scopeWindowId).catch(() => undefined)
        : undefined
    const ready = await prepareNodeExecution({
      node,
      blockId: failure.blockId,
      params,
      nodeSelector: String(params['selector'] ?? params['cssSelector'] ?? ''),
      nodeTarget: targetFrom(params),
      signal,
      probe: createDriverReadinessProbe(signal, scope),
    })
    if (!ready.ok) {
      return {
        ok: false,
        note: `readiness still unmet: ${ready.state ?? 'unknown'}${ready.detail ? ` (${ready.detail})` : ''}`,
      }
    }
    if (preconditions.length > 0) {
      const result = await evaluateAllConditions(
        preconditions,
        { variables: {}, probe: createDriverConditionProbe(signal, scope) },
        false,
      )
      const unmet = result.outcomes.find((outcome) => !outcome.satisfied)
      if (unmet) return { ok: false, note: `precondition still unmet: ${unmet.description}` }
    }
    return {
      ok: true,
      note: `re-observed after ${ready.waitedMs}ms: ${requirements.length} readiness state(s), ${preconditions.length} precondition(s) hold`,
    }
  }
}

// --- Resume -------------------------------------------------------------------

function makeResumeRun(scopeWindowId: number | undefined) {
  return async (
    workflow: Workflow,
    startNodeId: string | undefined,
    variables: Record<string, unknown>,
  ): Promise<ResumeResult> => {
    const outcome = await executeWorkflow(workflow, {
      source: 'manual',
      ...(scopeWindowId !== undefined ? { scopeWindowId } : {}),
      ...(startNodeId ? { startAt: startNodeId } : {}),
      variables,
    })
    if (outcome.outcome === 'cancelled') return { outcome: 'cancelled' }
    if (outcome.outcome === 'ok') return { outcome: 'passed' }
    return {
      outcome: 'failed',
      error: outcome.error,
      ...(outcome.trace?.failedNodeId ? { failedNodeId: outcome.trace.failedNodeId } : {}),
    }
  }
}

// --- Verification deps --------------------------------------------------------

function makeVerification(signal: AbortSignal, scopeWindowId: number | undefined) {
  return {
    evaluateConditions: async (conditions: WorkflowCondition[]) => {
      const scope =
        scopeWindowId !== undefined ? await normalScopeFromWindowId(scopeWindowId) : undefined
      const probe = createDriverConditionProbe(signal, scope)
      const result = await evaluateAllConditions(conditions, { variables: {}, probe }, false)
      return result.outcomes.map((outcome, index) => ({
        condition: conditions[index]!,
        satisfied: outcome.satisfied,
        note: outcome.description,
      }))
    },
  }
}

// --- Commit -------------------------------------------------------------------

export interface SaveAdapter {
  saveWorkflow: (workflow: Workflow) => Promise<void>
  /** Re-read the formal workflow (revision conflict check). */
  getWorkflow: (id: string) => Promise<Workflow | undefined>
}

function makeCommit(save: SaveAdapter) {
  return async (workflow: Workflow, repairSessionId: string): Promise<number> => {
    const formal = await save.getWorkflow(workflow.id)
    const base = formal ?? workflow
    const next = commitWorkflowRevision(base, {
      source: 'ai-repair',
      repairSessionId,
    })
    const committed: Workflow = {
      ...workflow,
      revision: next.revision,
      revisionHistory: next.revisionHistory,
      updatedAt: Date.now(),
    }
    await save.saveWorkflow(committed)
    return next.revision
  }
}

// --- Entry point --------------------------------------------------------------

export interface StartBackgroundAutoRepairInput {
  workflow: Workflow
  runId: string
  failure: FailureSnapshot
  model?: RepairRuntimeModelConfig
  save: SaveAdapter
  scopeWindowId?: number
  /** Forward every progress event to the connected panel(s). */
  forward?: (event: RepairProgressEvent) => void
}

export interface BackgroundAutoRepairOutcome {
  status: 'success' | 'exhausted' | 'blocked'
  reason?: string
  revision?: number
  attempts: number
  durationMs: number
  committed: boolean
}

/**
 * Start autonomous repair in the background. The returned promise settles
 * when the repair does; events are forwarded as they occur.
 */
export async function startBackgroundAutoRepair(
  input: StartBackgroundAutoRepairInput,
): Promise<BackgroundAutoRepairOutcome> {
  if (autoRepairRunning(input.workflow.id)) {
    throw new Error('An autonomous repair is already running for this workflow.')
  }
  const controller = new AbortController()
  const entry: ActiveRepairEntry = {
    workflowId: input.workflow.id,
    runId: input.runId,
    controller,
    events: [],
    startedAt: Date.now(),
    forward: input.forward,
  }
  active.set(input.workflow.id, entry)

  const emit = (event: RepairProgressEvent): void => {
    entry.events.push(event)
    try {
      entry.forward?.(event)
    } catch (error) {
      console.warn('[auto-repair] forward failed', error)
    }
  }

  const deps: AutoRepairDeps = {
    produceCandidate: makeCandidateProducer(input.model),
    attemptReadinessRecovery: makeReadinessRecovery(controller.signal, input.scopeWindowId),
    resumeRun: makeResumeRun(input.scopeWindowId),
    verification: makeVerification(controller.signal, input.scopeWindowId),
    commit: makeCommit(input.save),
    emit,
  }

  try {
    const session = await runAutoRepair({
      workflow: input.workflow,
      runId: input.runId,
      failure: input.failure,
      deps,
      signal: controller.signal,
    })
    entry.settled = true
    const outcome: BackgroundAutoRepairOutcome = {
      status: session.final?.status ?? 'exhausted',
      ...(session.final?.reason ? { reason: session.final.reason } : {}),
      attempts: session.final?.attempts ?? session.attempts.length,
      durationMs: session.final?.durationMs ?? Date.now() - entry.startedAt,
      committed: session.final?.committed ?? false,
    }
    // Without a model, every model strategy in the ladder "produced a
    // candidate" that patched nothing — so the attempt count and
    // `attempt budget exhausted` describe a walk that never really happened.
    // Say what was missing instead of leaving the caller to guess.
    if (!input.model && outcome.status === 'exhausted') {
      outcome.reason = `${outcome.reason ?? 'exhausted'} (no repair model configured: ${
        outcome.attempts
      } strategy slot(s) burned without a model call)`
    }
    return outcome
  } catch (error) {
    // The orchestrator re-throws anything that is not a user cancel. Without a
    // terminal event here the panel would keep its "AI is repairing…" spinner
    // forever, and the registry entry would block every later repair for this
    // workflow — so settle both.
    entry.settled = true
    const reason = error instanceof Error ? error.message : String(error)
    console.warn('[auto-repair] repair aborted by an unexpected error', error)
    const sessionId = entry.events.find((event) => event.type === 'repair.started')?.sessionId
    if (sessionId) emit({ type: 'repair.blocked', sessionId, reason })
    return {
      status: 'blocked',
      reason,
      attempts: entry.events.filter((event) => event.type === 'repair.attempt-failed').length,
      durationMs: Date.now() - entry.startedAt,
      committed: false,
    }
  } finally {
    // Settled either way: drop the registry entry so a later run can start a
    // fresh repair.
    active.delete(input.workflow.id)
  }
}
