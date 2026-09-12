/**
 * Server-side AI takeover (AI 接管) for failed workflow nodes.
 *
 * The engine calls the injected hook when a node fails; this implementation
 * runs the server agent loop (full mode) on the run's live page so the AI
 * SEES THE PAGE and completes the failed step, then reports back. Prompt
 * building and verdict parsing reuse the extension's pure helpers
 * (`lib/workflow/ai-takeover.ts`), so prompt/verdict semantics stay identical.
 *
 * Unlike the extension, there is no user to confirm param patches — patches
 * are parsed but only REPORTED in the run log, never applied (same policy as
 * the extension's pending-fix review, minus the UI).
 *
 * @module server/agent/takeover
 */

import {
  HOPELESS_REASON_KINDS,
  failureSignature,
  isRepeatedHopelessFailure,
  takeoverMaxAttempts,
  takeoverToolRounds,
  buildTakeoverPrompt,
  classifyReason,
  parseTakeoverVerdict,
  outputVariableKeyOf,
  type TakeoverReasonKind,
} from '../../../src/lib/workflow/ai-takeover'
import { detectPreflightHints, observerPreflightEnabled } from '../../../src/lib/workflow/observer'
import { interpolate } from '../../../src/lib/workflow/interpolate'
import { patchNodeParams } from '../../../src/lib/workflow/auto-debug-patch'
import type {
  AiTakeoverHook,
  AiTakeoverRequest,
} from '../../../src/background/workflow-engine/engine'
import type { ExecutorDeps } from '../executors'
import { runAgentLoop } from './agent-loop'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TakeoverDeps extends ExecutorDeps {
  /** Progress sink (wired to the run log by the run service). */
  onEvent?: (kind: 'tool' | 'status' | 'result' | 'error' | 'info', text: string) => void
}

function blockIdOfNode(request: AiTakeoverRequest): string {
  const node = request.workflow.drawflow.nodes.find((n) => n.id === request.failingNodeId)
  const fromData = node?.data?.['blockId']
  if (typeof fromData === 'string' && fromData) return fromData
  return node?.label ?? request.failedBlockId
}

function nodeLabelOf(request: AiTakeoverRequest): string {
  const node = request.workflow.drawflow.nodes.find((n) => n.id === request.failingNodeId)
  if (!node) return request.failingNodeId
  const description = typeof node.data?.['description'] === 'string' ? node.data['description'] : ''
  const blockId = blockIdOfNode(request)
  return description ? `${blockId}: ${description}` : blockId
}

/** Builds the takeover hook for ONE run (the deps carry its driver session). */
export function createServerTakeoverHook(deps: TakeoverDeps): AiTakeoverHook {
  const { provider, signal } = deps
  const onEvent = deps.onEvent ?? (() => {})

  return async (
    request: AiTakeoverRequest,
  ): Promise<{
    completed: boolean
    summary?: string
    reason?: string
    reasonKind?: TakeoverReasonKind
  } | null> => {
    const fail = (reason: string, reasonKind?: TakeoverReasonKind) => ({
      completed: false as const,
      reason,
      ...(reasonKind ? { reasonKind } : {}),
    })

    if (!provider || !provider.apiKey.trim()) {
      return fail('未配置模型 provider / API Key，AI 接管不可用（服务端 BC_LLM_*）')
    }

    const blockId = blockIdOfNode(request)
    const nodeLabel = nodeLabelOf(request)
    const outputVariable = outputVariableKeyOf(request.failedParams)
    // Tab pinning (M2-13): the takeover must act on the SAME tab the run is
    // driving. The driver is per-run, but we call the target out explicitly so
    // multi-tab runs log a consistent targetTabId (acceptance #4) and never
    // drift to a stray tab.
    const targetTabId = request.tabId
    if (targetTabId != null) onEvent('info', `接管锁定目标 tab ${targetTabId}（与运行日志一致）`)
    onEvent('status', `AI 接管节点 ${nodeLabel}`)

    // M3-17: optional read-only Observer preflight. When enabled, inspect the
    // failing context and skip the (expensive) agent run on a captcha/login
    // wall, or surface a popup hint. Default OFF (BC_OBSERVER_PREFLIGHT).
    if (observerPreflightEnabled()) {
      const hints = detectPreflightHints({ error: request.failedError })
      if (hints.hopeless && hints.kind) {
        onEvent('error', `AI 接管预检终止：${hints.message}`)
        return fail(hints.message, hints.kind)
      }
      if (hints.kind || hints.message !== '预检未发现明显阻断（验证码/登录墙/弹窗）') {
        onEvent('info', `AI 接管预检：${hints.message}`)
      }
    }

    // Interpolate string params so the AI sees values, not {{tokens}}.
    const params: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(request.failedParams)) {
      if (key === 'description' || key === 'blockId') continue
      params[key] = typeof value === 'string' ? interpolate(value, request.variables) : value
    }

    let lastNote: string | undefined
    let lastTrace: string[] = []
    const signatures: string[] = []
    const MAX_ATTEMPTS = takeoverMaxAttempts()
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (request.signal.aborted) return fail('运行已取消')

      const prompt = buildTakeoverPrompt({
        workflowName: request.workflow.name,
        ...(request.workflow.description
          ? { workflowDescription: request.workflow.description }
          : {}),
        steps: request.steps.map((line) => ({ kind: line.kind, text: line.text })),
        variables: request.variables,
        outputVariable,
        ...(lastNote ? { lastAttemptNote: lastNote } : {}),
        ...(lastTrace.length > 0 ? { lastAttemptTrace: lastTrace } : {}),
        failing: { blockId, params },
        error: request.failedError,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
      })

      const trace: string[] = []
      const result = await runAgentLoop({
        provider,
        prompt,
        mode: 'full',
        maxRounds: takeoverToolRounds(),
        signal: request.signal ?? signal,
        driver: deps.driver,
        artifactsDir: deps.artifactsDir,
        onStep: (kind, text) => {
          if (kind === 'tool' || kind === 'error' || kind === 'result')
            trace.push(`[${kind}] ${text}`)
          onEvent(kind, text)
        },
      })

      if (result.cancelled) return fail('运行已取消')
      if (!result.ok) {
        lastNote = result.error ?? '未知失败'
        lastTrace = trace
        onEvent('error', `AI 接管尝试 ${attempt} 失败: ${lastNote}`)
        continue
      }

      const verdict = parseTakeoverVerdict(result.answer ?? '')
      if (verdict.completed) {
        // Write the produced value into the failed step's output variable, so
        // downstream references resolve (same contract as the extension).
        if (verdict.output !== undefined && outputVariable) {
          request.variables[outputVariable] = verdict.output
        }
        if (verdict.paramsPatch && Object.keys(verdict.paramsPatch).length > 0) {
          const fixNodeId = verdict.fixNodeId ?? request.failingNodeId
          onEvent(
            'info',
            `AI 接管建议参数修正: ${JSON.stringify({ nodeId: fixNodeId, patch: verdict.paramsPatch })}`,
          )
          // Closed loop, OPT-IN: when BC_TAKEOVER_APPLY_PATCH=1 the proposed fix
          // is applied to the in-memory workflow copy so the producer's next
          // run starts from the corrected graph, and an audit artifact is
          // written. Default OFF — the server never edits the graph silently.
          if (process.env.BC_TAKEOVER_APPLY_PATCH === '1') {
            const result = patchNodeParams(request.workflow, fixNodeId, verdict.paramsPatch)
            if (result.changed) {
              request.workflow = result.workflow
              onEvent('info', `已应用接管修复到内存副本：${result.changes.join('；')}`)
              if (deps.artifactsDir) {
                const artifact = join(
                  deps.artifactsDir,
                  `takeover-patch-${request.workflow.id}.json`,
                )
                writeFileSync(
                  artifact,
                  JSON.stringify(
                    {
                      workflowId: request.workflow.id,
                      nodeId: fixNodeId,
                      changes: result.changes,
                      patch: verdict.paramsPatch,
                    },
                    null,
                    2,
                  ),
                )
                onEvent('info', `接管修复审计产物已写入: ${artifact}`)
              }
            }
          } else {
            onEvent('info', '参数修正未自动应用（默认行为；置 BC_TAKEOVER_APPLY_PATCH=1 可启用）')
          }
        }
        onEvent('result', verdict.summary)
        return { completed: true, summary: verdict.summary }
      }

      const reasonKind = verdict.reasonKind ?? classifyReason(verdict.summary)
      lastNote = verdict.summary || '(no summary)'
      lastTrace = trace
      onEvent('error', `AI 接管尝试 ${attempt}/${MAX_ATTEMPTS} 未完成: ${lastNote}`)
      // Same failure three times in a row is hopeless regardless of reason —
      // stop early instead of spending the remaining attempts.
      signatures.push(failureSignature(request.failingNodeId, lastNote))
      if (isRepeatedHopelessFailure(signatures)) {
        return fail(
          `AI 接管相同失败连续 3 次，重试无意义（${reasonKind ?? 'repeat'}）: ${lastNote}`,
          reasonKind,
        )
      }
      if (reasonKind && HOPELESS_REASON_KINDS.includes(reasonKind)) {
        return fail(`AI 接管判定为不可恢复（${reasonKind}）: ${lastNote}`, reasonKind)
      }
    }

    return fail(`AI 接管 ${MAX_ATTEMPTS} 次尝试均未完成: ${lastNote ?? '(无原因)'}`)
  }
}
