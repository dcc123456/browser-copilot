/**
 * The pre-save trial replay, over the real run path.
 *
 * `lib/workflow/trial-run` decides WHAT may be run and how the result is
 * described; this is the half that actually runs it: one bounded
 * `executeWorkflow` of the generated graph, stopped in front of the first step
 * that cannot be undone, with any degradation the page reported written back
 * into the graph before the caller saves it.
 *
 * The contract with its caller is deliberately one-sided:
 *
 *   - it never throws, and it never returns an error — a trial that cannot run
 *     is a `skipped` record and the SAME workflow object;
 *   - it never blocks a save. The workflow the user gets is the workflow that
 *     was about to be saved, plus evidence;
 *   - it is the ONLY place a generated workflow is executed without the user
 *     asking, which is why the unsafe cutoff is computed before the run rather
 *     than checked after a failure.
 *
 * @module background/workflow-engine/repair/generation-trial
 */

import { applySelfHeal } from '../../../lib/workflow/self-heal'
import { rememberFailedRun } from '../auto-repair/failure-snapshot'
import {
  commitCutoffNodeId,
  draftCommitCutoffNodeId,
  draftSaveExecuted,
  executionPath,
  isTriggerNode,
  skippedTrialRecord,
  trialCutoffNodeId,
  trialHasNothingToProve,
  trialRecordOf,
  trialBudgetFor,
  type TrialRunRecord,
} from '../../../lib/workflow/trial-run'
import type { Workflow } from '../../../lib/workflow/types'
import type { ExecuteWorkflowOptions, ExecuteWorkflowResult } from '../run-workflow'

/** The run primitive shape the trial needs — production's `executeWorkflow`. */
export type TrialExecuteWorkflow = (
  workflow: Workflow,
  options: ExecuteWorkflowOptions,
) => Promise<ExecuteWorkflowResult>

/** The one run call the trial makes, with its options already narrowed. */
export type TrialExecute = (
  workflow: Workflow,
  options: {
    stopBefore?: string
    signal: AbortSignal
    traceEntry: 'VERIFY'
    /** The workflow's declared inputs, supplied by the caller. */
    inputs?: Record<string, unknown>
  },
) => Promise<ExecuteWorkflowResult>

export interface GenerationTrialDeps {
  execute: TrialExecute
  /** Wall-clock budget before the run is aborted and recorded as `timeout`. */
  budgetMs?: number
  /** Caller's cancellation (the generation turn was stopped): a `cancelled` trial. */
  signal?: AbortSignal
  now?: () => number
  /**
   * The values for the inputs the workflow DECLARES (its trigger `parameters`).
   *
   * A generated graph that searches for `{{keyword}}` is parameterised on
   * purpose, and the run that replays it has to say what the keyword is — the
   * same thing the panel's run button asks a human for. Seeded under the
   * declared defaults by `seedFromTrigger`, so a parameter whose default the
   * generation recorded still wins when the caller says nothing. Without a value
   * and without a default the step fails `UNRESOLVED_INPUT`, which is the honest
   * outcome: the graph never ran, so it proves nothing.
   */
  inputs?: Record<string, unknown>
  /**
   * Stop at the graph's COMMIT step instead of at its first unsafe step.
   *
   * Off by default, and the default is the right thing for a run nobody asked
   * for. It is wrong for proving a workflow whose entire job is to write
   * something: `idempotencyOf` reads prose, so a cover-image upload whose intent
   * says "上传到图文发布的图片上传入口" is unsafe because the NAME of the page
   * contains 发布, and the replay stops in front of it. Filled and healed for
   * four steps, such a graph never proves the other eight and can never be
   * certified, because a prefix is not a pass.
   *
   * With this on, the steps that only prepare a commit DO run — that is the
   * evidence being asked for, and the caller opted into it explicitly. What still
   * stops the run is the press of the control itself: a click, a submit, a key
   * that sends, a posted script, a webhook. 发布 stays unreachable.
   */
  commitCutoffOnly?: boolean
  /**
   * Also run the graph's OWN draft-save commit.
   *
   * Implies {@link commitCutoffOnly}. Off by default, because the step it lets
   * through writes into the user's account: a draft box entry, a note left in the
   * composer. It only fires for a commit whose own words name a draft (草稿 / 暂存 /
   * draft) and no outward verb, so a publish, a submit, a send or a payment still
   * stops the run — the line the caller cannot cross on the user's behalf.
   */
  allowDraftCommit?: boolean
}

/**
 * How many STEPS the run settled.
 *
 * The engine's list is in the engine's currency: it includes the trigger node,
 * and it includes a loop body once per iteration. `totalSteps` is the chain of
 * steps the graph can reach, in the trial's currency. Reduced to node ids rather
 * than to a count, so the two report the same thing and `12/12` means "the whole
 * graph ran" instead of `13/12`.
 */
function countedSteps(workflow: Workflow, completedNodeIds: string[] | undefined): number {
  if (!completedNodeIds) return 0
  const steps = new Set(
    workflow.drawflow.nodes.filter((node) => !isTriggerNode(node)).map((node) => node.id),
  )
  return new Set(completedNodeIds.filter((id) => steps.has(id))).size
}

/**
 * Run the trial and fold what it learned into the workflow.
 *
 * Returns the (possibly healed) workflow to save plus the record to store on
 * `settings.trialRun`. The two are one object out because the healing and the
 * evidence describe the same run — a caller that saved the healed graph but
 * dropped the record would hide that the first replay had to guess. `result` is
 * the run itself, for the caller that goes on to verify the GOAL against the live
 * page: the record describes coverage, and only the execution carries the
 * variables and the per-node completion the certification is built from.
 */
export async function runGenerationTrial(
  workflow: Workflow,
  deps: GenerationTrialDeps,
): Promise<{ workflow: Workflow; record: TrialRunRecord; result?: ExecuteWorkflowResult }> {
  const now = deps.now ?? Date.now
  const at = now()
  // `settings.trialRun === false` is the opt-out (an object is a record).
  if (workflow.settings?.trialRun === false) {
    return { workflow, record: skippedTrialRecord('disabled by settings', at) }
  }
  const totalSteps = executionPath(workflow).length
  const cutoffNodeId = deps.allowDraftCommit
    ? draftCommitCutoffNodeId(workflow)
    : deps.commitCutoffOnly
      ? commitCutoffNodeId(workflow)
      : trialCutoffNodeId(workflow)
  if (trialHasNothingToProve(workflow, cutoffNodeId ?? null)) {
    return {
      workflow,
      record: skippedTrialRecord(
        'its first step cannot be repeated, so nothing is safe to prove',
        at,
      ),
    }
  }

  const budgetMs = deps.budgetMs ?? trialBudgetFor(workflow, cutoffNodeId ?? null)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, budgetMs)
  // The caller's cancel is a different fact from the budget running out: one is
  // "the user stopped me", the other is "the page was too slow", and only the
  // second says anything about a possibly broken graph.
  const onCallerAbort = () => controller.abort()
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort()
    else deps.signal.addEventListener('abort', onCallerAbort, { once: true })
  }

  let result: ExecuteWorkflowResult | undefined
  let runError: unknown
  try {
    result = await deps.execute(workflow, {
      ...(cutoffNodeId ? { stopBefore: cutoffNodeId } : {}),
      ...(deps.inputs ? { inputs: deps.inputs } : {}),
      signal: controller.signal,
      traceEntry: 'VERIFY',
    })
  } catch (error) {
    runError = error
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', onCallerAbort)
  }

  if (!result) {
    // Any throw — no injectable tab, a driver refusal, an engine fault — is a
    // skipped trial, never a failed one: the graph is not on trial for what the
    // page refused to show. A cancel is the honest exception; the user stopped
    // it, which says nothing about the page either way.
    if (deps.signal?.aborted) {
      return { workflow, record: skippedTrialRecord('trial cancelled', at) }
    }
    return {
      workflow,
      record: skippedTrialRecord(
        `trial could not run: ${runError instanceof Error ? runError.message : String(runError)}`.slice(
          0,
          300,
        ),
        at,
      ),
    }
  }

  const record = trialRecordOf(
    {
      outcome: result.outcome,
      ...(result.stoppedBefore ? { stoppedBefore: result.stoppedBefore } : {}),
      ...(result.trace?.failedNodeId ? { failedNodeId: result.trace.failedNodeId } : {}),
      ...(result.error ? { error: result.error } : {}),
      completedSteps: countedSteps(workflow, result.completedNodeIds),
      degradedSteps: result.degradations?.length,
      timedOut,
      cancelledByCaller: !!deps.signal?.aborted,
      durationMs: now() - at,
      runId: result.runId,
      at,
    },
    { ...(cutoffNodeId ? { cutoffNodeId } : {}), totalSteps },
  )
  // «A draft was written» is a claim about the user's account, not about the flag
  // the caller waved: a run whose cutoff fell before the save step wrote nothing.
  // Only a run that reached its stop point says where it got to — a timeout or a
  // cancel can halt anywhere, so it is given no claim at all.
  if (deps.allowDraftCommit && (record.outcome === 'partial' || record.outcome === 'passed')) {
    record.draftSaved = draftSaveExecuted(workflow, record.cutoffNodeId ?? null)
  }

  // A failed trial is the failure the repair loop needs to see: the panel run
  // path remembers its own, but a trial replay is the only execution a freshly
  // generated graph ever gets, and without this the repair orchestrator would be
  // handed a workflow id and no evidence at all.
  if (record.outcome === 'failed' && result.trace) {
    try {
      rememberFailedRun(workflow.id, result.runId, result.trace)
    } catch (error) {
      console.warn('[trial] could not remember the failed run', error)
    }
  }

  // A step that degrades to act is a step the NEXT replay should not have to
  // guess at: the winner goes back into the graph here, at the one moment we
  // know the page is open and the answer is fresh.
  const degradations = result.degradations ?? []
  if (degradations.length === 0) return { workflow, record, result }
  const healed = applySelfHeal(workflow, degradations, {
    ...(result.runId ? { runId: result.runId } : { runId: 'trial' }),
    at,
  })
  return { workflow: healed.workflow, record, result }
}

/**
 * The {@link TrialExecute} over a supplied run primitive.
 *
 * `executeWorkflow` is injected rather than imported (the convention of
 * `background-runner`): this module must stay loadable by tests, which never
 * want the driver chain behind the real run path.
 *
 * `source: 'manual'` and `traceEntry: 'VERIFY'` are what the run record is
 * labelled with: the trial IS a run (the health card and the replay metrics
 * need to see it), and `VERIFY` is how a reader tells a trial apart from a run
 * the user asked for. AI takeover is left out on purpose — a trial that needs
 * the model to get past a step has not proved the workflow works, it has
 * proved the model works, and the user would be told the wrong thing.
 */
export function createTrialExecute(deps: {
  executeWorkflow: TrialExecuteWorkflow
  scopeWindowId?: number
}): TrialExecute {
  return (workflow, runOptions) =>
    deps.executeWorkflow(workflow, {
      source: 'manual',
      traceEntry: runOptions.traceEntry,
      ...(deps.scopeWindowId !== undefined ? { scopeWindowId: deps.scopeWindowId } : {}),
      ...(runOptions.stopBefore ? { stopBefore: runOptions.stopBefore } : {}),
      ...(runOptions.inputs ? { variables: runOptions.inputs } : {}),
      signal: runOptions.signal,
    })
}

/**
 * Run the trial against the graph a save is about to persist, and hand back the
 * graph to persist plus the record to store on it.
 *
 * This is the shape a save path takes as an option: the paths that have a live
 * page and a real run primitive supply it, the ones that only materialise a
 * draft for review supply nothing. It cannot reject — see
 * {@link runGenerationTrial} — so a caller that awaits it before `saveWorkflow`
 * still saves on every outcome.
 */
export type TrialRunner = (workflow: Workflow) => Promise<{
  workflow: Workflow
  record: TrialRunRecord
  result?: ExecuteWorkflowResult
}>

/** Put a trial's record on the workflow the trial describes. */
export function withTrialRecord(workflow: Workflow, record: TrialRunRecord): Workflow {
  return { ...workflow, settings: { ...workflow.settings, trialRun: record } }
}

export function createTrialRunner(deps: {
  executeWorkflow: TrialExecuteWorkflow
  scopeWindowId?: number
  budgetMs?: number
  signal?: AbortSignal
  /** See {@link GenerationTrialDeps.commitCutoffOnly}. */
  commitCutoffOnly?: boolean
  /** See {@link GenerationTrialDeps.allowDraftCommit}. */
  allowDraftCommit?: boolean
  /** See {@link GenerationTrialDeps.inputs}. */
  inputs?: Record<string, unknown>
}): TrialRunner {
  const execute = createTrialExecute({
    executeWorkflow: deps.executeWorkflow,
    ...(deps.scopeWindowId !== undefined ? { scopeWindowId: deps.scopeWindowId } : {}),
  })
  return (workflow) =>
    runGenerationTrial(workflow, {
      execute,
      ...(deps.budgetMs !== undefined ? { budgetMs: deps.budgetMs } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.commitCutoffOnly ? { commitCutoffOnly: true } : {}),
      ...(deps.allowDraftCommit ? { allowDraftCommit: true, commitCutoffOnly: true } : {}),
      ...(deps.inputs ? { inputs: deps.inputs } : {}),
    })
}
