/**
 * Editor AI operator assistant engine — the one model call behind the editor's
 * floating `AI` chat.
 *
 * It decides WHICH operators the model may choose (deterministic discovery plus
 * the core operators as a floor), asks for the parameters, and reads the answer
 * back through the same defensive gate the reply parser defines. The answer also
 * carries its action — add a new chain after a step, in front of it, or change the
 * selected step in place — which the engine only relays. It executes no operator,
 * opens no tab and never
 * touches a workflow draft: the editor's canvas is the source of truth and can
 * hold unsaved edits, so the answer is returned for the canvas to land
 * (specs/2026-10-19-editor-operator-ai-chat-design.md §2,
 * specs/2026-10-19-operator-ai-observe-and-edit-design.md §4). The one thing it
 * does take from the browser is a read-only snapshot of the page the editor is
 * hosted in, because a parameter copied from the page is a parameter that exists
 * (§6) — reading has no side effect, and acting on the page is a separate,
 * confirmed step this engine does not perform.
 *
 * The model call is injectable so the loop is testable without a network.
 *
 * @module background/operator-advise-engine
 */

import { streamCompletion } from '../lib/llm'
import { getSettings } from '../lib/storage'
import { entityKeyFor, type TokenAttribution } from '../lib/token-ledger'
import { summarizeSnapshot } from '../lib/ops'
import { inspectImage, resolveVisionTarget } from '../lib/vision'
import { captureVisiblePage } from './capture'
import { normalScopeFromWindowId, type ScopeWindow } from './automation-scope'
import { snapshotActiveTab } from './driver'
import { resolveOperatorLocator, withLocator } from './operator-tool-run'
import { countSelectorMatches } from './selector-probe'
import {
  executeOperatorNode,
  type OperatorExecDeps,
  type OperatorExecResult,
} from './workflow-engine/operator-exec'
import {
  recordedTargetChainOf,
  selectorAfterExecution,
  selectorCandidatesOf,
  type RecordedLocator,
} from '../lib/workflow/target-to-selector'
import type { Target } from '../lib/ops'
import {
  adviseCandidates,
  buildOperatorAdvisePrompt,
  OPERATOR_ADVISE_MAX_OPERATORS,
  OPERATOR_SCREENSHOT_QUESTION,
  operatorBlockName,
  operatorScreenshotRoute,
  parseOperatorAdviseReply,
  proposalsNeedingPage,
  isObservableBlock,
  type OperatorAdviseMessage,
  type OperatorAdviseResult,
  type OperatorObserveResult,
  type OperatorObserveStep,
  type OperatorObservedStep,
  type OperatorPageRead,
  type OperatorScreenshotReport,
  type OperatorScreenshotRoute,
  type PickedElement,
} from '../lib/workflow/operator-advise'

/**
 * One-shot budget for picking operators. Deliberately far below AI Fix's five
 * minutes: this answers "which step comes next", with no trial run to wait for.
 */
const OPERATOR_ADVISE_TIMEOUT_MS = 60_000

/**
 * How many interactive elements a grounding read keeps. Lean on purpose: the
 * assistant needs the controls around the thing the user named (a dropdown and
 * its options, a field and its label), not the whole page — and a page read is
 * sent to the provider on every turn of the chat.
 */
const OPERATOR_PAGE_ELEMENT_LIMIT = 40

export interface OperatorAdviseInput {
  /** Cancels the in-flight request through `workflows.operatorAdviseCancel`. */
  sessionId: string
  /** The conversation so far, oldest first; the last user row is what to answer. */
  messages: OperatorAdviseMessage[]
  /** The current canvas as text, from `operatorDigestOf`. */
  graphDigest: string
  /** The selected step with its current parameters, from `selectedOperatorSpecOf`.
   *  Present only when the editor has exactly one node selected — it is what
   *  makes an `edit`/`replace` answer possible at all. */
  selectedSpec?: string
  /** The editor's host window: the page to read lives there, and a read is
   *  never allowed to reach into another window. */
  windowId?: number
  /** The user's "不读页面" override. Reading is automatic otherwise. */
  skipPageRead?: boolean
  /** Locators the user picked by hand for this turn — stronger than any page
   *  read, because the user answered "which element" instead of leaving it to
   *  be guessed. */
  pickedElements?: readonly PickedElement[]
  /** What the workflow is for — discovery's goal-alignment signal. */
  workflowGoal?: string
  /** Only used to attribute the token spend. */
  workflowId?: string
  maxOperators?: number
}

/** A page capture offered to the assistant, in whichever route it will be used. */
export type OperatorScreenshotCapture =
  { ok: true; dataUrl: string; mimeType: string } | { ok: false; error: string }

/** What the image model made of a screenshot. */
export type OperatorScreenshotNote = { ok: true; note: string } | { ok: false; error: string }

export interface OperatorAdviseDeps {
  signal: AbortSignal
  /** Ask the model; returns its raw reply text. `image` rides the call as a
   *  multimodal attachment — the inline screenshot route. */
  callModel?: (prompt: string, image?: { dataUrl: string; mimeType: string }) => Promise<string>
  /** Read the scoped page, side-effect free. Defaults to a real snapshot. */
  readPage?: (windowId?: number) => Promise<OperatorPageRead | null>
  /** Capture the scoped page. Defaults to a real visible-tab JPEG. */
  captureScreenshot?: (windowId?: number) => Promise<OperatorScreenshotCapture>
  /** Turn a screenshot into text with the configured image model — the described
   *  route, for when the chat model is not the one that reads images. */
  describeScreenshot?: (dataUrl: string) => Promise<OperatorScreenshotNote>
  /** Which route the user's two model settings give. Defaults to reading Settings;
   *  injectable so the routes are testable apart from each other. */
  screenshotRoute?: () => Promise<OperatorScreenshotRoute>
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

/** Base64 payload length to raw bytes; only metadata on a transient attachment. */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  return Math.floor(((comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length) * 3) / 4)
}

/** Build the default model call over the active provider. */
function defaultCallModel(signal: AbortSignal, attribution: TokenAttribution) {
  return async (prompt: string, image?: { dataUrl: string; mimeType: string }): Promise<string> => {
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
        ...(provider.thinkingEffort ? { thinking: provider.thinkingEffort } : {}),
        // One request carries everything: the digest, the offer and the
        // conversation. Same shape as the AI Fix call, so a follow-up message
        // reads as a continuation of the transcript the prompt already holds.
        messages: [
          {
            role: 'user',
            content: prompt,
            // The inline screenshot route: `toApiMessages` folds this into the
            // OpenAI-shaped `image_url` part, so the chat model sees the page.
            ...(image
              ? {
                  attachments: [
                    {
                      id: 'operator-screenshot',
                      name: 'page-screenshot',
                      mimeType: image.mimeType,
                      size: dataUrlBytes(image.dataUrl),
                      dataUrl: image.dataUrl,
                    },
                  ],
                }
              : {}),
          },
        ],
        signal: AbortSignal.any([signal, AbortSignal.timeout(OPERATOR_ADVISE_TIMEOUT_MS)]),
      },
      {},
    )
    return result.content
  }
}

/**
 * Read the page the editor is pointing at, for grounding. Side-effect free and
 * best-effort: no window, a page that cannot be injected (a chrome:// or store
 * page), or a read that throws all mean "no grounding", which the caller reports
 * as `page: null` rather than as a failure — the assistant still answers, the
 * user just has to trust the guess more.
 */
async function defaultReadPage(windowId?: number): Promise<OperatorPageRead | null> {
  try {
    const scope = await normalScopeFromWindowId(windowId)
    const snapshot = await snapshotActiveTab(4000, OPERATOR_PAGE_ELEMENT_LIMIT, scope)
    const summary = summarizeSnapshot(snapshot, {
      elementLimit: OPERATOR_PAGE_ELEMENT_LIMIT,
      // The model's parameters come from controls and labels, never from prose.
      textCap: 0,
    })
    return {
      url: summary.url,
      title: summary.title,
      elements: summary.elements,
      forms: summary.forms,
    }
  } catch {
    return null
  }
}

/**
 * Which screenshot route the user's settings give. The judgement is theirs, not
 * ours: nothing in the provider list says whether a model reads images, so the
 * only honest test is whether the image target resolves to the very provider and
 * model the chat already uses.
 */
async function defaultScreenshotRoute(): Promise<OperatorScreenshotRoute> {
  const settings = await getSettings()
  const active = settings.providers.find((profile) => profile.id === settings.activeProviderId)
  return operatorScreenshotRoute(
    active ? { providerId: active.id, model: active.model } : undefined,
    settings.imageModel,
  )
}

/** Capture the editor's own window, and nothing else. */
async function defaultCaptureScreenshot(windowId?: number): Promise<OperatorScreenshotCapture> {
  try {
    const scope = await normalScopeFromWindowId(windowId)
    const shot = await captureVisiblePage(scope, { format: 'jpeg', quality: 60 })
    if (!shot.ok) return { ok: false, error: shot.error }
    return { ok: true, dataUrl: shot.dataUrl, mimeType: 'image/jpeg' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Read the screenshot with the configured image model, as text. */
function defaultDescribeScreenshot(signal: AbortSignal, attribution: TokenAttribution) {
  return async (dataUrl: string): Promise<OperatorScreenshotNote> => {
    const settings = await getSettings()
    const provider = settings.providers.find((profile) => profile.id === settings.activeProviderId)
    const target = resolveVisionTarget(settings.imageModel, settings.providers, provider)
    if (!target) {
      return {
        ok: false,
        error: 'No image model is configured, and the chat provider took the screenshot instead.',
      }
    }
    const result = await inspectImage(target, dataUrl, {
      prompt: OPERATOR_SCREENSHOT_QUESTION,
      signal,
      attribution,
    })
    return result.ok ? { ok: true, note: result.text } : result
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
  // Read first, ask second: the page is what turns "fill in the search box" into
  // a selector that exists. Skipped only by the user's explicit override.
  const readPage = deps.readPage ?? defaultReadPage
  const page = input.skipPageRead ? null : await readPage(input.windowId)
  const pageRef = page ? { url: page.url, title: page.title } : null
  const promptInput = {
    history: input.messages,
    graphDigest: input.graphDigest,
    candidates,
    ...(page ? { page } : {}),
    ...(input.pickedElements?.length ? { pickedElements: input.pickedElements } : {}),
    ...(input.selectedSpec ? { selectedSpec: input.selectedSpec } : {}),
    maxOperators,
  }
  const prompt = buildOperatorAdvisePrompt(promptInput)
  // The ledger keys this spend by the workflow being edited when the caller
  // names one, and by the request otherwise.
  const attribution: TokenAttribution = deps.attribution ?? {
    consumer: 'workflow-generation',
    entityKey: entityKeyFor('workflow', input.workflowId ?? input.sessionId),
  }
  const callModel = deps.callModel ?? defaultCallModel(deps.signal, attribution)
  const offeredIds = candidates.map((candidate) => candidate.blockId)

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
      page: pageRef,
    }
  }
  if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const parsed = parseOperatorAdviseReply(text, offeredIds, maxOperators)
  if (!parsed) {
    return {
      ok: false,
      reason: 'The AI answer was not a readable JSON object, so nothing was added.',
      reply: '',
      proposals: [],
      rejected: [],
      page: pageRef,
    }
  }
  // One automatic screenshot, at most, and only for what the DOM read could not
  // supply: a step whose element parameter is still empty. A vision call costs,
  // and screen pixels leave the machine — so a round that runs after this one
  // does not exist, and a retry that fails keeps the first answer.
  if (!page || proposalsNeedingPage(parsed.proposals).length === 0) {
    return { ok: true, ...parsed, page: pageRef }
  }
  if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const route = await (deps.screenshotRoute ?? defaultScreenshotRoute)()
  const keep = (screenshot: OperatorScreenshotReport): OperatorAdviseResult => ({
    ok: true,
    ...parsed,
    page: pageRef,
    screenshot,
  })
  const capture = deps.captureScreenshot ?? defaultCaptureScreenshot
  const shot = await capture(input.windowId)
  if (!shot.ok) return keep({ route, taken: false, error: shot.error })

  const used = (error?: string): OperatorScreenshotReport => ({
    route,
    taken: true,
    ...(error ? { error } : {}),
  })
  // `inline` puts the image in front of the chat model itself; `described` spends
  // a second model to turn it into text the chat model can read.
  let note: string | undefined
  if (route === 'described') {
    const describe = deps.describeScreenshot ?? defaultDescribeScreenshot(deps.signal, attribution)
    const described = await describe(shot.dataUrl)
    if (!described.ok) return keep(used(described.error))
    note = described.note
  }
  const screenshotPrompt = buildOperatorAdvisePrompt(
    note === undefined
      ? { ...promptInput, screenshot: { route: 'inline' } }
      : { ...promptInput, screenshot: { route: 'described', note } },
  )
  const image = route === 'inline' ? { dataUrl: shot.dataUrl, mimeType: shot.mimeType } : undefined

  let retryText: string
  try {
    retryText = await callModel(screenshotPrompt, image)
  } catch (error) {
    if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return keep(used(error instanceof Error ? error.message : String(error)))
  }
  if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const retried = parseOperatorAdviseReply(retryText, offeredIds, maxOperators)
  if (!retried) {
    return keep(
      used('The answer after the screenshot was not readable, so the first answer was kept.'),
    )
  }
  return { ok: true, ...retried, page: pageRef, screenshot: used() }
}

/**
 * The parameters an observation owns: where the element is, and nothing else.
 *
 * What was TYPED into the page stays with the page. A credential the user let the
 * assistant type into a password field must never ride back onto the canvas, where
 * it would be saved into the workflow as a literal — so the refined data is the
 * proposal with only these keys replaced. (`withLocator` is what writes them, and
 * it writes all of them from the live page.)
 */
const OBSERVED_PARAM_KEYS: readonly string[] = [
  'selector',
  'findBy',
  'target',
  'selectorVerified',
  '__reliability',
  'label',
]

/** The proposal, with the located element substituted for the model's guess. */
function withObservedParams(
  proposed: Record<string, unknown>,
  observed: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...proposed }
  for (const key of OBSERVED_PARAM_KEYS) {
    if (key in observed) out[key] = observed[key]
    else delete out[key]
  }
  delete out.ref
  return out
}

export interface OperatorObserveInput {
  /** Cancels the run through `workflows.operatorObserveCancel`. */
  sessionId: string
  /** The batch about to land, in chain order. */
  steps: OperatorObserveStep[]
  /** The editor's host window: the assistant acts there and nowhere else. */
  windowId?: number
  /** Only used to attribute the token spend of a block that calls a model. */
  workflowId?: string
}

export interface OperatorObserveDeps {
  signal: AbortSignal
  /** Run one block against the live page. Defaults to the real executor. */
  execute?: (
    blockId: string,
    data: Record<string, unknown>,
    deps: OperatorExecDeps,
  ) => Promise<OperatorExecResult>
  /** Count live matches for a locator's CSS candidates. Defaults to the real probe. */
  probe?: (
    selectors: readonly string[],
    opts: { tabId?: number; scope?: ScopeWindow },
  ) => Promise<number[] | null>
  /** Scope override, for tests; otherwise resolved from `windowId`. */
  scope?: ScopeWindow
  attribution?: TokenAttribution
}

/**
 * Perform the assistant's batch ONCE on the page, to land what the page really
 * uses instead of what the model guessed.
 *
 * The per-step order is the one the generation bridge already proved out
 * (`operator-tool-run`): resolve the locator → probe the candidates → merge →
 * execute → re-locate from what the kernel actually clicked. Nothing here is new
 * policy, and nothing is recorded: the canvas stays the place the nodes land, the
 * caller decides that, and this returns the refined parameters plus what the page
 * said. Cancellation aborts the loop (the caller lands nothing); a step that
 * fails is reported and keeps its proposed data, because a half-observed batch is
 * still worth more than a refused one. A block the assistant may not act with is
 * skipped and NAMED before anything runs — the user sees what will not happen.
 *
 * This is the only path in the assistant that touches the page, and it is
 * confirmation-gated: the dock asks first, and says that acting is not undone by
 * 撤销 (specs/2026-10-19-operator-ai-observe-and-edit-design.md §7).
 */
export async function runOperatorObserve(
  input: OperatorObserveInput,
  deps: OperatorObserveDeps,
): Promise<OperatorObserveResult> {
  if (input.steps.length === 0) {
    return { ok: false, reason: 'There is nothing to observe.', steps: [], refused: [] }
  }
  if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const scope = deps.scope ?? (await normalScopeFromWindowId(input.windowId))
  const execute = deps.execute ?? executeOperatorNode
  const probe = deps.probe ?? countSelectorMatches
  const attribution: TokenAttribution = deps.attribution ?? {
    consumer: 'workflow-generation',
    entityKey: entityKeyFor('workflow', input.workflowId ?? input.sessionId),
  }

  const steps: OperatorObservedStep[] = []
  const refused: string[] = []
  // The tab the batch is now on: a navigation step moves it, and the following
  // steps must act on the new page rather than the one the user started on.
  let tabId: number | undefined

  for (const step of input.steps) {
    const name = operatorBlockName(step.blockId)
    if (!isObservableBlock(step.blockId)) {
      refused.push(name)
      steps.push({
        blockId: step.blockId,
        name,
        ran: false,
        data: step.data,
        report: [],
        error: 'The assistant does not run this operator.',
      })
      continue
    }

    const resolved = resolveOperatorLocator(step.blockId, step.data)
    const candidates = resolved ? selectorCandidatesOf(resolved) : []
    const counts =
      candidates.length > 0
        ? await probe(candidates, {
            ...(tabId !== undefined ? { tabId } : {}),
            ...(scope ? { scope } : {}),
          })
        : null
    const locator: RecordedLocator | undefined =
      resolved && counts ? { ...resolved, verified: undefined } : resolved
    const data = withLocator(step.data, locator)

    if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const outcome = await execute(step.blockId, data, {
      signal: deps.signal,
      attribution,
      ...(scope ? { scope } : {}),
      ...(tabId !== undefined ? { tabId } : {}),
      variables: {},
      setTab: (next) => {
        tabId = next
      },
    })

    if (outcome.status === 'failed') {
      steps.push({
        blockId: step.blockId,
        name,
        ran: false,
        data: step.data,
        report: outcome.lines,
        error: outcome.error ?? `${step.blockId} failed`,
      })
      continue
    }
    if (outcome.status === 'record-only') {
      steps.push({
        blockId: step.blockId,
        name,
        ran: false,
        data: step.data,
        report: outcome.lines,
        error: outcome.note ?? 'Nothing ran on the page.',
      })
      continue
    }

    // Re-locate from what the kernel really clicked, exactly as the record path
    // does: the node lands with the locator that worked, or the chain of specs
    // that replays when no CSS selector could express the element.
    let observed = data
    if (locator && outcome.resolution) {
      const countOf = (selector: string): number => {
        const idx = candidates.indexOf(selector)
        return idx >= 0 ? (counts?.[idx] ?? 0) : 0
      }
      const recordedSelector = selectorAfterExecution({
        usedSpec: outcome.resolution.usedSpec,
        locator,
        countOf,
      })
      const chain: Target | undefined = recordedTargetChainOf({
        locator,
        usedSpec: outcome.resolution.usedSpec,
        countOf,
      })
      observed = withLocator(data, locator, recordedSelector, chain)
    }
    steps.push({
      blockId: step.blockId,
      name,
      ran: true,
      data: withObservedParams(step.data, observed),
      report: outcome.lines,
    })
  }

  return { ok: true, steps, refused }
}
