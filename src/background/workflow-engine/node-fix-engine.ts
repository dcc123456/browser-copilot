/**
 * Node Fix engine — the side-effectful bounded loop that repairs ONE operator
 * node against the live page.
 *
 * Each round: trial-run the operator → evaluate the node's success criteria →
 * (on failure) ask the AI for re-authored parameters → adopt them → repeat.
 * The node is "fixed" only when the operator executes without error AND every
 * success criterion holds. Nothing here mutates the caller's node data: the
 * verified parameters are returned for the user to apply manually.
 *
 * The real driver functions are used by default but every external action can
 * be injected (tests drive the loop without a page or a network).
 *
 * @module background/workflow-engine/node-fix-engine
 */

import { streamCompletion } from '../../lib/llm'
import { getSettings } from '../../lib/storage'
import {
  buildNodeFixPrompt,
  NODE_FIX_MAX_ROUNDS,
  nodeFixParamsPayloadOf,
  nodeFixReplyPayloadOf,
  nodeFixRequestPayloadOf,
  nodeFixVerdictPayloadOf,
  parseNodeFixReply,
  sanitizeNodeData,
  type NodeFixEvent,
  type NodeFixPromptInput,
  type NodeFixReply,
  type NodeFixResultData,
} from '../../lib/workflow/node-fix'
import { describeCondition, type WorkflowCondition } from '../../lib/workflow/conditions'
import { nodeGoalContractOf } from '../../lib/workflow/node-goal-contract'
import { operatorExecClass } from '../../lib/workflow/operator-class'
import { entityKeyFor, type TokenAttribution } from '../../lib/token-ledger'
import { createDriverConditionProbe, evaluateConditionWithProbe } from './condition-runtime'
import { executeOperatorNode } from './operator-exec'
import type { ScopeWindow } from '../automation-scope'
import { normalScopeFromWindowId } from '../automation-scope'

/**
 * One-shot LLM budget: 5 minutes, aligned with the AI review/debug budgets.
 * A thinking model can legitimately spend minutes on the goal + evidence
 * before any content; the abort signal bounds the wait on cancellation.
 */
const NODE_FIX_TIMEOUT_MS = 5 * 60_000

export interface NodeFixInput {
  sessionId: string
  blockId: string
  blockData: Record<string, unknown>
  userSuggestion?: string
  /** The failure output the user pasted; enough on its own to start a repair. */
  errorLog?: string
  windowId?: number
}

export interface NodeFixDeps {
  signal: AbortSignal
  emit: (event: NodeFixEvent) => void
  /** Trial-run the operator; defaults to the real executor. */
  executeNode?: (
    blockId: string,
    data: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string }>
  /** Evaluate all success criteria; defaults to the real driver probe. */
  evaluateCriteria?: (
    criteria: WorkflowCondition[],
    variables: Record<string, unknown>,
  ) => Promise<Array<{ condition: WorkflowCondition; satisfied: boolean }>>
  /** Ask the model for re-authored parameters; defaults to the real LLM call. */
  callModel?: (
    prompt: string,
    onProgress: (message: string) => void,
  ) => Promise<NodeFixReply | null>
  /** Which workflow these fix attempts belong to in the token ledger. */
  attribution?: TokenAttribution
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
}

/**
 * Resolve the automation scope for the editor's host window, so the trial run
 * and the condition probe act on the same page the user is looking at.
 */
async function resolveScope(windowId: number | undefined): Promise<ScopeWindow | undefined> {
  return normalScopeFromWindowId(windowId)
}

/** Build the default executeNode over the real single-node executor. */
function defaultExecuteNode(
  scope: ScopeWindow | undefined,
  signal: AbortSignal,
  attribution: TokenAttribution,
) {
  return async (
    blockId: string,
    data: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> => {
    // Record-only / engine-interpreted blocks can't be meaningfully trial-run
    // as a single node: skip execution — the success criteria are the arbiter.
    if (operatorExecClass(blockId) === 'record-only') {
      return { ok: true }
    }
    const result = await executeOperatorNode(blockId, data, {
      signal,
      scope,
      variables: {},
      attribution,
    })
    if (result.status === 'record-only') return { ok: true }
    if (result.status === 'failed') return { ok: false, error: result.error }
    return { ok: true }
  }
}

/** Build the default evaluateCriteria over the real driver probe. */
function defaultEvaluateCriteria(scope: ScopeWindow | undefined, signal: AbortSignal) {
  return async (
    criteria: WorkflowCondition[],
    variables: Record<string, unknown>,
  ): Promise<Array<{ condition: WorkflowCondition; satisfied: boolean }>> => {
    const probe = createDriverConditionProbe(signal, scope)
    return Promise.all(
      criteria.map(async (condition) => ({
        condition,
        satisfied: await evaluateConditionWithProbe(condition, variables, probe),
      })),
    )
  }
}

/** Default callModel over the active provider. Returns null when no provider. */
function defaultCallModel(
  signal: AbortSignal,
  attribution: TokenAttribution,
): NonNullable<NodeFixDeps['callModel']> {
  return async (prompt, onProgress) => {
    const settings = await getSettings()
    const provider = settings.providers.find((p) => p.id === settings.activeProviderId)
    if (!provider || !provider.apiKey.trim()) return null
    onProgress(`${provider.model}`)
    let streamed = ''
    const result = await streamCompletion(
      {
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model: provider.model,
        attribution,
        headers: provider.headers,
        ...(provider.thinkingEffort ? { thinking: provider.thinkingEffort } : {}),
        messages: [{ role: 'user', content: prompt }],
        signal: AbortSignal.any([signal, AbortSignal.timeout(NODE_FIX_TIMEOUT_MS)]),
      },
      {
        onText: (delta) => {
          streamed += delta
          if (streamed.trim().length === delta.trim().length) onProgress('first-token')
        },
      },
    )
    return parseNodeFixReply(result.content)
  }
}

/**
 * Check if preconditions are satisfied before executing the node.
 * Returns true when all preconditions hold or when there are none.
 */
async function checkPreconditions(
  preconditions: WorkflowCondition[] | undefined,
  variables: Record<string, unknown>,
  evaluateCriteria: NodeFixDeps['evaluateCriteria'],
): Promise<boolean> {
  if (!preconditions || preconditions.length === 0) return true
  const outcomes = await evaluateCriteria!(preconditions, variables)
  return outcomes.every((o) => o.satisfied)
}

/**
 * Run the bounded node-fix loop. Never throws for repair failures — timeout,
 * endpoint errors and unusable replies settle as `{ success:false, reason }`.
 * Cancellation is the one throw (AbortError), propagated to the caller.
 *
 * Strategy: Before each trial-run, check if the goal is already achieved from
 * the current page state. If preconditions hold AND all success criteria are
 * already met, the node is considered fixed without re-execution. Otherwise,
 * execute the node and verify only the unmet criteria.
 *
 * A node WITHOUT a stored contract is repaired from the user's prompt and/or the
 * error log they pasted. Its judgement is a temporary criterion the model states
 * with its first reply and the page then checks — never stored on the node (see
 * specs/2026-10-16-node-fix-from-prompt-only-design.md).
 */
export async function runNodeFix(
  input: NodeFixInput,
  deps: NodeFixDeps,
): Promise<NodeFixResultData> {
  const contract = nodeGoalContractOf(input.blockData)
  const hasEvidence = !!input.userSuggestion?.trim() || !!input.errorLog?.trim()
  if (!contract && !hasEvidence) {
    // Nothing to repair towards: no stored goal, no stated intent, no failure
    // output. This is the one case a fix cannot honestly start.
    return {
      success: false,
      rounds: 0,
      reason:
        'This node has no goal contract. Describe what is wrong or paste the error log to repair it without one.',
    }
  }
  const storedCriteria = contract?.successCriteria ?? []
  const preconditions = contract?.preconditions
  // The criterion agreed for THIS repair. Replaced by every reply that carries
  // one, and never written into `input.blockData`.
  let temporaryCriteria: WorkflowCondition[] = []
  // Whether the prompt-only "how will this be judged" question was already asked,
  // so a model that returns no criterion does not get asked three times.
  let checkAgreed = false
  const criteriaOf = (): WorkflowCondition[] => (contract ? storedCriteria : temporaryCriteria)

  const { signal, emit } = deps
  const scope = await resolveScope(input.windowId)
  // Node Fix is driven from the editor over one node, so the ledger keys the
  // spend by the fix session when the caller does not name a workflow.
  const usageAttribution: TokenAttribution = deps.attribution ?? {
    consumer: 'ai-debug',
    entityKey: entityKeyFor('session', input.sessionId),
  }
  const executeNode = deps.executeNode ?? defaultExecuteNode(scope, signal, usageAttribution)
  const evaluateCriteria = deps.evaluateCriteria ?? defaultEvaluateCriteria(scope, signal)
  const callModel: NonNullable<NodeFixDeps['callModel']> =
    deps.callModel ?? defaultCallModel(signal, usageAttribution)

  let working = { ...input.blockData }
  const variables: Record<string, unknown> = {}

  const push = (
    round: number,
    phase: NodeFixEvent['phase'],
    message: string,
    status: NodeFixEvent['status'] = 'running',
    payload?: NodeFixEvent['payload'],
  ): void => emit({ sessionId: input.sessionId, phase, round, message, status, payload })

  /** The model's answer, with its parameters already sanitised. */
  interface FixAnswer {
    rationale: string
    data: Record<string, unknown>
    verify?: WorkflowCondition
    /** The same answer as log text: what the AI returned, not what it was told. */
    responsePayload: string
  }

  /** Ask the model once, settling the common failures as a terminal result. */
  const askForFix = async (
    round: number,
    promptInput: NodeFixPromptInput,
    unmetDescription: string,
  ): Promise<FixAnswer | { fail: NodeFixResultData }> => {
    // The log reports the request from the SAME record the prompt is built from,
    // so the displayed request and the sent one cannot drift apart.
    push(round, 'diagnosing', unmetDescription, 'running', {
      request: nodeFixRequestPayloadOf(promptInput),
    })
    let reply: NodeFixReply | null
    try {
      reply = await callModel(buildNodeFixPrompt(promptInput), (message) =>
        push(round, 'diagnosing', message),
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (/timed?\s*out|abort/i.test(msg) && !signal.aborted) {
        return {
          fail: {
            success: false,
            rounds: round + 1,
            reason: `AI fix request timed out or was interrupted (budget ${NODE_FIX_TIMEOUT_MS / 60_000} min).`,
          },
        }
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return { fail: { success: false, rounds: round + 1, reason: msg } }
    }
    throwIfAborted(signal)
    if (!reply) {
      return {
        fail: {
          success: false,
          rounds: round + 1,
          reason:
            'No AI provider is configured (or its API key is empty). Configure a provider to use AI fix.',
        },
      }
    }
    const candidate = sanitizeNodeData(reply.data)
    if (!candidate) {
      return {
        fail: {
          success: false,
          rounds: round + 1,
          reason: 'The model returned unusable node parameters.',
        },
      }
    }
    const answer: FixAnswer = {
      rationale: reply.rationale,
      data: candidate,
      ...(reply.verify ? { verify: reply.verify } : {}),
      responsePayload: nodeFixReplyPayloadOf({
        rationale: reply.rationale,
        data: candidate,
        ...(reply.verify ? { verify: reply.verify } : {}),
      }),
    }
    return answer
  }

  for (let round = 0; round < NODE_FIX_MAX_ROUNDS; round += 1) {
    throwIfAborted(signal)
    const criteria = criteriaOf()

    // 1. observe
    push(round, 'observing', scope ? `window ${scope.windowId}` : 'active page')

    // 2. Check if goal is already achieved from current page state
    // This handles cases where partial execution already satisfied the goal.
    // Without a criterion to check there is nothing to pre-empt the run with.
    if (criteria.length > 0) {
      push(round, 'verifying', 'checking if goal already achieved', 'running', {
        request: criteria.map(describeCondition).join(' / '),
      })
      const precheckOutcomes = await evaluateCriteria(criteria, variables)
      throwIfAborted(signal)
      const precheckUnmet = precheckOutcomes.filter((o) => !o.satisfied)
      push(
        round,
        'verifying',
        `${criteria.length - precheckUnmet.length}/${criteria.length} held`,
        precheckUnmet.length === 0 ? 'done' : 'error',
        {
          response: nodeFixVerdictPayloadOf(precheckOutcomes),
        },
      )

      if (precheckUnmet.length === 0) {
        // All success criteria already hold — goal is achieved without execution
        push(round, 'verifying', 'all criteria already satisfied', 'done')
        return {
          success: true,
          rounds: round + 1,
          verifiedBy: 'criteria',
          proposedData: { ...input.blockData, ...working },
        }
      }
    }

    // 3. A prompt-only repair needs a check before it can claim success: agree one
    // with the model over the current parameters, then fall through and evaluate it
    // against the page the run just produced. Asked once — if no usable criterion
    // comes back, the run settles as `exec-only`.
    if (!contract && !checkAgreed) {
      checkAgreed = true
      const answer = await askForFix(
        round,
        {
          blockId: input.blockId,
          successCriteria: [],
          userSuggestion: input.userSuggestion ?? '',
          currentData: working,
          unmetCriteria: [],
          ...(input.errorLog?.trim() ? { errorLog: input.errorLog } : {}),
        },
        'agreeing how this repair will be judged',
      )
      if ('fail' in answer) return answer.fail
      working = answer.data
      if (answer.verify) {
        temporaryCriteria = [answer.verify]
        push(round, 'applying', `check: ${describeCondition(answer.verify)}`, 'done')
      }
      push(round, 'applying', answer.rationale, 'done', { response: answer.responsePayload })
    }

    // 4. Check preconditions before executing
    const preconditionsMet = await checkPreconditions(preconditions, variables, evaluateCriteria)
    throwIfAborted(signal)

    if (!preconditionsMet) {
      // Preconditions not met — need to diagnose why
      const preconditionOutcomes = await evaluateCriteria(preconditions || [], variables)
      throwIfAborted(signal)
      const unmetPreconditions = preconditionOutcomes.filter((o) => !o.satisfied)
      const answer = await askForFix(
        round,
        {
          blockId: input.blockId,
          goal: contract?.goal,
          successCriteria: criteria,
          userSuggestion: input.userSuggestion ?? '',
          currentData: working,
          execError:
            'Preconditions not met — cannot execute node until preconditions are satisfied',
          unmetCriteria: unmetPreconditions.map((o) => describeUnmet(o.condition)),
          ...(input.errorLog?.trim() ? { errorLog: input.errorLog } : {}),
        },
        'preconditions not met',
      )
      if ('fail' in answer) return answer.fail
      if (answer.verify) temporaryCriteria = [answer.verify]
      push(round, 'applying', answer.rationale, 'done', { response: answer.responsePayload })
      working = answer.data
      continue
    }

    // 5. trial-run (only when preconditions are met but some success criteria aren't)
    push(round, 'executing', input.blockId, 'running', {
      request: nodeFixParamsPayloadOf(working),
    })
    const exec = await executeNode(input.blockId, working)
    throwIfAborted(signal)
    const execError = exec.ok ? undefined : exec.error
    if (execError) push(round, 'executing', execError, 'error')

    // 6. verify success criteria after execution
    const ranCriteria = criteriaOf()
    push(round, 'verifying', `${ranCriteria.length} criteria`, 'running', {
      request: ranCriteria.map(describeCondition).join(' / '),
    })
    const outcomes = await evaluateCriteria(ranCriteria, variables)
    throwIfAborted(signal)
    const unmet = outcomes.filter((o) => !o.satisfied)
    push(
      round,
      'verifying',
      `${ranCriteria.length - unmet.length}/${ranCriteria.length} held`,
      unmet.length === 0 && !execError ? 'done' : 'error',
      { response: nodeFixVerdictPayloadOf(outcomes) },
    )

    if (!execError && unmet.length === 0) {
      // Keep the goal contract and any engine-only keys the model must not
      // author: the success payload is the working parameters merged back over
      // the base so reserved keys are preserved.
      return {
        success: true,
        rounds: round + 1,
        verifiedBy: ranCriteria.length > 0 ? 'criteria' : 'exec-only',
        proposedData: { ...input.blockData, ...working },
      }
    }

    // Last round: no point asking the model again.
    if (round === NODE_FIX_MAX_ROUNDS - 1) break

    // 7. diagnose
    const answer = await askForFix(
      round,
      {
        blockId: input.blockId,
        goal: contract?.goal,
        successCriteria: ranCriteria,
        userSuggestion: input.userSuggestion ?? '',
        currentData: working,
        ...(execError ? { execError } : {}),
        unmetCriteria: unmet.map((o) => describeUnmet(o.condition)),
        ...(input.errorLog?.trim() ? { errorLog: input.errorLog } : {}),
      },
      contract ? contract.goal : (input.userSuggestion ?? ''),
    )
    if ('fail' in answer) return answer.fail
    if (answer.verify) temporaryCriteria = [answer.verify]
    // 8. adopt candidate and re-verify next round.
    push(round, 'applying', answer.rationale, 'done', { response: answer.responsePayload })
    working = answer.data
  }

  return {
    success: false,
    rounds: NODE_FIX_MAX_ROUNDS,
    reason: `Could not satisfy the goal and all success criteria within ${NODE_FIX_MAX_ROUNDS} rounds.`,
  }
}

function describeUnmet(condition: WorkflowCondition): string {
  return describeCondition(condition)
}
