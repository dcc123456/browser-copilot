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
  HOPELESS_REASON_KINDS,
  TAKEOVER_MAX_ATTEMPTS,
  buildTakeoverPrompt,
  classifyReason,
  parseTakeoverVerdict,
  outputVariableKeyOf,
  type TakeoverFix,
  type TakeoverReasonKind,
  type TakeoverReport,
} from '../../lib/workflow/ai-takeover'
import { BLOCK_BY_ID } from '../../lib/workflow/blocks/palette'
import type { WorkflowNode } from '../../lib/workflow/types'
import type { ProviderProfile } from '../../lib/types'
import type { ScopeWindow } from '../automation-scope'
import { runUnattendedPrompt, type UnattendedResult } from '../agent-unattended'
import type { AiTakeoverHook, AiTakeoverRequest } from './engine'

/** Cap per takeover attempt on model↔tool round trips. */
const TAKEOVER_TOOL_ROUNDS = 25

/** Default pause between takeover attempts (let page state settle). */
const ATTEMPT_DELAY_MS = 1500

export interface AiTakeoverDeps {
  /** Fallback scope when the request carries none (panel-window pinning). */
  scope?: ScopeWindow
  /**
   * Dedicated model for the takeover agent (a hard "see page + multi-round
   * tools" task). Undefined = the active chat model. Resolved by the caller
   * from `settings.takeoverModel`.
   */
  provider?: ProviderProfile
  /**
   * Brings the run's tab to the foreground before the agent starts, so the
   * "active tab of the scope window" the tools resolve IS the tab the
   * workflow was driving (multi-window / background-tab correctness).
   */
  pinTab?: (tabId: number) => Promise<void>
  /** Pause between failed attempts; tests pass 0. */
  attemptDelayMs?: number
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
  const attemptDelayMs = deps.attemptDelayMs ?? ATTEMPT_DELAY_MS
  return async (request: AiTakeoverRequest): Promise<{ completed: boolean; summary?: string; reasonKind?: TakeoverReasonKind }> => {
    const failingNode = request.workflow.drawflow.nodes.find((n) => n.id === request.failingNodeId)
    const info = nodeInfoOf(failingNode)
    const nodeLabel = info?.nodeLabel ?? request.failingNodeId

    const fail = async (
      reason: string,
      attempts: number,
      reasonKind?: TakeoverReasonKind,
    ): Promise<{ completed: false; reason: string; reasonKind?: TakeoverReasonKind }> => {
      deps.onTakeover?.({
        nodeId: request.failingNodeId,
        nodeLabel,
        completed: false,
        attempts,
        error: reason,
        ...(reasonKind ? { reasonKind } : {}),
      })
      return { completed: false, reason, ...(reasonKind ? { reasonKind } : {}) }
    }

    // Fail fast with a clear message when no model is configured.
    const settings = await getSettings()
    const provider = deps.provider ?? settings.providers.find((p) => p.id === settings.activeProviderId)
    if (!provider || !provider.apiKey.trim()) {
      return fail('未配置模型 provider / API Key，AI 接管不可用', 0)
    }

    // Bring the run's own tab to the foreground: the takeover tools resolve
    // "the active tab of the scope window", so without this a background tab
    // (or a multi-window setup) would have the agent act on the wrong page.
    if (typeof request.tabId === 'number' && deps.pinTab) {
      await deps.pinTab(request.tabId).catch(() => undefined)
    }

    // Takeover context: the run tail (per-block headers resolved to labels —
    // the engine emits them with empty text), the last completed nodes as the
    // anchor, the downstream nodes as do-NOT-do boundaries, and the failing
    // node with REAL param values.
    const labelOf = (nodeId: string): string => nodeInfoOf(
      request.workflow.drawflow.nodes.find((n) => n.id === nodeId),
    )?.nodeLabel ?? nodeId
    const promptSteps = request.steps
      .filter((step) => step.text.trim().length > 0 || step.kind === 'tool')
      .slice(-20)
      .map((step) => ({
        kind: step.kind,
        text:
          step.text.trim().length > 0
            ? step.text
            : `${labelOf(step.nodeId ?? '')}${step.nodeId === request.failingNodeId ? ' ✗ 该步骤失败' : ''}`,
      }))
    const previousNode = request.workflow.drawflow.nodes.find((n) => n.id === request.previousNodeId)
    const previousInfo = nodeInfoOf(previousNode)
    const previousNodeLine = previousInfo ? `← ${previousInfo.nodeLabel}` : undefined
    // Older anchors: the per-block markers of the last nodes before the
    // immediate predecessor (the agent orients better with a short trail).
    const anchorNodeIds = request.steps
      .filter((step) => step.kind === 'tool' && step.nodeId && step.nodeId !== request.failingNodeId)
      .map((step) => step.nodeId!)
    const earlierNodeIds = [...new Set(anchorNodeIds)].slice(-3, -1)
    const earlierNodeLines = earlierNodeIds.map((id) => `← ${labelOf(id)}`)
    // Downstream boundaries: what runs after this step (the agent must not do it).
    const downstreamIds = [
      ...new Set(
        request.workflow.drawflow.edges
          .filter((edge) => edge.source === request.failingNodeId)
          .map((edge) => edge.target),
      ),
    ].slice(0, 2)
    const upcomingNodeLines = downstreamIds.map((id) => labelOf(id))
    // Upstream chain: the nodes that ACTUALLY ran before the failure, with
    // ids + params — the evidence the agent needs to trace a root cause that
    // lives BEFORE the node that threw (bad read, wrong variable value, …).
    const upstreamIds = [...new Set(anchorNodeIds)].slice(-6)
    const upstream = upstreamIds.map((id) => {
      const node = request.workflow.drawflow.nodes.find((n) => n.id === id)
      const upstreamInfo = nodeInfoOf(node)
      return {
        id,
        line: `← ${upstreamInfo?.nodeLabel ?? labelOf(id)}`,
        params: node
          ? interpolateParams(
              Object.fromEntries(
                Object.entries(node.data).filter(
                  ([key]) => key !== 'description' && key !== 'blockId',
                ),
              ),
              request.variables,
            )
          : {},
      }
    })
    // Variable snapshot: wrong values here fingerprint the upstream culprit.
    const variableSnapshot: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(request.variables).slice(0, 20)) {
      const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
      variableSnapshot[key] = text.length > 160 ? `${text.slice(0, 160)}…` : value
    }
    // When the failed step declares an output variable, the agent MUST fill it.
    const outputVariable = outputVariableKeyOf(request.failedParams)

    let lastAttemptNote: string | undefined
    let lastAttemptTrace: string[] | undefined
    let lastReasonKind: TakeoverReasonKind | undefined
    let lastAnswer = ''
    for (let attempt = 1; attempt <= TAKEOVER_MAX_ATTEMPTS; attempt++) {
      // Let the page settle between attempts (transient states, animations).
      if (attempt > 1 && attemptDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, attemptDelayMs))
      }
      deps.onEvent?.('status', `AI 接管「${nodeLabel}」：第 ${attempt}/${TAKEOVER_MAX_ATTEMPTS} 次尝试（先看页面，再完成该步骤）`)
      const prompt = buildTakeoverPrompt({
        workflowName: request.workflow.name,
        workflowDescription: request.workflow.description,
        steps: promptSteps,
        ...(previousNodeLine ? { previousNodeLine } : {}),
        ...(earlierNodeLines.length > 0 ? { earlierNodeLines } : {}),
        ...(upstream.length > 0 ? { upstream } : {}),
        ...(Object.keys(variableSnapshot).length > 0 ? { variables: variableSnapshot } : {}),
        ...(upcomingNodeLines.length > 0 ? { upcomingNodeLines } : {}),
        ...(outputVariable ? { outputVariable } : {}),
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
        ...(lastAttemptTrace && lastAttemptTrace.length > 0 ? { lastAttemptTrace } : {}),
      })
      // Compact tool trace of THIS attempt — fed to the next attempt so it
      // never blindly repeats actions that already ran (fresh conversation
      // per attempt would otherwise mean zero memory).
      const trace: string[] = []
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
          onStep: (kind, text) => {
            if (kind === 'tool' || kind === 'result' || kind === 'error') {
              trace.push(`${kind === 'tool' ? '→' : kind === 'result' ? '←' : '!'} ${text}`)
              if (trace.length > 14) trace.splice(0, trace.length - 14)
            }
            deps.onEvent?.(kind, `🤖 ${text}`)
          },
          ...(deps.provider ? { provider: deps.provider } : {}),
        })
      } catch (error) {
        lastAttemptNote = error instanceof Error ? error.message : String(error)
        lastAttemptTrace = [...trace]
        lastReasonKind ??= classifyReason(lastAttemptNote)
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
          // Root-cause routing: the agent may point the fix at an UPSTREAM
          // node (bad value produced earlier). Only accept an id that really
          // exists in the graph — anything else falls back to the failed node.
          const fixNodeId =
            verdict.fixNodeId && verdict.fixNodeId !== request.failingNodeId &&
            request.workflow.drawflow.nodes.some((n) => n.id === verdict.fixNodeId)
              ? verdict.fixNodeId
              : request.failingNodeId
          const fixLabel = fixNodeId === request.failingNodeId ? nodeLabel : labelOf(fixNodeId)
          if (fixNodeId !== request.failingNodeId) {
            deps.onEvent?.(
              'info',
              `根因定位：失败源头在上游节点「${fixLabel}」，修复将指向它`,
            )
          }
          const keys = Object.keys(verdict.paramsPatch)
          fix = {
            nodeId: fixNodeId,
            nodeLabel: fixLabel,
            paramsPatch: verdict.paramsPatch,
            note: `AI 建议修正「${fixLabel}」参数${fixNodeId !== request.failingNodeId ? '（根因在失败节点的上游）' : ''}：${keys
              .map((key) => `${key}: ${preview(request.workflow.drawflow.nodes.find((n) => n.id === fixNodeId)?.data?.[key])} → ${preview(verdict.paramsPatch?.[key])}`)
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
      lastAttemptTrace = [...trace]
      lastReasonKind = verdict.reasonKind ?? classifyReason(`${verdict.summary} ${lastAnswer}`)
      deps.onEvent?.('info', `AI 接管第 ${attempt} 次尝试未完成：${lastAttemptNote}`)
      // Hopeless reasons (login wall, captcha) can NEVER succeed by retrying —
      // burning the remaining attempts would only waste model calls.
      if (lastReasonKind && (HOPELESS_REASON_KINDS as readonly string[]).includes(lastReasonKind)) {
        deps.onEvent?.('error', `AI 接管终止：该失败无法通过重试解决（${lastReasonKind}）`)
        return fail(lastAttemptNote, attempt, lastReasonKind)
      }
    }
    return fail(lastAttemptNote || 'AI 接管尝试均未完成该步骤', TAKEOVER_MAX_ATTEMPTS, lastReasonKind)
  }
}
