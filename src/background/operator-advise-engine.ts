/**
 * Editor AI operator assistant engine — the one model call behind the editor's
 * floating `AI` chat.
 *
 * It decides WHICH operators the model may choose (deterministic discovery plus
 * the core operators as a floor), asks for the parameters, and reads the answer
 * back through the same defensive gate the reply parser defines. It never
 * executes an operator, never opens a tab, never reads a page and never touches
 * a workflow draft: the editor's canvas is the source of truth and can hold
 * unsaved edits, so the answer is returned for the canvas to land
 * (specs/2026-10-19-editor-operator-ai-chat-design.md §2).
 *
 * The model call is injectable so the loop is testable without a network.
 *
 * @module background/operator-advise-engine
 */

import { streamCompletion } from '../lib/llm'
import { getSettings } from '../lib/storage'
import { entityKeyFor, type TokenAttribution } from '../lib/token-ledger'
import {
  adviseCandidates,
  buildOperatorAdvisePrompt,
  OPERATOR_ADVISE_MAX_OPERATORS,
  parseOperatorAdviseReply,
  type OperatorAdviseMessage,
  type OperatorAdviseResult,
} from '../lib/workflow/operator-advise'

/**
 * One-shot budget for picking operators. Deliberately far below AI Fix's five
 * minutes: this answers "which step comes next", with no page to observe and no
 * trial run to wait for.
 */
const OPERATOR_ADVISE_TIMEOUT_MS = 60_000

export interface OperatorAdviseInput {
  /** Cancels the in-flight request through `workflows.operatorAdviseCancel`. */
  sessionId: string
  /** The conversation so far, oldest first; the last user row is what to answer. */
  messages: OperatorAdviseMessage[]
  /** The current canvas as text, from `operatorDigestOf`. */
  graphDigest: string
  /** What the workflow is for — discovery's goal-alignment signal. */
  workflowGoal?: string
  /** Only used to attribute the token spend. */
  workflowId?: string
  maxOperators?: number
}

export interface OperatorAdviseDeps {
  signal: AbortSignal
  /** Ask the model; returns its raw reply text. Defaults to the real LLM call. */
  callModel?: (prompt: string) => Promise<string>
  /** Which workflow to charge the tokens to; defaults to this request's entity. */
  attribution?: TokenAttribution
}

/** The utterance to answer: the newest user row. */
function latestIntent(messages: readonly OperatorAdviseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && message.content.trim()) return message.content.trim()
  }
  return ''
}

/** Build the default model call over the active provider. */
function defaultCallModel(signal: AbortSignal, attribution: TokenAttribution) {
  return async (prompt: string): Promise<string> => {
    const settings = await getSettings()
    const provider = settings.providers.find((profile) => profile.id === settings.activeProviderId)
    if (!provider || !provider.apiKey.trim()) {
      throw new Error('No AI provider is configured with an API key.')
    }
    const result = await streamCompletion(
      {
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model: provider.model,
        attribution,
        headers: provider.headers,
        // One request carries everything: the digest, the offer and the
        // conversation. Same shape as the AI Fix call, so a follow-up message
        // reads as a continuation of the transcript the prompt already holds.
        messages: [{ role: 'user', content: prompt }],
        signal: AbortSignal.any([signal, AbortSignal.timeout(OPERATOR_ADVISE_TIMEOUT_MS)]),
      },
      {},
    )
    return result.content
  }
}

export async function runOperatorAdvise(
  input: OperatorAdviseInput,
  deps: OperatorAdviseDeps,
): Promise<OperatorAdviseResult> {
  const intent = latestIntent(input.messages)
  if (!intent) {
    return {
      ok: false,
      reason: 'Describe the step to add — the assistant has nothing to choose an operator from.',
      reply: '',
      proposals: [],
      rejected: [],
    }
  }
  const maxOperators = input.maxOperators ?? OPERATOR_ADVISE_MAX_OPERATORS
  const candidates = adviseCandidates(intent, input.workflowGoal)
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'This build exposes no operators the assistant may add.',
      reply: '',
      proposals: [],
      rejected: [],
    }
  }
  const prompt = buildOperatorAdvisePrompt({
    history: input.messages,
    graphDigest: input.graphDigest,
    candidates,
    maxOperators,
  })
  // The ledger keys this spend by the workflow being edited when the caller
  // names one, and by the request otherwise.
  const attribution: TokenAttribution = deps.attribution ?? {
    consumer: 'workflow-generation',
    entityKey: entityKeyFor('workflow', input.workflowId ?? input.sessionId),
  }
  const callModel = deps.callModel ?? defaultCallModel(deps.signal, attribution)

  let text: string
  try {
    text = await callModel(prompt)
  } catch (error) {
    if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      reply: '',
      proposals: [],
      rejected: [],
    }
  }
  if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const parsed = parseOperatorAdviseReply(
    text,
    candidates.map((candidate) => candidate.blockId),
    maxOperators,
  )
  if (!parsed) {
    return {
      ok: false,
      reason: 'The AI answer was not a readable JSON object, so nothing was added.',
      reply: '',
      proposals: [],
      rejected: [],
    }
  }
  return { ok: true, ...parsed }
}
