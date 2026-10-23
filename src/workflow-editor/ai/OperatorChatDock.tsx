/**
 * Floating AI operator assistant — the `AI` button at the bottom-right of the
 * canvas and the chat it opens.
 *
 * One turn is one model call (`workflows.operatorAdvise`): the assistant answers
 * with a spoken reply plus an action — append a chain of operators, or change the
 * step the user has selected in place — and the editor lands it immediately (the
 * dock itself never mutates the graph; the canvas holds unsaved edits and stays
 * the source of truth). The model's own output streams in over
 * `workflows.operatorAdviseEvent` while it writes and is kept behind a disclosure
 * afterwards. Undo removes exactly the last landed batch or restores exactly the
 * snapshot the last in-place change took. Nothing is verified by running, and the
 * transcript lives only in this component's state
 * (specs/2026-10-19-editor-operator-ai-chat-design.md,
 * specs/2026-10-19-operator-ai-observe-and-edit-design.md §4,
 * specs/2026-10-22-operator-assistant-thinking-output-vocabulary-and-pending-picks-design.md §3).
 *
 * Tailwind semantic tokens only; all copy through the editor translator.
 *
 * @module workflow-editor/ai/OperatorChatDock
 */

import { useEffect, useRef, useState } from 'react'
import {
  Camera,
  Eye,
  EyeOff,
  Focus,
  Loader2,
  MousePointerClick,
  RotateCcw,
  Send,
  Square,
  X,
} from 'lucide-react'
import { sendCommand } from '../../lib/messages'
import { isNearBottom } from '../../lib/scroll'
import { toast } from '../../ui/toast'
import {
  isObservableBlock,
  isOperatorChainAction,
  operatorBlockName,
  proposalIndexesNeedingPage,
  proposalsNeedingPage,
} from '../../lib/workflow/operator-advise'
import type {
  OperatorAction,
  OperatorAdviseMessage,
  OperatorChainAction,
  OperatorChainProblem,
  OperatorMissingParams,
  OperatorPageRef,
  OperatorParamChange,
  OperatorPrunedPort,
  OperatorProposal,
  OperatorScreenshotReport,
  OperatorSwap,
  OperatorTargetProblem,
  PickedElement,
} from '../../lib/workflow/operator-advise'
import { useEditorLocale } from '../locale-context'
import { describePickFailure, requestElementPick } from '../blocks/shared/element-pick'
import type { EditorStringKey, TranslateFn } from '../i18n'

/** Why a reply landed as nothing at all. */
export type OperatorLandingProblem = OperatorChainProblem | OperatorTargetProblem | 'no-selection'

/** What the canvas did with one reply. */
export interface OperatorLanding {
  /** Which of the two shapes the reply took: a chain spliced into the flow, or
   *  one step changed where it stands. */
  kind: 'chain' | 'node'
  /** Nodes actually placed (an in-place change never places any). */
  added: number
  /** The change actually reached the canvas. */
  applied: boolean
  /** Names of operators the editor refused to add. */
  skipped: string[]
  /** Output ports an in-place change had to cut, labelled — a swapped operator
   *  does not draw every port the old one did. */
  pruned: OperatorPrunedPort[]
  /** Operators landed with a required parameter left empty. */
  missing: OperatorMissingParams[]
  /** Parameters an in-place edit really changed, old value against new — the
   *  evidence that the canvas did something, since most parameters never show
   *  on the node card at all. */
  changed?: OperatorParamChange[]
  /** The operator a swap moved the step from and to, by display name. */
  swapped?: OperatorSwap
  problem?: OperatorLandingProblem
}

/** One answer, ready for the canvas. The target is the editor's own selection,
 *  captured when the request went out and re-checked when the answer lands. */
export interface OperatorApplyRequest {
  action: OperatorAction
  proposals: OperatorProposal[]
  targetNodeId?: string
}

export interface OperatorChatContext {
  graphDigest: string
  /** The single selected step, when there is exactly one. */
  selectedNodeId?: string
  /** That step's parameters, already redacted — only sent with a selection. */
  selectedSpec?: string
  /** The window to read a page from; without one nothing is read. */
  windowId?: number
  workflowGoal?: string
  workflowId?: string
}

export interface OperatorChatDockProps {
  t: TranslateFn
  /** Read at send time: the canvas may have moved on since the dock rendered. */
  getContext: () => OperatorChatContext
  /** Land the answer on the canvas and report what happened. */
  onApply: (request: OperatorApplyRequest) => OperatorLanding
  /** Undo the last landing — the batch it added, or the node it changed. */
  onUndo: () => void
}

interface Turn {
  role: 'user' | 'assistant'
  content: string
  landing?: OperatorLanding
  /** The proposals the answer carried, with the model's reason for each — shown
   *  so the user can judge the choice without opening the raw output. */
  proposals?: OperatorProposal[]
  /** The answer exactly as the model wrote it. Streamed live, then kept behind a
   *  disclosure, because a refused or half-read answer is what the user needs. */
  raw?: string
  /** The page this answer's parameters were read from; `null` when none was. */
  page?: OperatorPageRef | null
  /** An assistant row that reports a failure rather than a landed chain. */
  failed?: boolean
  /** The answer is waiting to be landed: the steps need a parameter only the page
   *  can supply, so the user picks between acting on it once first and landing the
   *  guess. Nothing is on the canvas while this is set. */
  offer?: PendingOffer
  /** What acting once on the page reported, kept as its own row under the answer. */
  observed?: string
  /** The automatic screenshot this answer cost — or tried to. Screen pixels leave
   *  the machine on this path, so it is reported, never silent. */
  screenshot?: OperatorScreenshotReport
}

/** The model's answer while it is still arriving, fed by the background's
 *  `workflows.operatorAdviseEvent` broadcasts. */
interface StreamingAnswer {
  sessionId: string
  reasoning: string
  text: string
}

/** A batch held back from the canvas, and what it still lacks. */
interface PendingOffer {
  /** Where it goes when the user lands it: after the anchor or in front of it. The
   *  offer only ever holds a chain, because a step missing a parameter is a NEW
   *  step — an in-place answer is landed straight away. */
  action: OperatorChainAction
  proposals: OperatorProposal[]
  missing: OperatorMissingParams[]
  /** Operators in the batch the assistant will not act with, named up front —
   *  the user decides knowing which steps a page run would not touch. */
  unavailable: string[]
}

function makeSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `operator-advise-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const PROBLEM_KEY: Record<OperatorLandingProblem, EditorStringKey> = {
  'branch-anchor': 'operatorAiBranchAnchor',
  'empty-graph': 'operatorAiEmptyGraph',
  'unknown-anchor': 'operatorAiAnchorGone',
  'prepend-entry-point': 'operatorAiPrependEntry',
  'prepend-no-incoming': 'operatorAiPrependUnwired',
  'join-anchor': 'operatorAiJoinAnchor',
  'no-selection': 'operatorAiNoSelection',
  'unknown-target': 'operatorAiTargetGone',
  'no-proposal': 'operatorAiOneProposalOnly',
  'many-proposals': 'operatorAiOneProposalOnly',
  'edit-other-block': 'operatorAiEditOtherBlock',
  'replace-same-block': 'operatorAiReplaceSameBlock',
  'replace-unofferable': 'operatorAiReplaceUnofferable',
  'replace-entry-point': 'operatorAiReplaceEntry',
  'no-change': 'operatorAiNoChange',
}

/** One parameter value as the row shows it: JSON-quoted so an empty string stays
 *  visible, capped so one long value cannot flood the transcript. */
function displayParamValue(value: unknown): string {
  if (value === undefined || value === null) return '—'
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

/** The in-place edit's evidence: exactly the keys that changed, old → new. */
function changesLine(changes: readonly OperatorParamChange[]): string {
  return changes
    .map(
      (change) =>
        `${change.key}: ${displayParamValue(change.before)} → ${displayParamValue(change.after)}`,
    )
    .join(' · ')
}

function Landing({
  landing,
  showUndo,
  onUndo,
  t,
}: {
  landing: OperatorLanding
  showUndo: boolean
  onUndo: () => void
  t: TranslateFn
}) {
  if (landing.problem)
    return (
      <p className="mt-1 text-[11px] leading-snug text-warn">
        {t('operatorAiNotApplied')} <span>{t(PROBLEM_KEY[landing.problem])}</span>
      </p>
    )
  // Not applied for a reason the patch could not name (every operator refused):
  // still say so — a reply claiming a change must never stand unopposed.
  if (!landing.applied)
    return (
      <div className="mt-1 flex flex-col gap-1">
        <p className="text-[11px] leading-snug text-faint">{t('operatorAiNoSteps')}</p>
        {landing.skipped.length > 0 && (
          <p className="text-[11px] leading-snug text-warn">
            {t('operatorAiRejected').replace('{names}', landing.skipped.join(', '))}
          </p>
        )}
      </div>
    )
  const missing = landing.missing
    .map((entry) => `${entry.name}: ${entry.keys.join(', ')}`)
    .join(' | ')
  const pruned = landing.pruned.map((port) => port.label).join(', ')
  return (
    <div className="mt-1.5 flex flex-col gap-1 border-t border-border pt-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[11px] leading-snug text-muted">
          {landing.kind === 'chain' ? (
            t('operatorAiAdded').replace('{count}', String(landing.added))
          ) : landing.swapped ? (
            <>
              {t('operatorAiSwappedStep')} {landing.swapped.from} → {landing.swapped.to}
            </>
          ) : (
            t('operatorAiChangedInPlace')
          )}
        </span>
        {showUndo && (
          <button
            className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-ink hover:bg-hover"
            onClick={onUndo}
            title={t('operatorAiUndo')}
            type="button"
          >
            <RotateCcw size={11} aria-hidden="true" />
            {t('operatorAiUndo')}
          </button>
        )}
      </div>
      {landing.changed && landing.changed.length > 0 && (
        <p className="text-[11px] leading-snug text-muted">
          {t('operatorAiChangedParams')} <span>{changesLine(landing.changed)}</span>
        </p>
      )}
      {landing.skipped.length > 0 && (
        <p className="text-[11px] leading-snug text-warn">
          {t('operatorAiRejected').replace('{names}', landing.skipped.join(', '))}
        </p>
      )}
      {pruned && (
        <p className="text-[11px] leading-snug text-warn">
          {t('operatorAiPrunedPorts').replace('{ports}', pruned)}
        </p>
      )}
      {missing && (
        <p className="text-[11px] leading-snug text-warn">
          {t('operatorAiMissingParams').replace('{keys}', missing)}
        </p>
      )}
    </div>
  )
}

/** The screenshot the assistant took for itself, reported either way: screen
 *  pixels leave the machine on this path, and the user is the one who owns them. */
function ScreenshotLine({
  screenshot,
  t,
}: {
  screenshot: OperatorScreenshotReport
  t: TranslateFn
}) {
  const text = !screenshot.taken
    ? t('operatorAiShotSkipped').replace('{error}', screenshot.error ?? '')
    : screenshot.error
      ? t('operatorAiShotSentFailed').replace('{error}', screenshot.error)
      : t('operatorAiShotSent')
  return (
    <p
      className={`mt-1 flex items-start gap-1 text-[11px] leading-snug ${
        screenshot.taken && screenshot.error ? 'text-warn' : 'text-faint'
      }`}
    >
      <Camera size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  )
}

/** The ask before the assistant touches the page: act once to get the real
 *  locator, or land the guess. Choosing 执行 runs the steps against the user's own
 *  page, which 撤销 cannot take back — the row says so. */
function Offer({
  offer,
  busy,
  onAct,
  onLand,
  t,
}: {
  offer: PendingOffer
  busy: boolean
  onAct: () => void
  onLand: () => void
  t: TranslateFn
}) {
  return (
    <div className="mt-1.5 flex flex-col gap-1 border-t border-border pt-1.5">
      <p className="text-[11px] leading-snug text-warn">
        {t('operatorAiOfferQuestion').replace(
          '{keys}',
          offer.missing.map((entry) => `${entry.name}: ${entry.keys.join(', ')}`).join(' | '),
        )}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-[11px] font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50"
          disabled={busy}
          onClick={onAct}
          title={t('operatorAiOfferActHint')}
          type="button"
        >
          <MousePointerClick size={11} aria-hidden="true" />
          {t('operatorAiOfferAct')}
        </button>
        <button
          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] text-ink hover:bg-hover disabled:opacity-50"
          disabled={busy}
          onClick={onLand}
          type="button"
        >
          {t('operatorAiOfferLand')}
        </button>
      </div>
      <p className="text-[11px] leading-snug text-faint">
        {t('operatorAiOfferNoUndo')}
        {offer.unavailable.length > 0 && (
          <span className="mt-0.5 block">
            {t('operatorAiOfferRefused').replace('{names}', offer.unavailable.join(', '))}
          </span>
        )}
      </p>
    </div>
  )
}

export default function OperatorChatDock({
  t,
  getContext,
  onApply,
  onUndo,
}: OperatorChatDockProps) {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  // Grounding is on by default — reading a page has no side effects, and a
  // parameter taken from the page is the whole point of asking in the editor.
  const [readPage, setReadPage] = useState(true)
  // Elements the user pointed at by hand since the last message. They outrank
  // any page read, so they ride along with the next send and are consumed there.
  const [picked, setPicked] = useState<PickedElement[]>([])
  const [stream, setStream] = useState<StreamingAnswer | null>(null)
  const { bt, locale } = useEditorLocale()
  const composingRef = useRef(false)
  /** The advise request whose deltas this dock accepts. Deltas for any other
   *  request (another editor page, a cancelled turn) are dropped. */
  const activeSessionRef = useRef<string | null>(null)
  /** Which cancel reaches the request in flight: the model call, or the run that
   *  acts on the page. One facility, one in-flight request at a time. */
  const inFlightRef = useRef<
    | { type: 'workflows.operatorAdviseCancel'; sessionId: string }
    | { type: 'workflows.operatorObserveCancel'; sessionId: string }
    | null
  >(null)
  const logRef = useRef<HTMLDivElement>(null)

  // The model's own output, live. The background batches deltas (~80 ms), so this
  // appends a chunk at a time rather than per token; the final answer arrives
  // again in the command result and is kept behind a disclosure.
  useEffect(() => {
    const listener = (message: unknown): void => {
      const event = message as {
        type?: string
        sessionId?: string
        channel?: 'text' | 'reasoning'
        delta?: string
      }
      if (event?.type !== 'workflows.operatorAdviseEvent') return
      const sessionId = event.sessionId
      if (!sessionId || sessionId !== activeSessionRef.current) return
      const delta = event.delta
      if (typeof delta !== 'string' || delta === '') return
      const channel = event.channel === 'reasoning' ? 'reasoning' : 'text'
      setStream((current) => {
        const base = current ?? { sessionId, reasoning: '', text: '' }
        return { ...base, [channel]: base[channel] + delta }
      })
      if (atBottom) {
        requestAnimationFrame(() => {
          const el = logRef.current
          if (el) el.scrollTo({ top: el.scrollHeight })
        })
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [atBottom])

  function scrollToEnd() {
    const el = logRef.current
    if (el && atBottom) el.scrollTo({ top: el.scrollHeight })
  }

  function pushTurn(turn: Turn): void {
    setTurns((current) => [...current, turn])
    // Follow only when the user was already at the bottom, and only once the new
    // row is laid out — otherwise a reply yanks the scroll away from the history.
    requestAnimationFrame(scrollToEnd)
  }

  /** Answer one outstanding row in place: its offer is consumed by a landing. */
  function resolveTurn(index: number, patch: Partial<Turn>): void {
    setTurns((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch, offer: undefined } : row)),
    )
    requestAnimationFrame(scrollToEnd)
  }

  /** Land a batch, optionally with the parameters the page just supplied. */
  function landProposals(
    action: OperatorChainAction,
    proposals: OperatorProposal[],
    context: OperatorChatContext,
  ): OperatorLanding {
    return onApply({
      action,
      proposals,
      ...(context.selectedNodeId ? { targetNodeId: context.selectedNodeId } : {}),
    })
  }

  /** Change one pending attachment in place — nothing on the canvas moves. */
  function updatePick(index: number, patch: Partial<PickedElement>): void {
    setPicked((current) =>
      current.map((element, position) => (position === index ? { ...element, ...patch } : element)),
    )
  }

  function removePick(index: number): void {
    setPicked((current) => current.filter((_element, position) => position !== index))
  }

  /**
   * Write the pending picks into the held batch, and land it once nothing is
   * missing. A pick is only an attachment until the user presses send: editing or
   * removing one never touches the canvas, and the send click is the consent.
   * Picks beyond what the batch can use stay pending for the next message.
   */
  function applyPicksToOffer(index: number): void {
    const offer = turns[index]?.offer
    if (!offer || busy) return
    const gaps = proposalIndexesNeedingPage(offer.proposals)
    const available = picked.filter((element) => element.selector.trim() !== '')
    if (gaps.length === 0 || available.length === 0) return
    let cursor = 0
    const filled = offer.proposals.map((proposal, position) => {
      if (!gaps.includes(position) || cursor >= available.length) return proposal
      const element = available[cursor]
      if (!element) return proposal
      cursor += 1
      return {
        ...proposal,
        data: { ...proposal.data, selector: element.selector.trim(), findBy: element.findBy },
      }
    })
    const used = new Set(available.slice(0, cursor))
    setPicked((current) => current.filter((element) => !used.has(element)))
    const missing = proposalsNeedingPage(filled)
    if (missing.length > 0) {
      setTurns((current) =>
        current.map((row, i) =>
          i === index && row.offer
            ? { ...row, offer: { ...row.offer, proposals: filled, missing } }
            : row,
        ),
      )
      return
    }
    resolveTurn(index, { landing: landProposals(offer.action, filled, getContext()) })
  }

  /** Point at the element by hand — the assistant gets the locator the user chose.
   *  The pick becomes a pending attachment; it is sent (and landed) only when the
   *  user sends, so it can still be edited or removed here. */
  async function pickElement(): Promise<void> {
    if (busy) return
    const result = await requestElementPick({ locale })
    if (!result.ok) {
      const problem = describePickFailure(result.failure, result.error)
      if (problem) toast(bt(problem), 'error')
      return
    }
    const element: PickedElement = { selector: result.selector, findBy: result.findBy }
    setPicked((current) => [...current, element])
    pushTurn({
      role: 'user',
      content: t('operatorAiPicked').replace('{selector}', element.selector),
    })
  }

  async function send(): Promise<void> {
    if (busy) return
    // A held batch owns the next send: the picks the user just collected answer
    // the question the offer asked, so the click fills and lands it instead of
    // starting another model turn.
    const offerIndex = turns.findIndex((turn) => turn.offer)
    if (offerIndex >= 0) {
      applyPicksToOffer(offerIndex)
      return
    }
    const text = input.trim()
    if (!text) return
    const history: OperatorAdviseMessage[] = [
      ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: text },
    ]
    const context = getContext()
    const sessionId = makeSessionId()
    // The picks go with this message and are spent by it; the 已拾取 rows stay in
    // the transcript, so the model still reads them on a follow-up turn.
    const picks = picked.filter((element) => element.selector.trim() !== '')
    inFlightRef.current = { type: 'workflows.operatorAdviseCancel', sessionId }
    activeSessionRef.current = sessionId
    setStream({ sessionId, reasoning: '', text: '' })
    setInput('')
    setPicked([])
    setBusy(true)
    pushTurn({ role: 'user', content: text })
    let landing: OperatorLanding | undefined
    try {
      const result = await sendCommand({
        type: 'workflows.operatorAdvise',
        sessionId,
        messages: history,
        graphDigest: context.graphDigest,
        ...(context.selectedSpec ? { selectedSpec: context.selectedSpec } : {}),
        ...(context.windowId !== undefined ? { windowId: context.windowId } : {}),
        ...(readPage ? {} : { skipPageRead: true }),
        ...(picks.length > 0 ? { pickedElements: picks } : {}),
        ...(context.workflowGoal ? { workflowGoal: context.workflowGoal } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
      })
      if (result.type !== 'workflows.operatorAdvise') return
      const data = result.data
      if (!data.ok) {
        pushTurn({
          role: 'assistant',
          content: data.reason ?? data.reply,
          ...(data.raw ? { raw: data.raw } : {}),
          failed: true,
        })
        return
      }
      const action = data.action ?? 'append'
      // A chain whose steps read an element, and whose parameters the page read
      // could not complete, is a guess about a page we could actually act on. Hold
      // it and ask once: acting has a side effect, so it is never automatic.
      const chain = isOperatorChainAction(action) ? action : undefined
      const missing =
        chain && data.page && context.windowId !== undefined
          ? proposalsNeedingPage(data.proposals)
          : []
      if (chain && missing.length > 0) {
        pushTurn({
          role: 'assistant',
          content: data.reply,
          proposals: data.proposals,
          ...(data.raw ? { raw: data.raw } : {}),
          page: data.page,
          ...(data.screenshot ? { screenshot: data.screenshot } : {}),
          offer: {
            action: chain,
            proposals: data.proposals,
            missing,
            unavailable: data.proposals
              .filter((proposal) => !isObservableBlock(proposal.blockId))
              .map((proposal) => operatorBlockName(proposal.blockId)),
          },
        })
        return
      }
      // Anything but an empty chain goes to the editor — an in-place answer even
      // with no proposals, so the refusal reads as "your step was not changed
      // because …". An empty chain has nothing to land, but it still gets a
      // landing row: a reply claiming a change must never be the only sign.
      landing =
        chain && data.proposals.length === 0
          ? { kind: 'chain', added: 0, applied: false, skipped: [], pruned: [], missing: [] }
          : onApply({
              action,
              proposals: data.proposals,
              ...(context.selectedNodeId ? { targetNodeId: context.selectedNodeId } : {}),
            })
      pushTurn({
        role: 'assistant',
        content: data.reply,
        proposals: data.proposals,
        ...(data.raw ? { raw: data.raw } : {}),
        page: data.page ?? null,
        ...(data.screenshot ? { screenshot: data.screenshot } : {}),
        ...(landing ? { landing } : {}),
      })
    } catch (error) {
      pushTurn({
        role: 'assistant',
        content: error instanceof Error ? error.message : String(error),
        failed: true,
      })
    } finally {
      activeSessionRef.current = null
      setStream(null)
      setBusy(false)
      inFlightRef.current = null
    }
  }

  /** Land the held batch as the model wrote it. */
  function landAsIs(index: number): void {
    const offer = turns[index]?.offer
    if (!offer || busy) return
    resolveTurn(index, { landing: landProposals(offer.action, offer.proposals, getContext()) })
  }

  /**
   * Perform the held batch once on the page, then land it with what the page
   * really used — no second model call, so the node carries the locator the site
   * answered with. A step that failed keeps its proposed parameters and says why;
   * a cancelled run lands nothing and leaves the choice open.
   */
  async function actOnce(index: number): Promise<void> {
    const offer = turns[index]?.offer
    if (!offer || busy) return
    const context = getContext()
    const sessionId = makeSessionId()
    inFlightRef.current = { type: 'workflows.operatorObserveCancel', sessionId }
    setBusy(true)
    try {
      const result = await sendCommand({
        type: 'workflows.operatorObserve',
        sessionId,
        steps: offer.proposals.map((proposal) => ({
          blockId: proposal.blockId,
          data: proposal.data,
        })),
        ...(context.windowId !== undefined ? { windowId: context.windowId } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
      })
      if (result.type !== 'workflows.operatorObserve') return
      const data = result.data
      if (!data.ok) {
        setTurns((current) =>
          current.map((row, i) => (i === index ? { ...row, observed: data.reason ?? '' } : row)),
        )
        return
      }
      const refined: OperatorProposal[] = data.steps.map((step) => ({
        blockId: step.blockId,
        data: step.data,
        rationale: '',
      }))
      const observed = [
        ...data.steps.map((step) =>
          step.ran
            ? `${step.name}: ${step.report.join(' ') || t('operatorAiOfferRan')}`
            : `${step.name}: ${step.error ?? t('operatorAiOfferFailed')}`,
        ),
        ...(data.refused.length > 0
          ? [t('operatorAiOfferSkipped').replace('{names}', data.refused.join(', '))]
          : []),
      ].join('\n')
      resolveTurn(index, {
        landing: landProposals(offer.action, refined, context),
        observed,
      })
    } catch (error) {
      resolveTurn(index, {
        observed: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
      inFlightRef.current = null
    }
  }

  function stop(): void {
    const flight = inFlightRef.current
    if (!flight) return
    void sendCommand({ type: flight.type, sessionId: flight.sessionId }).catch(() => {
      /* the in-flight command already settles with the cancellation reason */
    })
  }

  if (!open) {
    return (
      <button
        aria-label={t('operatorAiTitle')}
        className="absolute bottom-[68px] right-4 z-30 flex h-11 w-11 items-center justify-center rounded-full bg-accent text-[13px] font-semibold text-on-accent shadow-[var(--bc-shadow)] transition-colors hover:bg-accent-strong"
        onClick={() => setOpen(true)}
        title={t('operatorAiTitle')}
        type="button"
      >
        {t('operatorAiFabLabel')}
      </button>
    )
  }

  let lastLanded = -1
  turns.forEach((turn, index) => {
    // Only the most recent landing has an undo to offer: the editor keeps one
    // snapshot level, so an older row can no longer be restored.
    if (turn.landing?.applied) lastLanded = index
  })
  const offerIndex = turns.findIndex((turn) => turn.offer)
  const canApplyPicks = offerIndex >= 0 && picked.some((element) => element.selector.trim() !== '')
  const sendBlockedByOffer = offerIndex >= 0 && !canApplyPicks

  return (
    <section
      aria-label={t('operatorAiTitle')}
      className="absolute bottom-[68px] right-4 z-30 flex h-[min(560px,70vh)] w-[340px] flex-col rounded-xl border border-border bg-panel shadow-[var(--bc-shadow)]"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="flex-1 text-[13px] font-semibold text-ink">{t('operatorAiTitle')}</h2>
        <button
          className="wf-icon-btn"
          onClick={() => setOpen(false)}
          title={t('close')}
          type="button"
          aria-label={t('close')}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      <div
        className="flex-1 space-y-2 overflow-y-auto px-3 py-2"
        onScroll={(event) => {
          const el = event.currentTarget
          setAtBottom(isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight))
        }}
        ref={logRef}
      >
        {turns.length === 0 ? (
          <p className="text-[11.5px] leading-snug text-muted">
            {t('operatorAiEmptyState')}
            <span className="mt-2 block text-faint">{t('operatorAiHint')}</span>
          </p>
        ) : null}
        {turns.map((turn, index) => (
          <div
            className={
              turn.role === 'user'
                ? 'ml-6 rounded-lg bg-user-bubble px-2 py-1.5 text-xs leading-snug text-ink'
                : 'mr-2 rounded-lg bg-panel-2 px-2 py-1.5 text-xs leading-snug text-ink'
            }
            key={index}
          >
            <p className="whitespace-pre-wrap">{turn.content}</p>
            {turn.proposals && turn.proposals.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {turn.proposals.map((proposal, position) => (
                  <li
                    className="text-[11px] leading-snug text-muted"
                    key={`${proposal.blockId}-${position}`}
                  >
                    <span className="text-ink">{operatorBlockName(proposal.blockId)}</span>
                    {proposal.rationale ? ` — ${proposal.rationale}` : ''}
                  </li>
                ))}
              </ul>
            )}
            {turn.raw && (
              <details className="mt-1">
                <summary className="cursor-pointer select-none text-[11px] leading-snug text-faint">
                  {t('operatorAiRaw')}
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel px-1.5 py-1 text-[11px] leading-snug text-muted">
                  {turn.raw}
                </pre>
              </details>
            )}
            {turn.page && (
              <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-faint">
                <Eye size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {t('operatorAiPageUsed').replace('{title}', turn.page.title || turn.page.url)}
                </span>
              </p>
            )}
            {turn.page === null && !turn.failed && (
              <p className="mt-1 text-[11px] leading-snug text-faint">{t('operatorAiPageNone')}</p>
            )}
            {turn.screenshot && <ScreenshotLine screenshot={turn.screenshot} t={t} />}
            {turn.observed && (
              <p className="mt-1 whitespace-pre-wrap text-[11px] leading-snug text-muted">
                {turn.observed}
              </p>
            )}
            {turn.offer && (
              <Offer
                busy={busy}
                offer={turn.offer}
                onAct={() => void actOnce(index)}
                onLand={() => landAsIs(index)}
                t={t}
              />
            )}
            {turn.landing && (
              <Landing
                landing={turn.landing}
                onUndo={() => {
                  onUndo()
                  setTurns((current) =>
                    current.map((row, i) => (i === index ? { ...row, landing: undefined } : row)),
                  )
                }}
                showUndo={index === lastLanded}
                t={t}
              />
            )}
            {turn.failed && (
              <p className="mt-1 text-[11px] leading-snug text-err">{t('operatorAiFailed')}</p>
            )}
          </div>
        ))}
        {busy && (
          <div className="mr-2 flex flex-col gap-1 rounded-lg bg-panel-2 px-2 py-1.5 text-xs text-muted">
            <div className="flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              {t('operatorAiThinking')}
            </div>
            {stream?.reasoning && (
              <p className="whitespace-pre-wrap break-words text-[11px] leading-snug text-faint">
                {stream.reasoning}
              </p>
            )}
            {stream?.text && (
              <p className="whitespace-pre-wrap break-words text-[11px] leading-snug text-ink">
                {stream.text}
              </p>
            )}
          </div>
        )}
      </div>

      <footer className="border-t border-border p-2">
        {picked.length > 0 && (
          <div className="mb-1.5 rounded-lg border border-border bg-panel-2 px-2 py-1.5">
            <p className="mb-1 text-[10px] font-medium text-faint">{t('operatorAiPicksTitle')}</p>
            <ul className="space-y-1">
              {picked.map((element, index) => (
                <li className="flex items-center gap-1" key={index}>
                  <select
                    aria-label={t('operatorAiPickShort')}
                    className="shrink-0 rounded border border-border bg-panel px-1 py-0.5 text-[11px] text-ink focus:border-border-strong focus:outline-none"
                    onChange={(event) =>
                      updatePick(index, {
                        findBy: event.target.value as PickedElement['findBy'],
                      })
                    }
                    value={element.findBy}
                  >
                    <option value="cssSelector">{t('operatorAiPickByCss')}</option>
                    <option value="xpath">{t('operatorAiPickByXpath')}</option>
                    <option value="text">{t('operatorAiPickByText')}</option>
                  </select>
                  <input
                    aria-label={t('operatorAiPickShort')}
                    className="min-w-0 flex-1 rounded border border-border bg-panel px-1 py-0.5 text-[11px] text-ink focus:border-border-strong focus:outline-none"
                    onChange={(event) => updatePick(index, { selector: event.target.value })}
                    spellCheck={false}
                    value={element.selector}
                  />
                  <button
                    aria-label={t('operatorAiPickRemove')}
                    className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-ink"
                    onClick={() => removePick(index)}
                    title={t('operatorAiPickRemove')}
                    type="button"
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <textarea
          className="max-h-28 min-h-[52px] w-full resize-y rounded-lg border border-border bg-panel-2 px-2 py-1.5 text-xs text-ink placeholder:text-faint focus:border-border-strong focus:outline-none"
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !composingRef.current &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder={t('operatorAiPlaceholder')}
          rows={2}
          value={input}
        />
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            aria-label={readPage ? t('operatorAiPageOn') : t('operatorAiPageOff')}
            aria-pressed={readPage}
            className="mr-auto flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] hover:bg-hover"
            onClick={() => setReadPage((current) => !current)}
            title={readPage ? t('operatorAiPageOn') : t('operatorAiPageOff')}
            type="button"
          >
            {readPage ? (
              <Eye size={12} aria-hidden="true" className="text-accent" />
            ) : (
              <EyeOff size={12} aria-hidden="true" className="text-faint" />
            )}
            <span className={readPage ? 'text-muted' : 'text-faint'}>
              {readPage ? t('operatorAiPageToggleOn') : t('operatorAiPageToggleOff')}
            </span>
          </button>
          <button
            aria-label={t('operatorAiPickShort')}
            className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] hover:bg-hover disabled:opacity-50"
            disabled={busy}
            onClick={() => void pickElement()}
            title={t('operatorAiPick')}
            type="button"
          >
            <Focus size={12} aria-hidden="true" className="text-accent" />
            <span className="text-muted">{t('operatorAiPickShort')}</span>
            {picked.length > 0 && (
              <span className="rounded bg-accent-soft px-1 text-[10px] text-accent">
                {picked.length}
              </span>
            )}
          </button>
          {busy ? (
            <button
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-ink hover:bg-hover"
              onClick={stop}
              title={t('operatorAiStop')}
              type="button"
            >
              <Square size={11} aria-hidden="true" />
              {t('operatorAiStop')}
            </button>
          ) : (
            <button
              className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50"
              disabled={!canApplyPicks && (!input.trim() || sendBlockedByOffer)}
              onClick={() => void send()}
              title={
                sendBlockedByOffer
                  ? t('operatorAiOfferWaiting')
                  : canApplyPicks
                    ? t('operatorAiPickApply')
                    : t('operatorAiSend')
              }
              type="button"
            >
              {canApplyPicks ? (
                <MousePointerClick size={11} aria-hidden="true" />
              ) : (
                <Send size={11} aria-hidden="true" />
              )}
              {canApplyPicks ? t('operatorAiPickApply') : t('operatorAiSend')}
            </button>
          )}
        </div>
      </footer>
    </section>
  )
}
