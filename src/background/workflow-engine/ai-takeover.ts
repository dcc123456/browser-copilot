/**
 * Runtime AI takeover for failed workflow nodes (AI 接管).
 *
 * When a workflow run fails at a node, the engine calls the hook built here.
 * The hook runs the SAME tool-calling agent loop the side panel uses (via
 * `runUnattendedPrompt` in FULL mode), so the AI SEES THE LIVE PAGE (it starts
 * with `snapshot_page`) and completes the failed node's purpose with the page
 * tools — click, fill, navigate, read. On success it hands control back and
 * the remaining nodes keep running in the same run; on failure it retries up
 * to {@link TAKEOVER_MAX_ATTEMPTS} times, feeding each failed attempt back,
 * and then reports the reason so the run fails with it.
 *
 * Alongside the action the agent may propose a params fix for the failed node
 * (usually the selector it actually used). Fixes are NEVER applied to the
 * workflow here — they are collected as pending changes the user confirms.
 *
 * @module background/workflow-engine/ai-takeover
 */
import { getSettings } from '../../lib/storage'
import { interpolate } from '../../lib/workflow/interpolate'
import {
  TAKEOVER_MAX_ATTEMPTS,
  buildTakeoverPrompt,
  parseTakeoverVerdict,
  outputVariableKeyOf,
  type TakeoverFix,
  type TakeoverReport,
} from '../../lib/workflow/ai-takeover'
import { BLOCK_BY_ID } from '../../lib/workflow/blocks/palette'
import type { WorkflowNode } from '../../lib/workflow/types'
import type { ScopeWindow } from '../automation-scope'
import { runUnattendedPrompt, type UnattendedResult } from '../agent-unattended'
import type { AiTakeoverHook, AiTakeoverRequest } from './engine'

/** Cap per takeover attempt on model↔tool round trips. */
const TAKEOVER_TOOL_ROUNDS = 25

export interface AiTakeoverDeps {
  /** Fallback scope when the request carries none (panel-window pinning). */
  scope?: ScopeWindow
  /** Live progress sink (the debug session log): agent tool steps etc. */
  onEvent?: (kind: 'tool' | 'status' | 'result' | 'error' | 'info', text: string) => void
  /** Called once per takeover episode, when it settles (completed or not). */
  onTakeover?: (report: TakeoverReport) => void
  /** Injectable agent turn runner (tests stub this). */
  runPrompt?: typeof runUnattendedPrompt
}

/** Resolved display metadata for one node. */
interface NodeInfo {
  nodeLabel: string
  blockName: string
  blockId: string
  description: string
}

function nodeInfoOf(node: WorkflowNode | undefined): NodeInfo | undefined {
  if (!node) return undefined
  const blockId = typeof node.data?.['blockId'] === 'string' ? node.data['blockId'] : node.label
  const block = BLOCK_BY_ID.get(blockId)
  const description = typeof node.data?.['description'] === 'string' ? node.data['description'] : ''
  const name = block?.name ?? blockId
  return {
    blockId,
    blockName: name,
    description,
    nodeLabel: description ? `${name}: ${description}` : name,
  }
}

/** Interpolates top-level string params so the AI sees values, not tokens. */
function interpolateParams(
  params: Record<string, unknown>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (key === 'description' || key === 'blockId') continue
    out[key] = typeof value === 'string' ? interpolate(value, variables) : value
  }
  return out
}

/** Truncates a value for fix notes. */
function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/**
 * Builds the engine hook. One hook instance serves ONE debug session; every
 * takeover episode it settles is reported via `onTakeover` so the caller can
 * persist the pending fixes for user confirmation.
 */
export function createAiTakeover(deps: AiTakeoverDeps = {}): AiTakeoverHook {
  const runPrompt = deps.runPrompt ?? runUnattendedPrompt
  return async (request: AiTakeoverRequest): Promise<{ completed: boolean; summary?: string; reason?: string }> => {
    const failingNode = request.workflow.drawflow.nodes.find((n) => n.id === request.failingNodeId)
    const info = nodeInfoOf(failingNode)
    const nodeLabel = info?.nodeLabel ?? request.failingNodeId

    const fail = async (reason: string, attempts: number): Promise<{ completed: false; reason: string }> => {
      deps.onTakeover?.({
        nodeId: request.failingNodeId,
        nodeLabel,
        completed: false,
        attempts,
        error: reason,
      })
      return { completed: false, reason }
    }

    // Fail fast with a clear message when no model is configured.
    const settings = await getSettings()
    const provider = settings.providers.find((p) => p.id === settings.activeProviderId)
    if (!provider || !provider.apiKey.trim()) {
      return fail('未配置模型 provider / API Key，AI 接管不可用', 0)
    }

    // Takeover context: the run tail (empty per-block headers dropped), the
    // previous node as the anchor, and the failing node with REAL param values.
    const stepLines = request.steps.filter((step) => step.text.trim().length > 0).slice(-20)
    const previousNode = request.workflow.drawflow.nodes.find((n) => n.id === request.previousNodeId)
    const previousInfo = nodeInfoOf(previousNode)
    const previousNodeLine = previousInfo ? `← ${previousInfo.nodeLabel}` : undefined

    let lastAttemptNote: string | undefined
    let lastAnswer = ''
    for (let attempt = 1; attempt <= TAKEOVER_MAX_ATTEMPTS; attempt++) {
      deps.onEvent?.('status', `AI 接管「${nodeLabel}」：第 ${attempt}/${TAKEOVER_MAX_ATTEMPTS} 次尝试（先看页面，再完成该步骤）`)
      const prompt = buildTakeoverPrompt({
        workflowName: request.workflow.name,
        workflowDescription: request.workflow.description,
        steps: stepLines,
        previousNodeLine,
        failing: {
          blockId: info?.blockId ?? request.failedBlockId,
          blockName: info?.blockName,
          label: failingNode?.label,
          description: info?.description,
          params: interpolateParams(request.failedParams, request.variables),
        },
        error: request.failedError,
        attempt,
        maxAttempts: TAKEOVER_MAX_ATTEMPTS,
        ...(lastAttemptNote ? { lastAttemptNote } : {}),
      })
      let result: UnattendedResult
      try {
        result = await runPrompt(prompt, `workflow-takeover:${request.workflow.id}:${request.failingNodeId}:${attempt}`, 'full', {
          signal: request.signal,
          maxToolRounds: TAKEOVER_TOOL_ROUNDS,
          ...(request.scope?.windowId !== undefined
            ? { scopeWindowId: request.scope.windowId }
            : deps.scope?.windowId !== undefined
              ? { scopeWindowId: deps.scope.windowId }
              : {}),
          onStep: (kind, text) => deps.onEvent?.(kind, `🤖 ${text}`),
        })
      } catch (error) {
        lastAttemptNote = error instanceof Error ? error.message : String(error)
        deps.onEvent?.('error', `AI 接管第 ${attempt} 次尝试出错：${lastAttemptNote}`)
        continue
      }
      if (result.cancelled) return fail('AI 接管已取消', attempt)
      lastAnswer = result.answer ?? ''
      const verdict = parseTakeoverVerdict(lastAnswer)
      if (result.ok && verdict.completed) {
        // Best-effort output write-back: store the agent's produced value into
        // the failed node's declared output variable so downstream {{refs}}
        // resolve against what the AI actually read/produced.
        const outputKey = failingNode ? outputVariableKeyOf(request.failedParams) : undefined
        if (outputKey && verdict.output !== undefined) request.variables[outputKey] = verdict.output
        let fix: TakeoverFix | undefined
        if (verdict.paramsPatch && Object.keys(verdict.paramsPatch).length > 0) {
          const keys = Object.keys(verdict.paramsPatch)
          fix = {
            nodeId: request.failingNodeId,
            nodeLabel,
            paramsPatch: verdict.paramsPatch,
            note: `AI 建议修正「${nodeLabel}」参数：${keys
              .map((key) => `${key}: ${preview(failingNode?.data?.[key])} → ${preview(verdict.paramsPatch?.[key])}`)
              .join('；')}`,
          }
        }
        deps.onEvent?.('result', `AI 接管「${nodeLabel}」完成：${verdict.summary}`)
        deps.onTakeover?.({
          nodeId: request.failingNodeId,
          nodeLabel,
          completed: true,
          attempts: attempt,
          summary: verdict.summary,
          ...(fix ? { fix } : {}),
        })
        return { completed: true, summary: verdict.summary }
      }
      lastAttemptNote = verdict.summary || result.error || lastAnswer.slice(0, 200) || '（无说明）'
      deps.onEvent?.('info', `AI 接管第 ${attempt} 次尝试未完成：${lastAttemptNote}`)
    }
    return fail(lastAttemptNote || 'AI 接管尝试均未完成该步骤', TAKEOVER_MAX_ATTEMPTS)
  }
}
