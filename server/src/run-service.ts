/**
 * The run service: queues, executes and records workflow runs.
 *
 * Each run:
 *  1. passes a reference pre-check (missing `execute-workflow` children fail
 *     fast with the exact ids to copy — see workflow-library);
 *  2. waits for a concurrency slot (`browser.maxConcurrent`);
 *  3. acquires a browser session (fresh context or persistent profile);
 *  4. executes through the PURE engine (`runWorkflow`) with the server
 *     executor map + workflow-library resolver injected;
 *  5. streams every engine step into an in-memory record and a JSONL file
 *     under `<dataDir>/runs/<runId>.jsonl`, artifacts into
 *     `<dataDir>/artifacts/<runId>/`.
 *
 * A hard wall-clock timeout (`runTimeoutMs`) and explicit cancellation both
 * abort the engine's signal; outcomes mirror the extension's
 * ok / failed / cancelled.
 *
 * @module server/run-service
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runWorkflow } from '../../src/background/workflow-engine/engine'
import type { Workflow } from '../../src/lib/workflow/types'
import { newId } from '../../src/lib/storage'
import type { RunnerConfig } from './config'
import { BrowserPool, type ProxySettings } from './browser-pool'
import { RunDriver } from './driver'
import { createExecutors, type ExecutorDeps } from './executors'
import { createServerTakeoverHook } from './agent/takeover'
import { referencesOfWorkflow, type WorkflowLibrary } from './workflow-library'

export type RunSource = 'api' | 'cron' | 'webhook' | 'feishu'
export type RunStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled'

export interface RunStep {
  at: number
  kind: string
  text: string
}

export interface RunRecord {
  id: string
  workflowId?: string
  label: string
  source: RunSource
  status: RunStatus
  profile?: string
  startedAt?: number
  finishedAt?: number
  summary?: string
  error?: string
  steps: RunStep[]
}

export interface StartRunOptions {
  workflow: Workflow
  workflowId?: string
  source: RunSource
  variables?: Record<string, unknown>
  profile?: string
  proxy?: ProxySettings
}

const STEPS_MEMORY_CAP = 500

export class RunService {
  private runs = new Map<string, RunRecord>()
  private controllers = new Map<string, AbortController>()
  /** Queued-but-not-started runs: cancelled ones are skipped on dequeue. */
  private cancelledQueued = new Set<string>()
  private waiters: (() => void)[] = []
  private activeCount = 0
  private finishListeners = new Set<(run: RunRecord) => void>()

  /** Subscribes to run settlement (used by the Feishu bot to report results). */
  onFinished(listener: (run: RunRecord) => void): () => void {
    this.finishListeners.add(listener)
    return () => {
      this.finishListeners.delete(listener)
    }
  }

  constructor(
    private readonly config: RunnerConfig,
    private readonly pool: BrowserPool,
    private readonly library: WorkflowLibrary,
  ) {}

  /** Runs currently in memory (queued + finished), newest first. */
  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id)
  }

  /**
   * Reference pre-check: every `execute-workflow` child of the workflow must
   * exist in the library (inline workflows are scanned the same way). Returns
   * the missing child ids; the caller refuses to start the run.
   */
  missingReferences(workflow: Workflow): string[] {
    const missing = new Set<string>()
    for (const ref of referencesOfWorkflow(workflow)) {
      if (!this.library.get(ref.childId)) {
        missing.add(ref.childId)
        // Transitive: children of the missing child can't be checked.
        continue
      }
    }
    return [...missing]
  }

  /**
   * Enqueues a run. Throws when the reference pre-check fails (HTTP 422 at
   * the API layer). Returns the run id immediately; execution proceeds
   * asynchronously.
   */
  start(opts: StartRunOptions): string {
    const missing = this.missingReferences(opts.workflow)
    if (missing.length > 0) {
      throw new MissingWorkflowError(missing)
    }

    const runId = newId()
    const record: RunRecord = {
      id: runId,
      status: 'queued',
      label: opts.workflow.name,
      source: opts.source,
      steps: [],
      ...(opts.workflowId ? { workflowId: opts.workflowId } : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
    }
    this.runs.set(runId, record)
    this.cancelledQueued.delete(runId)

    void this.enqueue(async () => {
      if (this.cancelledQueued.delete(runId)) {
        record.status = 'cancelled'
        record.finishedAt = Date.now()
        this.appendStep(runId, { at: Date.now(), kind: 'info', text: '排队中已取消' })
        this.persistFinal(record)
        return
      }
      await this.execute(runId, record, opts)
    })
    return runId
  }

  /** Cancels a queued or running run. Returns false when nothing to cancel. */
  cancel(runId: string): boolean {
    const record = this.runs.get(runId)
    if (!record) return false
    if (record.status === 'queued') {
      this.cancelledQueued.add(runId)
      return true
    }
    if (record.status === 'running') {
      this.controllers.get(runId)?.abort()
      return true
    }
    return false
  }

  /** The concurrency semaphore: runs the thunk when a slot frees up. */
  private async enqueue(thunk: () => Promise<void>): Promise<void> {
    const limit = Math.max(1, this.config.browser.maxConcurrent)
    if (this.activeCount >= limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.activeCount += 1
    try {
      await thunk()
    } finally {
      this.activeCount -= 1
      this.waiters.shift()?.()
    }
  }

  private async execute(runId: string, record: RunRecord, opts: StartRunOptions): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(runId, controller)
    const signal = controller.signal
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, this.config.runTimeoutMs))

    record.status = 'running'
    record.startedAt = Date.now()

    const artifactsDir = join(this.config.dataDir, 'artifacts', runId)
    try {
      mkdirSync(artifactsDir, { recursive: true })
      this.appendStep(runId, { at: Date.now(), kind: 'info', text: `开始运行: ${opts.workflow.name}` })

      const session = await this.pool.acquire({
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(opts.proxy ? { proxy: opts.proxy } : {}),
        artifactsDir,
      })
      const driver = new RunDriver(session)
      const provider =
        this.config.llm.apiKey && this.config.llm.baseUrl && this.config.llm.model
          ? {
              apiKey: this.config.llm.apiKey,
              baseUrl: this.config.llm.baseUrl,
              model: this.config.llm.model,
              ...(Object.keys(this.config.llm.headers).length > 0 ? { headers: this.config.llm.headers } : {}),
            }
          : null

      const deps: ExecutorDeps = {
        driver,
        config: this.config,
        artifactsDir,
        signal,
        provider,
      }

      const result = await runWorkflow(opts.workflow, {
        variables: { ...(opts.variables ?? {}) },
        signal,
        executors: createExecutors(deps),
        resolveWorkflow: this.library.resolveWorkflow,
        loopElementCounter: (selector) => driver.countElements(selector),
        evaluateExpression: async (code, vars) => {
          const evaluated = await driver.execJs(`return (${code});`, { vars })
          return evaluated.ok ? evaluated.data : undefined
        },
        ...(provider
          ? {
              aiTakeover: createServerTakeoverHook({
                driver,
                config: this.config,
                artifactsDir,
                signal,
                provider,
                onEvent: (kind, text) =>
                  this.appendStep(runId, { at: Date.now(), kind, text: `AI接管: ${text}` }),
              }),
            }
          : {}),
        onStep: (kind, _nodeId, text) => {
          this.appendStep(runId, { at: Date.now(), kind, text })
        },
      })

      record.status = result.outcome === 'ok' ? 'ok' : result.outcome === 'cancelled' ? 'cancelled' : 'failed'
      if (result.summary) record.summary = result.summary
      if (result.error) record.error = result.error
    } catch (error) {
      const aborted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
      if (aborted) {
        record.status = 'cancelled'
        record.error = signal.aborted ? '运行超时或被取消' : undefined
      } else {
        record.status = 'failed'
        record.error = error instanceof Error ? error.message : String(error)
      }
    } finally {
      clearTimeout(timeout)
      record.finishedAt = Date.now()
      this.appendStep(runId, {
        at: Date.now(),
        kind: record.status === 'ok' ? 'result' : 'error',
        text:
          record.status === 'ok'
            ? `运行完成${record.summary ? `: ${record.summary}` : ''}`
            : `运行${record.status === 'cancelled' ? '已取消' : '失败'}${record.error ? `: ${record.error}` : ''}`,
      })
      this.persistFinal(record)
      this.controllers.delete(runId)
      for (const listener of [...this.finishListeners]) {
        try {
          listener(record)
        } catch {
          // A listener must never break the run bookkeeping.
        }
      }
    }
  }

  /** Appends a step to the in-memory record (capped) and the JSONL file. */
  private appendStep(runId: string, step: RunStep): void {
    const record = this.runs.get(runId)
    if (record) {
      if (record.steps.length < STEPS_MEMORY_CAP) record.steps.push(step)
      else if (record.steps.length === STEPS_MEMORY_CAP) {
        record.steps.push({ at: step.at, kind: 'info', text: '…更多步骤见 JSONL 日志文件' })
      }
    }
    try {
      const dir = join(this.config.dataDir, 'runs')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, `${runId}.jsonl`), `${JSON.stringify(step)}\n`, 'utf8')
    } catch (error) {
      console.warn(`[runner] step log write failed: ${(error as Error).message}`)
    }
  }

  /** Writes the final record beside the step log for post-mortem reads. */
  private persistFinal(record: RunRecord): void {
    try {
      const dir = join(this.config.dataDir, 'runs')
      mkdirSync(dir, { recursive: true })
      const { steps: _steps, ...rest } = record
      writeFileSync(join(dir, `${record.id}.final.json`), JSON.stringify(rest, null, 2), 'utf8')
    } catch (error) {
      console.warn(`[runner] final record write failed: ${(error as Error).message}`)
    }
  }
}

/** Raised by {@link RunService.start} when referenced children are missing. */
export class MissingWorkflowError extends Error {
  constructor(readonly missing: string[]) {
    super(`缺少被引用的子工作流: ${missing.join(', ')}`)
    this.name = 'MissingWorkflowError'
  }
}
