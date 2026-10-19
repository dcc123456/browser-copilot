/**
 * Floating AI operator assistant — the `AI` button at the bottom-right of the
 * canvas and the chat it opens.
 *
 * One turn is one model call (`workflows.operatorAdvise`): the assistant answers
 * with a spoken reply plus a chain of operators, and the editor lands that chain
 * on the canvas immediately (the dock itself never mutates the graph — the canvas
 * holds unsaved edits and stays the source of truth). Undo removes exactly the
 * last landed batch. Nothing is verified by running, and the transcript lives
 * only in this component's state (specs/2026-10-19-editor-operator-ai-chat-design.md).
 *
 * Tailwind semantic tokens only; all copy through the editor translator.
 *
 * @module workflow-editor/ai/OperatorChatDock
 */

import { useRef, useState } from 'react'
import { Loader2, RotateCcw, Send, Square, X } from 'lucide-react'
import { sendCommand } from '../../lib/messages'
import { isNearBottom } from '../../lib/scroll'
import type {
  OperatorAdviseMessage,
  OperatorChainPatch,
  OperatorChainProblem,
  OperatorProposal,
} from '../../lib/workflow/operator-advise'
import type { EditorStringKey, TranslateFn } from '../i18n'

/** What the canvas did with one reply. */
export interface OperatorLanding {
  /** Nodes actually placed. */
  added: number
  /** Names of operators the editor refused to add. */
  skipped: string[]
  /** Operators added with a required parameter left empty. */
  missing: OperatorChainPatch['missing']
  /** Why nothing was added, when the canvas refused the whole batch. */
  problem?: OperatorChainProblem
}

export interface OperatorChatContext {
  graphDigest: string
  /** The step the chain follows: the single selected node, else the flow's end. */
  anchorNodeId?: string
  workflowGoal?: string
  workflowId?: string
}

export interface OperatorChatDockProps {
  t: TranslateFn
  /** Read at send time: the canvas may have moved on since the dock rendered. */
  getContext: () => OperatorChatContext
  /** Land the chain on the canvas and report what happened. */
  onAppend: (proposals: OperatorProposal[], anchorNodeId?: string) => OperatorLanding
  /** Drop the batch the last landing added. */
  onUndo: () => void
}

interface Turn {
  role: 'user' | 'assistant'
  content: string
  landing?: OperatorLanding
  /** An assistant row that reports a failure rather than a landed chain. */
  failed?: boolean
}

function makeSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `operator-advise-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const PROBLEM_KEY: Record<OperatorChainProblem, EditorStringKey> = {
  'branch-anchor': 'operatorAiBranchAnchor',
  'empty-graph': 'operatorAiEmptyGraph',
  'unknown-anchor': 'operatorAiAnchorGone',
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
      <p className="mt-1 text-[11px] leading-snug text-warn">{t(PROBLEM_KEY[landing.problem])}</p>
    )
  if (landing.added === 0) return null
  const missing = landing.missing
    .map((entry) => `${entry.name}: ${entry.keys.join(', ')}`)
    .join(' | ')
  return (
    <div className="mt-1.5 flex flex-col gap-1 border-t border-border pt-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[11px] leading-snug text-muted">
          {t('operatorAiAdded').replace('{count}', String(landing.added))}
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
      {landing.skipped.length > 0 && (
        <p className="text-[11px] leading-snug text-warn">
          {t('operatorAiRejected').replace('{names}', landing.skipped.join(', '))}
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

export default function OperatorChatDock({
  t,
  getContext,
  onAppend,
  onUndo,
}: OperatorChatDockProps) {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const composingRef = useRef(false)
  const sessionIdRef = useRef('')
  const logRef = useRef<HTMLDivElement>(null)

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

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || busy) return
    const history: OperatorAdviseMessage[] = [
      ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: text },
    ]
    const context = getContext()
    const sessionId = makeSessionId()
    sessionIdRef.current = sessionId
    setInput('')
    setBusy(true)
    pushTurn({ role: 'user', content: text })
    try {
      const result = await sendCommand({
        type: 'workflows.operatorAdvise',
        sessionId,
        messages: history,
        graphDigest: context.graphDigest,
        ...(context.workflowGoal ? { workflowGoal: context.workflowGoal } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
      })
      if (result.type !== 'workflows.operatorAdvise') return
      const data = result.data
      if (!data.ok) {
        pushTurn({ role: 'assistant', content: data.reason ?? data.reply, failed: true })
        return
      }
      const landing =
        data.proposals.length > 0 ? onAppend(data.proposals, context.anchorNodeId) : undefined
      pushTurn({ role: 'assistant', content: data.reply, ...(landing ? { landing } : {}) })
    } catch (error) {
      pushTurn({
        role: 'assistant',
        content: error instanceof Error ? error.message : String(error),
        failed: true,
      })
    } finally {
      setBusy(false)
    }
  }

  function stop(): void {
    if (!sessionIdRef.current) return
    void sendCommand({
      type: 'workflows.operatorAdviseCancel',
      sessionId: sessionIdRef.current,
    }).catch(() => {
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
    if (turn.landing && turn.landing.added > 0) lastLanded = index
  })

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
          <div className="mr-2 flex items-center gap-1.5 rounded-lg bg-panel-2 px-2 py-1.5 text-xs text-muted">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            {t('operatorAiThinking')}
          </div>
        )}
      </div>

      <footer className="border-t border-border p-2">
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
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
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
              disabled={!input.trim()}
              onClick={() => void send()}
              title={t('operatorAiSend')}
              type="button"
            >
              <Send size={11} aria-hidden="true" />
              {t('operatorAiSend')}
            </button>
          )}
        </div>
      </footer>
    </section>
  )
}
