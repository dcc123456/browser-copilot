/**
 * Workflow-generation mode for callers with no side panel.
 *
 * Generation was reachable from exactly one place: the Chat mode selector is the
 * only code path that ever sets `mode:'workflow'`, and the review card that
 * follows the turn is the only thing that closes the draft it recorded. An
 * unattended caller has neither, so this module supplies both halves — one
 * generation turn, then the same `composeWorkflowFromDraft` the panel calls,
 * trial replay included.
 *
 * A turn is minutes long, so the bridge-facing entry points are the pair
 * {@link startGenerationRun} / {@link readGenerationRun}; {@link
 * generateWorkflowUnattended} is the awaitable core they track.
 *
 * The second thing a caller with no panel cannot do is ask whether a graph it
 * already has actually runs, so {@link startVerificationRun} replays a saved
 * workflow through the same trial runner and reports the verdict on the same
 * run registry.
 *
 * @module background/workflow-generation-bridge
 */

import { getSettings, newId } from '../lib/storage'
import { takeoverProviderOf } from '../lib/workflow/ai-takeover'
import type { Workflow, WorkflowSettings } from '../lib/workflow/types'
import type { TrialRunRecord } from '../lib/workflow/trial-run'
import { trialCertifies, trialFailed } from '../lib/workflow/trial-run'
import type { PageContextFingerprint } from '../lib/workflow/page-context'
import { reliabilityModeOf } from '../lib/workflow/reliability'
import type { WorkflowGoalSpec, WorkflowReliabilityMode } from '../lib/workflow/reliability'
import { getWorkflow, saveWorkflow } from '../lib/workflow/storage'
import { runUnattendedPrompt } from './agent-unattended'
import { actionNodesOf, composeWorkflowFromDraft, hydrateDraft } from './operator-tool-handler'
import { executeWorkflow, type ExecuteWorkflowResult } from './workflow-engine/run-workflow'
import { createDriverConditionProbe } from './workflow-engine/condition-runtime'
import { verifyWorkflowGoal } from './workflow-engine/goal-verification'
import { normalScopeFromWindowId } from './automation-scope'
import {
  autoRepairEvents,
  startBackgroundAutoRepair,
  type BackgroundAutoRepairOutcome,
  type RepairRuntimeModelConfig,
} from './workflow-engine/auto-repair/background-adapter'
import { failureSnapshotForRun } from './workflow-engine/auto-repair/failure-snapshot'
import { createTrialRunner, withTrialRecord } from './workflow-engine/repair/generation-trial'

export interface UnattendedGenerationRequest {
  /** The user's goal, verbatim — the string the panel would put in the chat box. */
  prompt: string
  /** Pin the run to this window (the bridge's assigned window). */
  scopeWindowId?: number
  signal?: AbortSignal
  /**
   * Close the web tabs the run opened once it settles. Off by default because a
   * run with a human watching keeps its tabs; an unattended one has nobody to
   * close them, and re-runs accumulate.
   */
  closeTabsAtEnd?: boolean
}

/**
 * The saved graph's own evidence, echoed back so an unattended caller can judge
 * the run without reading extension storage: what mode it saved in, what it
 * claims to prove, what the save flagged, and how the pre-save replay went.
 */
export interface GenerationWorkflowSummary {
  id: string
  name: string
  saved: boolean
  revision?: number
  nodeCount: number
  reliabilityMode: WorkflowReliabilityMode
  provenance?: WorkflowSettings['provenance']
  generationOriginUrl?: string
  /** The sites this graph may act on, when generation recorded more than one. */
  pageContext?: PageContextFingerprint
  certificationStatus?: WorkflowSettings['certificationStatus']
  goalSpec?: WorkflowGoalSpec
  saveWarnings: string[]
  trialRun?: TrialRunRecord
  /**
   * Did the pre-save verification replay prove the graph runs?
   *
   * Kept apart from `saved` on purpose: saving is unconditional, so a caller
   * that read `saved` as "it works" would be told exactly the wrong thing about
   * the graphs that need the most scrutiny. Only a clean full replay counts —
   * `partial` proved the safe prefix, `skipped`/`timeout` proved nothing.
   */
  verified: boolean
  /** One line describing that verdict, for a caller that only reads prose. */
  verification?: string
  /**
   * Did the replay achieve the GOAL, as opposed to running every step without an
   * error?
   *
   * A separate field because the two come apart on real sites, and conflating
   * them is the facade: a graph whose steps all returned `ok` but whose last
   * three nodes are leftover diagnostics has run cleanly and achieved nothing.
   * This is the L1/L2/L3 certification the panel's own run button does, on the
   * same standard the repair ladder's S0 uses — a success row that is only a URL
   * cannot certify, because the page the workflow opens already satisfies it.
   * Absent when the graph has no goal contract, or when the replay did not run
   * to completion (a cutoff prefix or a failed step has no goal to judge).
   */
  goal?: { certified: boolean; level: string; reason: string }
}

/**
 * What the repair loop was handed and what it did, reported beside the replay
 * rather than folded into it: `attempted: false` with `status: 'not-needed'` is
 * "the graph already ran", and with `'blocked'` it is "a step failed and nothing
 * could be done about it" — the caller cannot tell those apart from `ok` alone.
 */
export interface RepairRunSummary {
  attempted: boolean
  status: 'not-needed' | 'success' | 'exhausted' | 'blocked'
  attempts: number
  durationMs: number
  /** True when the repair wrote a new revision into storage. */
  committed: boolean
  reason?: string
  /** The step the replay failed on — what the repair was given as evidence. */
  failedNodeId?: string
  failureCode?: string
}

export interface UnattendedGenerationResult {
  ok: boolean
  conversationId: string
  error?: string
  issues?: string[]
  answer?: string
  workflow?: GenerationWorkflowSummary
  /** Present on `repair_workflow`: what the repair loop was given and did. */
  repair?: RepairRunSummary
  /** Present when the run opted into `closeTabsAtEnd`: tabs it opened and left closed. */
  tabsClosed?: number
}

/**
 * Run one generation turn to completion and close the draft it recorded.
 *
 * This takes minutes, which is longer than the local-agent adapter's response
 * window, so the bridge calls `startGenerationRun` and then polls
 * `readGenerationRun` instead of awaiting it. `conversationId` is passed in
 * rather than minted here because it is the handle the caller polls with, and it
 * has to exist before this resolves.
 */
export async function generateWorkflowUnattended(
  req: UnattendedGenerationRequest,
  conversationId: string,
): Promise<UnattendedGenerationResult> {
  return withTabJanitor(req, () => runGenerationTurn(req, conversationId))
}

async function runGenerationTurn(
  req: UnattendedGenerationRequest,
  conversationId: string,
): Promise<UnattendedGenerationResult> {
  const turn = await runUnattendedPrompt(req.prompt, conversationId, 'workflow', {
    ...(req.scopeWindowId !== undefined ? { scopeWindowId: req.scopeWindowId } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  })
  if (turn.cancelled) {
    return {
      ok: false,
      conversationId,
      error: 'Cancelled',
      ...(turn.answer ? { answer: turn.answer } : {}),
    }
  }

  // Compose even when the turn reported a failure: the draft holds every node
  // the operators actually recorded, and a graph that stops short of the last
  // step is worth more to the caller than nothing. Save is never blocked by the
  // findings — they come back as `saveWarnings` and the trial record.
  const composed = await composeWorkflowFromDraft(conversationId, {
    save: true,
    trial: createTrialRunner({
      executeWorkflow,
      ...(req.scopeWindowId !== undefined ? { scopeWindowId: req.scopeWindowId } : {}),
    }),
  })

  if ('error' in composed) {
    return {
      ok: false,
      conversationId,
      error: turn.ok ? composed.error : `${turn.error ?? composed.error}`,
      ...(composed.issues?.length ? { issues: composed.issues } : {}),
      ...(turn.answer ? { answer: turn.answer } : {}),
    }
  }

  return {
    ok: turn.ok,
    conversationId,
    ...(turn.error ? { error: turn.error } : {}),
    ...(turn.answer ? { answer: turn.answer } : {}),
    workflow: summarize(composed.workflow, composed.saved),
  }
}

/**
 * How long an explicitly requested verification may run.
 *
 * The pre-save trial keeps a tight budget (`TRIAL_BUDGET_MS`) because it is one
 * gate inside a turn that is already minutes long. A verification the caller
 * asked for IS the whole request: cutting a cold 40-step replay off at 45s
 * reports `timeout` — "the page was slow" — for a graph that runs fine, which is
 * a wrong answer rather than a cautious one.
 */
export const VERIFY_BUDGET_MS = 5 * 60_000

export interface UnattendedVerificationRequest {
  /** The saved workflow to replay. */
  workflowId: string
  /** Pin the replay to this window (the bridge's assigned window). */
  scopeWindowId?: number
  budgetMs?: number
  signal?: AbortSignal
  /**
   * Close the tabs this run opened when it finishes. Off by default: a human
   * watching a replay wants the page left on screen. An unattended caller that
   * re-runs the same graph gets one publish page per run otherwise, with nobody
   * to close them.
   */
  closeTabsAtEnd?: boolean
  /**
   * Replay past the trial's unsafe cutoff, stopping only at the graph's COMMIT
   * step. Off by default — the default refuses every step `idempotencyOf` calls
   * unsafe, and that classifier reads the step's INTENT PROSE: a cover-image
   * upload whose intent says "上传到图文发布的图片上传入口" is refused because the
   * page's NAME contains 发布. Right for a run nobody asked for; fatal for a
   * caller that asked whether the workflow works, because the replay stops at
   * step 4 of 12, never reaches the fills or the draft save, and so can answer
   * nothing but `partial` — forever.
   *
   * This is not "skip the safety check". The steps that PREPARE a commit run; the
   * commit itself still stops the replay — an unsafe click, submit, send-key,
   * posted script or webhook. 发布 stays unreachable by construction, and a graph
   * that really does end in a publish still reports `partial` rather than
   * pretending a prefix is a proof.
   */
  commitCutoffOnly?: boolean
  /**
   * Also fire the commit the workflow's OWN words describe as saving a draft.
   *
   * Implies {@link commitCutoffOnly}. Without it a draft-goal graph is stuck
   * reporting `partial` forever: its last step is 「保存为草稿，不发布」, the
   * classifier cannot tell that from 「点击发布」, and the one effect the goal asked
   * for is the one the replay refuses to produce. With it that step runs — and
   * only that shape of step. A publish, a submit, a send, a payment, a webhook, and
   * any commit too vaguely written to prove it stays inside the composer still stop
   * the run. The caller asks for this one explicitly because it writes into the
   * user's account; nothing upstream defaults it.
   */
  allowDraftCommit?: boolean
  /**
   * Values for the inputs the workflow DECLARES (its trigger `parameters`).
   *
   * A generated graph that searches for `{{keyword}}` is parameterised on
   * purpose, and clicking Run in the panel asks a human for that value. An
   * unattended replay has no one to ask: with no value and no recorded default
   * the step fails `UNRESOLVED_INPUT: {{keyword}}` — which is the honest result
   * (the graph never ran) but not a repairable one, so the repair ladder walks
   * its whole budget against a caller argument nobody supplied. A caller that
   * knows the workflow takes a topic, a keyword or a URL says so here.
   */
  inputs?: Record<string, unknown>
}

export interface UnattendedRepairRequest extends UnattendedVerificationRequest {
  /**
   * The model the repair loop consults for each candidate patch. When the
   * caller does not resolve one, {@link repairModelFromSettings} reads it off
   * the extension's own settings — without EITHER there is no candidate
   * producer and the ladder only burns its budget.
   */
  model?: RepairRuntimeModelConfig
}

/**
 * The repair model this build would use if a human had clicked the run button:
 * the takeover provider (the active provider, or the model the user picked for
 * autonomous work), which is also what `workflows.run`'s auto-repair uses.
 *
 * A provider without an API key is no provider — an unauthenticated completion
 * fails every strategy slower, not better.
 */
async function repairModelFromSettings(): Promise<RepairRuntimeModelConfig | undefined> {
  try {
    const settings = await getSettings()
    const provider = takeoverProviderOf(settings)
    if (!provider?.apiKey.trim()) return undefined
    return {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
      ...(provider.headers ? { headers: provider.headers } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * A run's tab cleanup, for callers with nobody watching.
 *
 * An unattended replay of a graph that navigates leaves its publish page open,
 * and re-running it leaves another — the pile is normally cleared by a human, and
 * there is no human here. So a run that opts in snapshots the tabs before it
 * starts and closes the ones that were not there after.
 *
 * Attribution is by appearance, not by guesswork: a tab that existed when the run
 * started is NEVER closed, only `http(s)` tabs are candidates (so a `chrome://`
 * page, an extension page and a fresh new-tab page all survive), and a pinned tab
 * is left alone because a pin is a request to keep it. Within a scoped run only
 * that window is touched.
 */
async function closeTabsTheRunOpened(
  before: Set<number>,
  scopeWindowId: number | undefined,
): Promise<number> {
  const tabs = await chrome.tabs.query(
    scopeWindowId === undefined ? {} : { windowId: scopeWindowId },
  )
  const openedByRun = tabs.filter(
    (tab) =>
      typeof tab.id === 'number' &&
      !before.has(tab.id) &&
      !tab.pinned &&
      /^https?:/.test(tab.url ?? ''),
  )
  let closed = 0
  for (const tab of openedByRun) {
    try {
      await chrome.tabs.remove(tab.id as number)
      closed += 1
    } catch {
      // Already gone, or Chrome refused to empty the window; the run's own
      // verdict is what the caller reads, not this.
    }
  }
  return closed
}

/** The tabs already open in the scope before the run touched the browser. */
async function snapshotTabs(scopeWindowId: number | undefined): Promise<Set<number>> {
  const tabs = await chrome.tabs.query(
    scopeWindowId === undefined ? {} : { windowId: scopeWindowId },
  )
  const snapshot = new Set<number>()
  for (const tab of tabs) {
    if (typeof tab.id === 'number') snapshot.add(tab.id)
  }
  return snapshot
}

/**
 * Run a whole unattended replay (or repair, or generation) under the opt-in tab
 * cleanup, and report on the result how many tabs were closed.
 *
 * The janitor sits at the entry that OWNS the run, not at each replay inside it:
 * a repair is replay → candidate checks → replay, and those checks read the page
 * the first replay left open. Closing between the two would throw away the
 * evidence the repair is working on.
 *
 * Cleanup runs whether the work settled or threw, and its own failure never
 * replaces the run's outcome — a caller that asked for a verdict and got a
 * cleanup stack trace was told the wrong thing about the graph.
 */
async function withTabJanitor(
  req: { closeTabsAtEnd?: boolean; scopeWindowId?: number },
  run: () => Promise<UnattendedGenerationResult>,
): Promise<UnattendedGenerationResult> {
  if (!req.closeTabsAtEnd) return run()
  const before = await snapshotTabs(req.scopeWindowId)
  const outcome = await run().then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  const tabsClosed = await closeTabsTheRunOpened(before, req.scopeWindowId)
  if (!outcome.ok) throw outcome.error
  return { ...outcome.result, tabsClosed }
}

/**
 * Replay a SAVED workflow and report whether it runs.
 *
 * Generation proves a graph once, at save time, and nothing ever proves it
 * again — so a caller that fixed the engine, or that simply wants to know
 * whether the graph it was handed works, has no way to ask. This is that way:
 * the same trial runner, the same unsafe cutoff, against the stored graph.
 *
 * The verdict arrives on `workflow.verified` / `workflow.verification` and
 * follows {@link trialCertifies}: only a clean FULL replay is `verified`, so a
 * graph whose unsafe tail was skipped reads `partial` and stays unverified. `ok`
 * is narrower still — it is false only when the replay FAILED, which is the one
 * outcome that says the graph is broken rather than unproven.
 */
export async function verifySavedWorkflowUnattended(
  req: UnattendedVerificationRequest,
  conversationId: string,
): Promise<UnattendedGenerationResult> {
  return withTabJanitor(req, () => replayOnce(req, conversationId))
}

/** The replay itself, with no tab cleanup around it — see {@link withTabJanitor}. */
async function replayOnce(
  req: UnattendedVerificationRequest,
  conversationId: string,
): Promise<UnattendedGenerationResult> {
  const stored = await getWorkflow(req.workflowId)
  if (!stored) {
    return {
      ok: false,
      conversationId,
      error: `No saved workflow with id ${req.workflowId}`,
    }
  }

  const trial = createTrialRunner({
    executeWorkflow,
    budgetMs: req.budgetMs ?? VERIFY_BUDGET_MS,
    ...(req.scopeWindowId !== undefined ? { scopeWindowId: req.scopeWindowId } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
    ...(req.commitCutoffOnly ? { commitCutoffOnly: true } : {}),
    ...(req.allowDraftCommit ? { allowDraftCommit: true } : {}),
    ...(req.inputs ? { inputs: req.inputs } : {}),
  })
  const { workflow, record, result } = await trial(stored)
  // Persisted for the same reason the pre-save trial writes back: the replay
  // either healed a locator against the live page or produced the record the
  // health card reads as "last verified". Dropping either would make the run
  // invisible the moment this worker goes idle.
  const updated = withTrialRecord(workflow, record)
  const goal = result ? await certifyReplayGoal(updated, result, req.scopeWindowId) : undefined
  const final = goal
    ? {
        ...updated,
        settings: {
          ...updated.settings,
          certificationStatus: goal.certified ? ('certified' as const) : ('unverified' as const),
        },
      }
    : updated
  await saveWorkflow(final)

  return {
    ok: !trialFailed(record),
    conversationId,
    workflow: { ...summarize(final, true), ...(goal ? { goal } : {}) },
  }
}

/**
 * Judge the GOAL the replay was supposed to achieve, the way the panel's run
 * button does after a successful run.
 *
 * Only a replay that ran the graph to completion has a goal to judge: a prefix
 * that stopped at a cutoff deliberately left the last steps unexecuted, so its
 * goal is unproven by design, and calling that `unverified` would punish the
 * safety rule that stopped it. A failure is the same story with a step missing.
 *
 * The page probe is the one the run itself used (driver ops on the automation
 * tab) — a goal condition judged anywhere else is judged against a page nobody
 * acted on.
 */
async function certifyReplayGoal(
  workflow: Workflow,
  result: ExecuteWorkflowResult,
  scopeWindowId: number | undefined,
): Promise<GenerationWorkflowSummary['goal']> {
  if (!workflow.settings?.goalSpec) return undefined
  if (result.outcome !== 'ok' || result.stoppedBefore) return undefined
  try {
    const scope =
      scopeWindowId !== undefined
        ? await normalScopeFromWindowId(scopeWindowId).catch(() => undefined)
        : undefined
    const report = await verifyWorkflowGoal(
      workflow,
      result,
      createDriverConditionProbe(new AbortController().signal, scope),
    )
    return { certified: report.certified, level: report.level, reason: report.reason }
  } catch (error) {
    console.warn('[generation-bridge] goal verification failed', error)
    return undefined
  }
}

/**
 * Replay a saved graph, and if a step FAILS, run the autonomous repair loop over
 * it and replay it once more.
 *
 * This is the piece the self test was missing: generation proves a graph once and
 * `verify_workflow` only reports, so a graph whose locator went stale had no path
 * to the repair orchestrator, which lives behind `settings.autoRepairOnRun` on the
 * panel's own run button. Two facts make that loop possible here: the request
 * carries the model config the caller resolved from settings (the bridge reads no
 * settings itself), and a failed trial now remembers its trace
 * (`generation-trial.ts`) — repair without that evidence would be handed a
 * workflow id and nothing to look at.
 *
 * `ok` is the FINAL replay's verdict, so a graph repaired on the first attempt
 * and a graph that never needed it both read `ok: true`; `repair` says which of
 * the two happened. A `timeout` or `skipped` replay does NOT trigger a repair —
 * a slow page and a page that refused to open are not broken graphs.
 */
export async function repairSavedWorkflowUnattended(
  req: UnattendedRepairRequest,
  conversationId: string,
): Promise<UnattendedGenerationResult> {
  // ONE janitor for the whole run: the repair loop inspects the page the first
  // replay left open, so cleanup cannot happen between the two replays.
  return withTabJanitor(req, () => repairOnce(req, conversationId))
}

async function repairOnce(
  req: UnattendedRepairRequest,
  conversationId: string,
): Promise<UnattendedGenerationResult> {
  const first = await replayOnce(req, conversationId)
  const trial = first.workflow?.trialRun
  const failure = {
    ...(trial?.failedNodeId ? { failedNodeId: trial.failedNodeId } : {}),
    ...(trial?.failureCode ? { failureCode: trial.failureCode } : {}),
  }
  if (first.ok) {
    return {
      ...first,
      repair: {
        attempted: false,
        status: 'not-needed',
        attempts: 0,
        durationMs: 0,
        committed: false,
      },
    }
  }

  const stored = await getWorkflow(req.workflowId)
  if (!stored) {
    return {
      ...first,
      repair: {
        attempted: false,
        status: 'blocked',
        attempts: 0,
        durationMs: 0,
        committed: false,
        reason: `No saved workflow with id ${req.workflowId}`,
        ...failure,
      },
    }
  }

  const runId = trial?.runId ?? ''
  let outcome: BackgroundAutoRepairOutcome
  try {
    outcome = await startBackgroundAutoRepair({
      workflow: stored,
      runId,
      failure: failureSnapshotForRun(stored, runId),
      model: req.model ?? (await repairModelFromSettings()),
      ...(req.scopeWindowId !== undefined ? { scopeWindowId: req.scopeWindowId } : {}),
      save: { saveWorkflow, getWorkflow },
    })
  } catch (error) {
    // No evidence for that run (a worker that restarted between the replay and
    // this call), or the repair loop threw. Either way the caller gets the
    // original failing replay back, with the reason it could not be repaired.
    return {
      ...first,
      repair: {
        attempted: false,
        status: 'blocked',
        attempts: 0,
        durationMs: 0,
        committed: false,
        reason: error instanceof Error ? error.message : String(error),
        ...failure,
      },
    }
  }

  const again = await replayOnce(req, conversationId)
  return {
    ...again,
    repair: {
      attempted: true,
      status: outcome.status,
      attempts: outcome.attempts,
      durationMs: outcome.durationMs,
      committed: outcome.committed,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...failure,
    },
  }
}

function summarize(workflow: Workflow, saved: boolean): GenerationWorkflowSummary {
  const settings = workflow.settings
  const verification = describeTrial(settings.trialRun)
  return {
    id: workflow.id,
    name: workflow.name,
    saved,
    ...(workflow.revision !== undefined ? { revision: workflow.revision } : {}),
    nodeCount: workflow.drawflow.nodes.length,
    // Derived, not read: a generated graph usually saves WITHOUT an explicit
    // mode and the engine then treats its provenance as generated-strict
    // (reliability.ts). Reporting the raw field would claim `compat` for exactly
    // the graphs that replay under the strict regime.
    reliabilityMode: reliabilityModeOf(workflow),
    ...(settings.provenance ? { provenance: settings.provenance } : {}),
    ...(settings.generationOriginUrl ? { generationOriginUrl: settings.generationOriginUrl } : {}),
    ...(settings.pageContext ? { pageContext: settings.pageContext } : {}),
    ...(settings.certificationStatus ? { certificationStatus: settings.certificationStatus } : {}),
    ...(settings.goalSpec ? { goalSpec: settings.goalSpec } : {}),
    saveWarnings: settings.saveWarnings ?? [],
    ...(settings.trialRun ? { trialRun: settings.trialRun } : {}),
    verified: trialCertifies(settings.trialRun),
    ...(verification ? { verification } : {}),
  }
}

/** The trial's verdict as one readable line, or nothing when it never ran. */
function describeTrial(record: TrialRunRecord | false | undefined): string | undefined {
  if (!record) return undefined
  const code = record.failureCode ? ` ${record.failureCode}` : ''
  const reason = record.reason ? ` — ${record.reason}` : ''
  return `${record.outcome}${code} (${record.coveredSteps}/${record.totalSteps} steps)${reason}`
}

/**
 * A run tracked for a polling caller: the handle is issued the moment the turn
 * starts, so the registry has to hold the outcome afterwards.
 */
export interface GenerationRunHandle {
  conversationId: string
  status: 'running'
}

export interface GenerationRunStatus {
  conversationId: string
  status: 'running' | 'settled' | 'unknown'
  /**
   * Nodes the draft has recorded so far. This is the run's live progress signal:
   * one more node means one more operator the agent actually performed. A
   * verification run records nothing, so it stays 0 until it settles.
   */
  nodes: number
  elapsedMs: number
  /** Present once `status` is `settled`. */
  result?: UnattendedGenerationResult
}

/** Settled runs stay readable for this long, then are forgotten. */
const RUN_RETENTION_MS = 30 * 60_000
/** At most this many settled runs are kept, newest first. */
const RUN_CAPACITY = 16

interface TrackedRun {
  startedAt: number
  settledAt?: number
  result?: UnattendedGenerationResult
  /** A generation turn that THREW (rather than reporting failure) still has to
   * settle the run, or the caller polls a `running` entry forever. */
  failure?: string
  /** Live progress for a poller, when the run has any to report. */
  progress?: () => Promise<number>
}

const runs = new Map<string, TrackedRun>()

/** Register a long run and settle its entry however the work ends. */
function track(
  conversationId: string,
  work: Promise<UnattendedGenerationResult>,
  progress?: () => Promise<number>,
): GenerationRunHandle {
  const run: TrackedRun = { startedAt: Date.now(), ...(progress ? { progress } : {}) }
  runs.set(conversationId, run)
  pruneRuns()

  work.then(
    (result) => {
      run.settledAt = Date.now()
      run.result = result
    },
    (error: unknown) => {
      run.settledAt = Date.now()
      run.failure = error instanceof Error ? error.message : String(error)
    },
  )

  return { conversationId, status: 'running' }
}

/**
 * Kick off a generation turn and return its handle immediately.
 *
 * The turn is a full agent conversation against a live page — minutes, not
 * seconds — while the bridge replies under a response timeout. So the caller
 * starts here and polls {@link readGenerationRun}; nothing about the generation
 * itself changes.
 */
export function startGenerationRun(req: UnattendedGenerationRequest): GenerationRunHandle {
  const conversationId = `external-gen:${newId()}`
  return track(
    conversationId,
    generateWorkflowUnattended(req, conversationId),
    async () => actionNodesOf(await hydrateDraft(conversationId)).length,
  )
}

/**
 * Kick off a verification replay of a saved workflow and return its handle.
 *
 * Start/poll for the same reason generation is: the replay is bounded by
 * {@link VERIFY_BUDGET_MS}, not by the bridge's response timeout.
 */
export function startVerificationRun(req: UnattendedVerificationRequest): GenerationRunHandle {
  const conversationId = `external-verify:${newId()}`
  return track(conversationId, verifySavedWorkflowUnattended(req, conversationId))
}

/**
 * Kick off "replay, and repair the graph if the replay fails" for a saved
 * workflow.
 *
 * The progress a poller sees is the repair loop's event count — it stays 0
 * through the first replay, then climbs once candidates start being produced, so
 * a caller can tell "still measuring" from "actually repairing" without any new
 * protocol.
 */
export function startRepairRun(req: UnattendedRepairRequest): GenerationRunHandle {
  const conversationId = `external-repair:${newId()}`
  return track(
    conversationId,
    repairSavedWorkflowUnattended(req, conversationId),
    async () => autoRepairEvents(req.workflowId).length,
  )
}

/**
 * Snapshot one run — a generation turn or a verification replay; both are
 * tracked here. `unknown` covers both an id this worker never started and a
 * settled run the service worker has since dropped — the workflow, if it was
 * saved, still lives in storage and is listed by name there.
 */
export async function readGenerationRun(conversationId: string): Promise<GenerationRunStatus> {
  pruneRuns()
  const run = runs.get(conversationId)
  if (!run) return { conversationId, status: 'unknown', nodes: 0, elapsedMs: 0 }

  const now = Date.now()
  if (run.settledAt === undefined) {
    return {
      conversationId,
      status: 'running',
      nodes: run.progress ? await run.progress() : 0,
      elapsedMs: now - run.startedAt,
    }
  }

  return {
    conversationId,
    status: 'settled',
    // The saved graph is the node count once the draft has been closed.
    nodes: run.result?.workflow?.nodeCount ?? 0,
    elapsedMs: run.settledAt - run.startedAt,
    result: run.result ?? {
      ok: false,
      conversationId,
      error: run.failure ?? 'Run failed',
    },
  }
}

function pruneRuns(): void {
  const now = Date.now()
  for (const [id, run] of runs) {
    if (run.settledAt !== undefined && now - run.settledAt > RUN_RETENTION_MS) runs.delete(id)
  }
  const settled = [...runs.entries()].filter(([, run]) => run.settledAt !== undefined)
  if (settled.length <= RUN_CAPACITY) return
  for (const [id] of settled
    .sort((a, b) => (a[1].settledAt ?? 0) - (b[1].settledAt ?? 0))
    .slice(0, settled.length - RUN_CAPACITY)) {
    runs.delete(id)
  }
}
