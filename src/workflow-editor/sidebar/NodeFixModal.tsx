/**
 * Node Fix modal — the dialog behind the per-block "AI Fix" button.
 *
 * Flow: the user types optional repair guidance and confirms → the background
 * runs the bounded observe → execute → diagnose → verify loop, streaming
 * progress events which render as a step timeline → on success the user applies
 * the verified parameters to the block (the block is never changed before
 * that); on failure the reason is shown. Events are filtered by session id, so
 * concurrent fixes never cross.
 *
 * The presentational {@link NodeFixBody} and {@link NodeFixFooter} are exported
 * pure components (server-renderable for tests); the default export owns the
 * state, message subscription and command calls.
 *
 * Tailwind semantic tokens only; all copy through the editor translator.
 *
 * @module workflow-editor/sidebar/NodeFixModal
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, CircleDashed, Loader2, TriangleAlert, Wand2, XCircle } from 'lucide-react'
import { sendCommand } from '../../lib/messages'
import { nodeGoalContractOf } from '../../lib/workflow/node-goal-contract'
import type { NodeFixEvent, NodeFixPhase } from '../../lib/workflow/node-fix'
import Modal from '../ui/Modal'
import type { TranslateFn } from '../i18n'

export interface NodeFixModalProps {
  open: boolean
  onClose: () => void
  blockId: string
  data: Record<string, unknown>
  /** Apply the verified parameters (whole replacement). */
  onApply: (next: Record<string, unknown>) => void
  /** Editor host window the trial run / verification are scoped to. */
  windowId?: number
  t: TranslateFn
}

export type NodeFixUiState = 'input' | 'running' | 'success' | 'failed'

interface TimelineRow {
  key: string
  phase: NodeFixPhase
  detail: string
  status: 'running' | 'done' | 'error'
}

const PHASE_LABEL_KEY: Record<NodeFixPhase, Parameters<TranslateFn>[0]> = {
  observing: 'nodeFixPhaseObserving',
  executing: 'nodeFixPhaseExecuting',
  diagnosing: 'nodeFixPhaseDiagnosing',
  applying: 'nodeFixPhaseApplying',
  verifying: 'nodeFixPhaseVerifying',
}

export function phaseLabel(t: TranslateFn, phase: NodeFixPhase): string {
  return t(PHASE_LABEL_KEY[phase])
}

function makeSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `node-fix-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function Glyph({ status }: { status: TimelineRow['status'] }) {
  if (status === 'done') return <CheckCircle2 size={14} className="mt-px flex-none text-accent" />
  if (status === 'error') return <XCircle size={14} className="mt-px flex-none text-err" />
  if (status === 'running')
    return <Loader2 size={14} className="mt-px flex-none animate-spin text-accent" />
  return <CircleDashed size={14} className="mt-px flex-none text-muted" />
}

/**
 * Collapse the streamed events into one row per (round, phase), keeping the
 * latest status/detail; all but the last still-running row are marked done.
 */
export function timelineRowsOf(events: readonly NodeFixEvent[]): TimelineRow[] {
  const map = new Map<string, TimelineRow>()
  for (const event of events) {
    const key = `${event.round}:${event.phase}`
    map.set(key, {
      key,
      phase: event.phase,
      detail: event.message,
      status: event.status ?? 'running',
    })
  }
  const list = [...map.values()]
  let seenRunning = false
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const row = list[i]!
    if (row.status === 'running') {
      if (seenRunning) row.status = 'done'
      seenRunning = true
    }
  }
  return list
}

export interface NodeFixBodyProps {
  state: NodeFixUiState
  hasContract: boolean
  suggestion: string
  events: readonly NodeFixEvent[]
  resultReason?: string
  onSuggestionChange: (next: string) => void
  t: TranslateFn
}

/** Presentational body: suggestion input, progress timeline, result banner. */
export function NodeFixBody({
  state,
  hasContract,
  suggestion,
  events,
  resultReason,
  onSuggestionChange,
  t,
}: NodeFixBodyProps) {
  const rows = useMemo(() => timelineRowsOf(events), [events])
  return (
    <div className="flex flex-col gap-3">
      {state === 'input' && (
        <>
          {!hasContract && (
            <p className="flex items-start gap-1.5 rounded-lg border border-border bg-panel p-2 text-xs text-warn">
              <TriangleAlert size={13} className="mt-px flex-none" />
              {t('nodeFixMissingContract')}
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-strong">{t('nodeFixSuggestionLabel')}</span>
            <textarea
              className="block w-full resize-y rounded-md border border-border bg-panel px-2 py-1.5 text-xs text-ink outline-none focus:border-accent"
              rows={3}
              value={suggestion}
              placeholder={t('nodeFixSuggestionPlaceholder')}
              onChange={(e) => onSuggestionChange(e.target.value)}
            />
          </label>
        </>
      )}

      {(state === 'running' || state === 'success' || state === 'failed') && (
        <ul className="m-0 flex flex-col gap-1.5 p-0">
          {rows.length === 0 && state === 'running' ? (
            <li className="flex items-center gap-2 text-xs text-muted">
              <Loader2 size={14} className="animate-spin text-accent" />
              {t('nodeFixApplying')}
            </li>
          ) : (
            rows.map((row) => (
              <li key={row.key} className="flex items-start gap-2">
                <Glyph
                  status={
                    state === 'running'
                      ? row.status
                      : row.status === 'running'
                        ? 'done'
                        : row.status
                  }
                />
                <span className="text-xs text-ink">{phaseLabel(t, row.phase)}</span>
                {row.detail && (
                  <code className="ml-auto max-w-[55%] truncate text-[10px] text-muted">
                    {row.detail}
                  </code>
                )}
              </li>
            ))
          )}
        </ul>
      )}

      {state === 'success' && (
        <p className="m-0 rounded-lg border border-border bg-accent-soft p-2 text-xs text-accent">
          <Wand2 size={13} className="mr-1 inline" />
          {t('nodeFixNoChangeNeeded')}
        </p>
      )}

      {state === 'failed' && (
        <p className="m-0 rounded-lg border border-border bg-panel p-2 text-xs text-err">
          {resultReason ?? t('nodeFixFailed')}
        </p>
      )}
    </div>
  )
}

export interface NodeFixFooterProps {
  state: NodeFixUiState
  hasContract: boolean
  onClose: () => void
  onConfirm: () => void
  onCancel: () => void
  onApply: () => void
  t: TranslateFn
}

function secondaryButton(label: string, onClick: () => void): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 rounded-lg border border-border bg-panel px-3 text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-ink"
    >
      {label}
    </button>
  )
}

/** Presentational footer actions for each UI state. */
export function NodeFixFooter({
  state,
  hasContract,
  onClose,
  onConfirm,
  onCancel,
  onApply,
  t,
}: NodeFixFooterProps) {
  return (
    <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
      {state === 'input' && (
        <>
          {secondaryButton(t('nodeFixClose'), onClose)}
          <button
            type="button"
            onClick={onConfirm}
            disabled={!hasContract}
            className="h-8 rounded-lg bg-accent px-3.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('nodeFixConfirm')}
          </button>
        </>
      )}
      {state === 'running' && secondaryButton(t('nodeFixCancelRun'), onCancel)}
      {state === 'success' && (
        <>
          {secondaryButton(t('nodeFixClose'), onClose)}
          <button
            type="button"
            onClick={onApply}
            className="h-8 rounded-lg bg-accent px-3.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-strong"
          >
            {t('nodeFixApply')}
          </button>
        </>
      )}
      {state === 'failed' && secondaryButton(t('nodeFixClose'), onClose)}
    </div>
  )
}

export default function NodeFixModal({
  open,
  onClose,
  blockId,
  data,
  onApply,
  windowId,
  t,
}: NodeFixModalProps) {
  const [state, setState] = useState<NodeFixUiState>('input')
  const [suggestion, setSuggestion] = useState('')
  const [events, setEvents] = useState<NodeFixEvent[]>([])
  const [resultReason, setResultReason] = useState<string | undefined>(undefined)
  const [proposed, setProposed] = useState<Record<string, unknown> | undefined>(undefined)
  const sessionIdRef = useRef<string>('')

  const hasContract = !!nodeGoalContractOf(data)

  // Reset to the input screen every time the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setState('input')
      setSuggestion('')
      setEvents([])
      setResultReason(undefined)
      setProposed(undefined)
      sessionIdRef.current = ''
    }
  }, [open])

  // Subscribe to streamed progress for THIS session only.
  useEffect(() => {
    if (!open || state !== 'running') return
    const onMessage = (message: unknown) => {
      const msg = message as { type?: string; event?: NodeFixEvent }
      if (msg?.type !== 'workflows.nodeFixEvent' || !msg.event) return
      if (msg.event.sessionId !== sessionIdRef.current) return
      setEvents((prev) => [...prev, msg.event as NodeFixEvent])
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [open, state])

  const startFix = async () => {
    if (!hasContract) return
    const sessionId = makeSessionId()
    sessionIdRef.current = sessionId
    setEvents([])
    setState('running')
    const result = await sendCommand({
      type: 'workflows.nodeFix',
      sessionId,
      blockId,
      blockData: data,
      userSuggestion: suggestion,
      ...(windowId !== undefined ? { windowId } : {}),
    })
    if (result.type !== 'workflows.nodeFix') return
    if (result.data.success && result.data.proposedData) {
      setProposed(result.data.proposedData)
      setState('success')
    } else {
      setResultReason(result.data.reason)
      setState('failed')
    }
  }

  const cancelFix = async () => {
    if (sessionIdRef.current) {
      await sendCommand({ type: 'workflows.nodeFixCancel', sessionId: sessionIdRef.current }).catch(
        () => {},
      )
    }
    setState('input')
  }

  const title =
    state === 'success'
      ? t('nodeFixSuccess')
      : state === 'failed'
        ? t('nodeFixFailed')
        : t('nodeFixTitle')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      icon="lucide:Wand2"
      accent="var(--we-accent)"
      size="md"
    >
      <NodeFixBody
        state={state}
        hasContract={hasContract}
        suggestion={suggestion}
        events={events}
        resultReason={resultReason}
        onSuggestionChange={setSuggestion}
        t={t}
      />
      <NodeFixFooter
        state={state}
        hasContract={hasContract}
        onClose={onClose}
        onConfirm={() => void startFix()}
        onCancel={() => void cancelFix()}
        onApply={() => {
          if (proposed) onApply(proposed)
          onClose()
        }}
        t={t}
      />
    </Modal>
  )
}
