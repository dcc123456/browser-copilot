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
  TAKEOVER_MAX_ATTEMPTS,
  buildTakeoverPrompt,
  classifyReason,
  parseTakeoverVerdict,
  outputVariableKeyOf,
  type TakeoverReasonKind,
} from '../../../src/lib/workflow/ai-takeover'
import { interpolate } from '../../../src/lib/workflow/interpolate'
import type { AiTakeoverHook, AiTakeoverRequest } from '../../../src/background/workflow-engine/engine'
import type { ExecutorDeps } from '../executors'
import { runAgentLoop } from './agent-loop'

/** Cap per takeover attempt on model↔tool round trips (mirrors extension). */
const TAKEOVER_TOOL_ROUNDS = 25

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

  return async (request: AiTakeoverRequest): Promise<{
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
    onEvent('status', `AI 接管节点 ${nodeLabel}`)

    // Interpolate string params so the AI sees values, not {{tokens}}.
    const params: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(request.failedParams)) {
      if (key === 'description' || key === 'blockId') continue
      params[key] = typeof value === 'string' ? interpolate(value, request.variables) : value
    }

    let lastNote: string | undefined
    let lastTrace: string[] = []
    for (let attempt = 1; attempt <= TAKEOVER_MAX_ATTEMPTS; attempt++) {
      if (request.signal.aborted) return fail('运行已取消')

      const prompt = buildTakeoverPrompt({
        workflowName: request.workflow.name,
        ...(request.workflow.description ? { workflowDescription: request.workflow.description } : {}),
        steps: request.steps.map((line) => ({ kind: line.kind, text: line.text })),
        variables: request.variables,
        outputVariable,
        ...(lastNote ? { lastAttemptNote: lastNote } : {}),
        ...(lastTrace.length > 0 ? { lastAttemptTrace: lastTrace } : {}),
        failing: { blockId, params },
        error: request.failedError,
        attempt,
        maxAttempts: TAKEOVER_MAX_ATTEMPTS,
      })

      const trace: string[] = []
      const result = await runAgentLoop({
        provider,
        prompt,
        mode: 'full',
        maxRounds: TAKEOVER_TOOL_ROUNDS,
        signal: request.signal ?? signal,
        driver: deps.driver,
        artifactsDir: deps.artifactsDir,
        onStep: (kind, text) => {
          if (kind === 'tool' || kind === 'error' || kind === 'result') trace.push(`[${kind}] ${text}`)
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
          onEvent(
            'info',
            `AI 接管建议参数修正（未自动应用）: ${JSON.stringify({
              nodeId: verdict.fixNodeId ?? request.failingNodeId,
              patch: verdict.paramsPatch,
            })}`,
          )
        }
        onEvent('result', verdict.summary)
        return { completed: true, summary: verdict.summary }
      }

      const reasonKind = verdict.reasonKind ?? classifyReason(verdict.summary)
      lastNote = verdict.summary || '(no summary)'
      lastTrace = trace
      onEvent('error', `AI 接管尝试 ${attempt}/${TAKEOVER_MAX_ATTEMPTS} 未完成: ${lastNote}`)
      if (reasonKind && HOPELESS_REASON_KINDS.includes(reasonKind)) {
        return fail(`AI 接管判定为不可恢复（${reasonKind}）: ${lastNote}`, reasonKind)
      }
    }

    return fail(`AI 接管 ${TAKEOVER_MAX_ATTEMPTS} 次尝试均未完成: ${lastNote ?? '(无原因)'}`)
  }
}
