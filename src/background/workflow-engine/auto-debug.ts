/**
 * Orchestrates the workflow auto-debug loop.
 *
 * Runs the workflow once; when it fails, iterates up to `maxAIRounds` times:
 * gather failure context → ask the AI for one repair decision → apply the
 * pure patch ops → save → re-run. Stops on the first passing run, an
 * unfixable verdict, an unusable decision, or the round budget.
 *
 * This module is deliberately chrome-free: every side effect (executing a run,
 * calling the model, persisting the workflow, probing the page) is injected,
 * mirroring the pure-engine pattern of `workflow-engine/engine.ts`. The real
 * wiring lives in the service-worker command handler (`background/index.ts`).
 *
 * @module background/workflow-engine/auto-debug
 */
import type { Workflow } from '../../lib/workflow/types'
import {
  applyDebugDecision,
  describeStrategy,
  NoProviderError,
  type DebugDecision,
  type DebugFailureContext,
  type DebugPageFacts,
  type DebugRound,
  type DebugStepLine,
  type WorkflowDebugResult,
} from '../../lib/workflow/auto-debug-patch'

/** One executed attempt as the orchestrator sees it. */
export interface RunAttempt {
  runId: string
  outcome: 'ok' | 'failed' | 'cancelled'
  summary?: string
  error?: string
  /** Engine step lines collected during the run (for failure attribution). */
  steps: DebugStepLine[]
}

export interface AutoDebugDeps {
  /** Executes one attempt of the workflow. */
  run: (workflow: Workflow) => Promise<RunAttempt>
  /** Asks the model for one repair decision. */
  aiDecide: (ctx: DebugFailureContext) => Promise<DebugDecision>
  /** Persists a modified workflow. */
  save: (workflow: Workflow) => Promise<void>
  /** Best-effort probe: how many page elements a selector currently matches. */
  probe?: (selector: string) => Promise<number | null>
  /** Best-effort page identity (url/title) for the AI context. */
  pageFacts?: () => Promise<{ url?: string; title?: string } | null>
  /**
   * Best-effort page inspection around a failed selector: target element
   * status, similar candidate elements, interactive elements. The result is
   * passed through to the AI context as `pageFacts.elements`.
   */
  inspectPage?: (selector: string) => Promise<unknown>
  /**
   * Live progress sink for the debug session (run board / panel log), so the
   * user watches what the AI is doing instead of waiting silently.
   */
  onDebugStep?: (kind: 'info' | 'status' | 'error' | 'result', text: string) => void
  /** Max AI fix rounds after the first failed run (default 2). */
  maxAIRounds?: number
}

/** Workflow ids with a debug session currently in flight. */
const inFlight = new Set<string>()

/**
 * Label of the tracked run that wraps a debug session. The panel's live log
 * modal polls the running-tasks board for this label, so both sides must
 * agree on the format.
 */
export function debugRunLabel(workflowName: string): string {
  return `AI 调试: ${workflowName}`
}

/**
 * Runs the debug loop for one workflow. A second concurrent debug of the same
 * workflow is rejected immediately (two AI loops editing one graph would race);
 * different workflows may debug in parallel.
 */
export async function debugWorkflow(
  workflow: Workflow,
  deps: AutoDebugDeps,
): Promise<WorkflowDebugResult> {
  if (inFlight.has(workflow.id)) {
    return {
      ok: false,
      attempts: 0,
      workflowModified: false,
      summary: '该工作流已在调试中，请等待当前调试结束',
      rounds: [],
    }
  }
  inFlight.add(workflow.id)
  try {
    return await runDebugLoop(workflow, deps)
  } finally {
    inFlight.delete(workflow.id)
  }
}

/**
 * The node that failed, from the collected engine steps: the last `error`
 * line that carries a node id. Engine-level failures (step limit, thrown
 * errors outside a block) have no such line and are reported unpatched.
 */
export function failingNodeIdOf(steps: DebugStepLine[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step && step.kind === 'error' && step.nodeId) return step.nodeId
  }
  return undefined
}

/**
 * Assembles the AI failure context: graph + failing node + error + step tail +
 * best-effort page facts (url/title, and how many elements the failing node's
 * selector matches right now — the strongest hint for "the page changed").
 */
export async function buildFailureContext(
  workflow: Workflow,
  failingNodeId: string | undefined,
  error: string,
  steps: DebugStepLine[],
  deps: Pick<AutoDebugDeps, 'probe' | 'pageFacts' | 'inspectPage'>,
): Promise<DebugFailureContext> {
  const facts: DebugPageFacts = {}
  if (deps.pageFacts) {
    try {
      const page = await deps.pageFacts()
      if (page?.url) facts.url = page.url
      if (page?.title) facts.title = page.title
    } catch {
      /* page facts are optional */
    }
  }
  if (deps.probe && failingNodeId) {
    const node = workflow.drawflow.nodes.find((n) => n.id === failingNodeId)
    const data = node?.data ?? {}
    const selector =
      typeof data['selector'] === 'string' && data['selector']
        ? data['selector']
        : typeof data['cssSelector'] === 'string' && data['cssSelector']
          ? data['cssSelector']
          : ''
    if (selector) {
      try {
        const matches = await deps.probe(selector)
        if (matches !== null) facts.selectorMatches = { [selector]: matches }
      } catch {
        /* probe failures just omit the fact */
      }
      // Inspect the page around that selector: the AI repairs selectors and
      // logic from real elements, not guesses.
      if (deps.inspectPage) {
        try {
          const elements = await deps.inspectPage(selector)
          if (elements !== null && elements !== undefined) facts.elements = elements
        } catch {
          /* inspection failures just omit the fact */
        }
      }
    }
  }
  return {
    workflow,
    ...(failingNodeId ? { failingNodeId } : {}),
    error,
    steps: steps.slice(-30),
    ...(Object.keys(facts).length > 0 ? { pageFacts: facts } : {}),
  }
}

/** The debug loop itself (see {@link debugWorkflow}). */
async function runDebugLoop(
  workflow: Workflow,
  deps: AutoDebugDeps,
): Promise<WorkflowDebugResult> {
  const maxRounds = Math.max(1, deps.maxAIRounds ?? 2)
  const rounds: DebugRound[] = []
  let attempts = 0
  let modified = false
  let lastRunId: string | undefined
  let lastError: string | undefined

  const log = (kind: 'info' | 'status' | 'error' | 'result', text: string): void => {
    deps.onDebugStep?.(kind, text)
  }

  const runOnce = async (wf: Workflow, label: string): Promise<RunAttempt> => {
    log('status', label)
    const attempt = await deps.run(wf)
    attempts += 1
    lastRunId = attempt.runId
    return attempt
  }

  // Attempt 1: plain run — a passing workflow needs no debugging at all.
  let attempt = await runOnce(workflow, '开始第 1 次运行…')
  if (attempt.outcome === 'ok') {
    log('result', attempt.summary || '运行成功，无需调试')
    return {
      ok: true,
      attempts,
      workflowModified: false,
      summary: attempt.summary || '运行成功，无需调试',
      ...(lastRunId ? { lastRunId } : {}),
      rounds,
    }
  }
  if (attempt.outcome === 'cancelled') {
    log('info', '运行已取消，调试结束')
    return {
      ok: false,
      cancelled: true,
      attempts,
      workflowModified: false,
      summary: '运行已取消',
      ...(lastRunId ? { lastRunId } : {}),
      rounds,
    }
  }
  lastError = attempt.error ?? attempt.summary
  log('error', `运行失败：${lastError ?? '(无错误详情)'}`)

  let current = workflow
  for (let round = 0; round < maxRounds; round++) {
    log('status', `开始第 ${round + 1} 轮 AI 修复（剩余 ${maxRounds - round} 轮预算）…`)
    const failingNodeId = failingNodeIdOf(attempt.steps)
    if (!failingNodeId) {
      // Engine-level failure without an attributable node: nothing to patch.
      log('error', '无法定位失败节点（引擎级错误），调试终止')
      break
    }

    let decision: DebugDecision
    try {
      log('status', '正在收集失败上下文并检查页面元素…')
      const ctx = await buildFailureContext(
        current,
        failingNodeId,
        attempt.error ?? attempt.summary ?? '',
        attempt.steps,
        deps,
      )
      for (const [selector, matches] of Object.entries(ctx.pageFacts?.selectorMatches ?? {})) {
        log('info', `页面探测：${selector} 当前匹配 ${matches} 个元素`)
      }
      if (ctx.pageFacts?.elements !== undefined) log('info', '已读取页面元素清单（目标元素状态 + 候选 + 可交互元素）')
      log('status', '正在请求 AI 诊断…')
      decision = await deps.aiDecide(ctx)
    } catch (error) {
      const text =
        error instanceof NoProviderError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error)
      log('error', `AI 诊断失败：${text}`)
      rounds.push({
        diagnosis: text,
        strategy: 'unfixable',
        changes: [],
        runOutcome: attempt.outcome,
        error: text,
      })
      break
    }

    log('result', `AI 诊断：${decision.diagnosis || '（无诊断）'}`)
    log('status', `修复策略：${describeStrategy(decision.strategy)}`)

    const applied = applyDebugDecision(current, failingNodeId, decision)
    if (!applied.changed) {
      // Unusable / no-op decision: stop instead of looping on a broken graph.
      log('error', `该决策未产生有效修改：${applied.changes.join('；') || '无变更'}`)
      rounds.push({
        diagnosis: decision.diagnosis,
        strategy: decision.strategy,
        changes: applied.changes,
        runOutcome: attempt.outcome,
        error: attempt.error,
      })
      break
    }
    for (const change of applied.changes) log('info', change)

    current = applied.workflow
    try {
      await deps.save(current)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      log('error', `保存修改失败：${text}`)
      rounds.push({
        diagnosis: decision.diagnosis,
        strategy: decision.strategy,
        changes: [`保存修改失败：${text}`],
        runOutcome: attempt.outcome,
        error: text,
      })
      break
    }
    modified = true
    log('status', '修改已保存到工作流，正在重新运行验证…')

    // Attempt 2..n: verify the repair with a fresh run.
    attempt = await runOnce(current, `开始验证运行（第 ${attempts + 1} 次尝试）…`)
    rounds.push({
      diagnosis: decision.diagnosis,
      strategy: decision.strategy,
      changes: applied.changes,
      runOutcome: attempt.outcome,
      ...(attempt.error ? { error: attempt.error } : {}),
    })
    if (attempt.outcome === 'ok') {
      log('result', attempt.summary || '验证通过：修复后运行成功')
      return {
        ok: true,
        attempts,
        workflowModified: true,
        summary: attempt.summary || 'AI 调试修复后运行成功',
        ...(lastRunId ? { lastRunId } : {}),
        rounds,
      }
    }
    if (attempt.outcome === 'cancelled') {
      log('info', '验证运行已取消，调试结束')
      return {
        ok: false,
        cancelled: true,
        attempts,
        workflowModified: true,
        summary: '运行已取消',
        ...(lastRunId ? { lastRunId } : {}),
        rounds,
      }
    }
    lastError = attempt.error ?? attempt.summary
    log('error', `验证运行仍失败：${lastError ?? '(无错误详情)'}`)
  }

  log('error', lastError || 'AI 调试未能修复该工作流')
  return {
    ok: false,
    attempts,
    workflowModified: modified,
    summary: lastError || 'AI 调试未能修复该工作流',
    error: lastError,
    ...(lastRunId ? { lastRunId } : {}),
    rounds,
  }
}
