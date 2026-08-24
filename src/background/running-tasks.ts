/**
 * Registry of tasks currently running in the service worker.
 *
 * A single source of truth shared by every entry point that does background
 * work — chat turns in the side panel, scheduled/Feishu/manual task runs, and
 * ad-hoc Feishu bot commands. The Tasks tab reads this to render a "running"
 * board and to offer a terminate button; the Feishu bot also streams each
 * recorded step back to the chat that started it.
 *
 * State is in-memory by design. A service worker is single-threaded and is
 * evicted after ~30 s of inactivity, which also kills whatever async work it
 * was doing — so a run that survived eviction would be a zombie with no code
 * driving it. The registry therefore does not need to be persisted; it is
 * rebuilt as new runs start. `chrome.storage.session` is intentionally avoided
 * to keep the module testable without a Chrome global.
 *
 * @module background/running-tasks
 */

/** Where a run was triggered from. */
export type RunSource = 'chat' | 'schedule' | 'feishu' | 'manual'

/** One progress line recorded for a run (a tool call, a status, an error). */
export interface RunStep {
  /** Epoch ms when the step was recorded. */
  at: number
  /** Machine-ish label: "tool", "status", "result", "error", "info". */
  kind: 'tool' | 'status' | 'result' | 'error' | 'info'
  /** Human-readable text, already suitable for display or sending to Feishu. */
  text: string
}

/** How a run ended. */
export type RunOutcomeKind = 'ok' | 'failed' | 'cancelled' | 'skipped'

/** A tracked in-flight run. */
export interface RunningTask {
  /** Stable id for this specific execution (distinct from the configured task id). */
  runId: string
  /**
   * Configured task id, when this run belongs to a saved task. Chat turns and
   * one-off Feishu instructions have none.
   */
  taskId?: string
  /** Display name: task name, or a short label for an ad-hoc run. */
  label: string
  source: RunSource
  /** Feishu chat id to stream steps to, when source is 'feishu'. */
  feishuChatId?: string
  startedAt: number
  steps: RunStep[]
  /** Shared abort signal; call abort() to request cancellation. */
  controller: AbortController
  /** Invoked once when the run is cancelled from the board. */
  onCancel?: () => void
}

/** A finished run, retained for the "recently completed" section of the board. */
export interface FinishedTask {
  runId: string
  taskId?: string
  label: string
  source: RunSource
  startedAt: number
  finishedAt: number
  outcome: RunOutcomeKind
  /** Final one-line summary or error, when available. */
  summary?: string
  steps: RunStep[]
}

const runs = new Map<string, RunningTask>()
/** Recent finished runs, newest first. Bounded to keep memory tiny. */
const finished: FinishedTask[] = []
const MAX_FINISHED = 30

/**
 * Hook invoked when a run settles. The background script registers it to
 * persist the finished run (with its steps) to `chrome.storage` so the run log
 * survives a service-worker restart. Kept as an injection point so this module
 * stays free of a `chrome`/storage dependency (and remains unit-testable).
 */
let persistFinished: ((run: FinishedTask) => void) | null = null

/** Registers (or clears, with null) the persistence callback for finished runs. */
export function setFinishedPersister(fn: ((run: FinishedTask) => void) | null): void {
  persistFinished = fn
}

/** Generates a run id without pulling in a uuid dependency. */
function newRunId(): string {
  // crypto.randomUUID exists in MV3 service workers and in tests.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export interface StartRunOptions {
  label: string
  source: RunSource
  taskId?: string
  feishuChatId?: string
  controller?: AbortController
  onCancel?: () => void
}

/**
 * Begins tracking a run. Returns the tracked record, which includes a fresh
 * AbortController (or the one passed in). Call {@link finishRun} when the work
 * settles.
 */
export function startRun(options: StartRunOptions): RunningTask {
  const controller = options.controller ?? new AbortController()
  const task: RunningTask = {
    runId: newRunId(),
    taskId: options.taskId,
    label: options.label,
    source: options.source,
    feishuChatId: options.feishuChatId,
    startedAt: Date.now(),
    steps: [],
    controller,
    onCancel: options.onCancel,
  }
  runs.set(task.runId, task)
  return task
}

/** Records a progress step on a run. No-op if the run already finished. */
export function addStep(
  runId: string,
  kind: RunStep['kind'],
  text: string,
): void {
  const task = runs.get(runId)
  if (!task) return
  task.steps.push({ at: Date.now(), kind, text })
}

/**
 * Attaches (or replaces) the cancellation callback for a run. The Feishu bot
 * uses this to post a "terminated" notice when a task started from chat is
 * stopped from the board — task-runner creates the run without knowing how to
 * reach Feishu, so the bot wires the callback in after the fact.
 */
export function setOnCancel(runId: string, onCancel: () => void): void {
  const task = runs.get(runId)
  if (task) task.onCancel = onCancel
}

export interface FinishOptions {
  outcome: RunOutcomeKind
  summary?: string
}

/**
 * Stops tracking a run as in-flight and moves it into the bounded completed
 * list so the board can show how it ended. The controller is dropped.
 */
export function finishRun(runId: string, options?: FinishOptions): void {
  const task = runs.get(runId)
  if (!task) return
  runs.delete(runId)
  const entry: FinishedTask = {
    runId: task.runId,
    taskId: task.taskId,
    label: task.label,
    source: task.source,
    startedAt: task.startedAt,
    finishedAt: Date.now(),
    outcome: options?.outcome ?? (task.controller.signal.aborted ? 'cancelled' : 'ok'),
    summary: options?.summary,
    steps: task.steps,
  }
  finished.unshift(entry)
  if (finished.length > MAX_FINISHED) finished.length = MAX_FINISHED
  // Persist asynchronously; failures must never break the in-memory board.
  if (persistFinished) {
    try {
      persistFinished(entry)
    } catch {
      /* persistence is best-effort */
    }
  }
}

/** Returns all running tasks, newest first. */
export function listRunning(): RunningTask[] {
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt)
}

/** Returns recently completed runs, newest first. */
export function listFinished(): FinishedTask[] {
  return [...finished]
}

/**
 * Seeds the in-memory "recently finished" list from persisted run logs. Called
 * once at worker startup so completed runs from before an eviction still appear
 * on the board. Already-present (in-memory) entries win, and the list is capped
 * to {@link MAX_FINISHED}. Persisted entries without steps are still shown as
 * summary rows.
 */
export function hydrateFinished(persisted: FinishedTask[]): void {
  const known = new Set(finished.map((r) => r.runId))
  for (const run of persisted) {
    if (known.has(run.runId)) continue
    finished.push(run)
    known.add(run.runId)
  }
  finished.sort((a, b) => b.finishedAt - a.finishedAt)
  if (finished.length > MAX_FINISHED) finished.length = MAX_FINISHED
}

/** Returns a single run, or undefined. */
export function getRun(runId: string): RunningTask | undefined {
  return runs.get(runId)
}

/** Removes a finished run from the in-memory "recently completed" board by id. */
export function forgetFinished(runId: string): void {
  const index = finished.findIndex((r) => r.runId === runId)
  if (index !== -1) finished.splice(index, 1)
}

/**
 * Requests cancellation of a run. The abort signal fires; the agent loop and
 * fetches observe it. The run finishes asynchronously and removes itself.
 * Returns false if there was no such run.
 *
 * If the run has an `onCancel` callback (the Feishu bot uses it to post a
 * "terminated" notice back to the originating chat), it is invoked once here.
 */
export function cancelRun(runId: string): boolean {
  const task = runs.get(runId)
  if (!task) return false
  task.controller.abort()
  if (task.onCancel) {
    try {
      task.onCancel()
    } catch {
      /* notification best-effort */
    }
  }
  return true
}

/** Test helper: clears all tracked runs. */
export function _resetRunningForTests(): void {
  runs.clear()
}
