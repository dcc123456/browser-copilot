/**
 * Shared "activity" board: live list of currently running workflow/task runs
 * plus a strip of the most recently finished ones.
 *
 * Previously this board was duplicated at the top of the Workflows tab and the
 * Tasks tab, each with its own polling loop. It now lives here so the History
 * tab is the single place a user watches or cancels a run. The component
 * manages its own polling, cancellation state, and finished-step expansion;
 * the parent only supplies an `onSettled` callback if it wants to reload
 * persistent data after a run leaves the running set.
 *
 * The worker returns the same view for both `tasks.running` and
 * `workflows.running`; we always use `tasks.*` commands because cancel /
 * delete / clear are all namespaced that way.
 *
 * @module sidepanel/RunningBoard
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { sendCommand, type FinishedTaskView, type RunningTaskView } from '../lib/messages'
import { useT } from './i18n'

interface RunningBoardProps {
  /**
   * Called whenever the board observes a run leaving the running set or a new
   * entry appearing in the finished set — the signal for the parent to reload
   * any persisted run log it displays below.
   */
  onSettled?: () => void
  /** Disables all interactive controls while the parent is busy. */
  busy?: boolean
}

export default function RunningBoard({ onSettled, busy }: RunningBoardProps): ReactElement {
  const t = useT()
  const [running, setRunning] = useState<RunningTaskView[]>([])
  const [finished, setFinished] = useState<FinishedTaskView[]>([])
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set())
  const [localBusy, setLocalBusy] = useState(false)
  // The board can be collapsed to reclaim vertical space. A newly started run
  // re-opens it automatically (see effect below); afterwards the user can
  // re-collapse freely.
  const [collapsed, setCollapsed] = useState(false)

  const anyBusy = Boolean(busy) || localBusy

  const wasRunningRef = useRef(false)
  useEffect(() => {
    const wasRunning = wasRunningRef.current
    wasRunningRef.current = running.length > 0
    if (!wasRunning && running.length > 0) setCollapsed(false)
  }, [running.length])

  const toggleCollapsed = (): void => setCollapsed((v) => !v)

  const prevRunningIds = useRef<Set<string>>(new Set())
  const prevFinishedIds = useRef<Set<string>>(new Set())
  // Keep the latest onSettled without resetting the polling interval each render.
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  }, [onSettled])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await sendCommand({ type: 'tasks.running' })
      if (result.type !== 'tasks.running') return
      setRunning(result.runs)
      setFinished(result.finished)

      const runningIds = new Set(result.runs.map((r) => r.runId))
      const finishedIds = new Set(result.finished.map((r) => r.runId))

      // Once a cancelled run leaves the running list, drop its "Cancelling…"
      // state so a future run never inherits it.
      setCancellingIds((prev) => {
        if (prev.size === 0) return prev
        let changed = false
        const next = new Set<string>()
        for (const id of prev) {
          if (runningIds.has(id)) next.add(id)
          else changed = true
        }
        return changed ? next : prev
      })

      let settled = false
      for (const id of prevRunningIds.current) {
        if (!runningIds.has(id)) {
          settled = true
          break
        }
      }
      if (!settled) {
        for (const id of finishedIds) {
          if (!prevFinishedIds.current.has(id)) {
            settled = true
            break
          }
        }
      }
      if (settled) onSettledRef.current?.()
      prevRunningIds.current = runningIds
      prevFinishedIds.current = finishedIds
    } catch {
      /* non-fatal; keep polling */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 1500)
    return () => clearInterval(timer)
  }, [refresh])

  const cancelRunning = useCallback(async (runId: string): Promise<void> => {
    setCancellingIds((prev) => {
      const next = new Set(prev)
      next.add(runId)
      return next
    })
    setLocalBusy(true)
    try {
      await sendCommand({ type: 'tasks.cancel', runId })
      await refresh()
    } finally {
      setLocalBusy(false)
    }
  }, [refresh])

  const deleteFinished = useCallback(async (runId: string): Promise<void> => {
    setLocalBusy(true)
    try {
      await sendCommand({ type: 'tasks.finished.delete', runId })
      await refresh()
    } finally {
      setLocalBusy(false)
    }
  }, [refresh])

  const clearFinished = useCallback(async (): Promise<void> => {
    if (!confirm(t.taskClearFinishedConfirm)) return
    setLocalBusy(true)
    try {
      await sendCommand({ type: 'tasks.finished.clear' })
      await refresh()
    } finally {
      setLocalBusy(false)
    }
  }, [t, refresh])

  const sourceLabel = (source: RunningTaskView['source']): string => {
    switch (source) {
      case 'feishu':
        return t.taskSourceFeishu
      case 'chat':
        return t.taskSourceChat
      case 'manual':
        return t.taskSourceManual
      case 'schedule':
      default:
        return t.taskSourceSchedule
    }
  }

  const outcomeLabel = (outcome: FinishedTaskView['outcome']): string => {
    switch (outcome) {
      case 'ok':
        return t.taskOutcomeOk
      case 'cancelled':
        return t.taskOutcomeCancelled
      case 'skipped':
        return t.taskOutcomeSkipped
      case 'failed':
      default:
        return t.taskOutcomeFailed
    }
  }

  return (
    <div
      className={`card running-board${running.length > 0 ? ' running-board-active' : ''}${
        collapsed ? ' running-board-collapsed' : ''
      }`}
    >
      <button
        type="button"
        className="running-board-head"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        title={collapsed ? t.tasksActivityExpand : t.tasksActivityCollapse}
      >
        <h3>
          <span className={`running-board-caret${collapsed ? '' : ' open'}`} aria-hidden="true">
            ▸
          </span>
          {running.length > 0 && <span className="running-dot" />}
          {t.tasksActivity}
          {running.length > 0 && <span className="running-count">{running.length}</span>}
          {collapsed && finished.length > 0 && (
            <span className="running-finished-count">{finished.length}</span>
          )}
        </h3>
      </button>

      {!collapsed && (
        <>
          {running.length === 0 ? (
            <p className="hint running-empty">{t.tasksRunningEmpty}</p>
          ) : (
            <ul className="running-list">
              {running.map((run) => {
                const cancelling = cancellingIds.has(run.runId)
                return (
                  <li className="running-item" key={run.runId}>
                    <div className="running-item-head">
                      <strong className="running-label">{run.label || t.taskUntitled}</strong>
                      <button
                        className={`running-cancel${cancelling ? ' running-cancel-busy' : ''}`}
                        disabled={anyBusy || cancelling}
                        onClick={() => void cancelRunning(run.runId)}
                        type="button"
                      >
                        {cancelling ? t.taskCancelling : t.taskTerminate}
                      </button>
                    </div>
                    <div className="running-meta">
                      <span className="run-tag">{sourceLabel(run.source)}</span>
                      <span>
                        {t.taskStartedAt}: {new Date(run.startedAt).toLocaleTimeString(navigator.language)}
                      </span>
                    </div>
                    {run.steps.length > 0 && (
                      <ul className="running-steps">
                        {run.steps.slice(-8).map((step, index) => (
                          <li className={`running-step running-step-${step.kind}`} key={index}>
                            {step.text}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {finished.length > 0 && (
            <>
              <div className="running-divider" />
              <div className="running-section-head">
                <h4 className="running-section-title">{t.tasksRecentlyFinished}</h4>
                <button
                  className="link running-clear"
                  disabled={anyBusy}
                  onClick={() => void clearFinished()}
                  type="button"
                >
                  {t.taskClearFinished}
                </button>
              </div>
              <FinishedList
                runs={finished.slice(0, 8)}
                sourceLabel={sourceLabel}
                outcomeLabel={outcomeLabel}
                onDelete={(id) => void deleteFinished(id)}
                disabled={anyBusy}
                t={t}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}

// --- Finished runs -----------------------------------------------------------

interface FinishedListProps {
  runs: FinishedTaskView[]
  sourceLabel: (source: FinishedTaskView['source']) => string
  outcomeLabel: (outcome: FinishedTaskView['outcome']) => string
  onDelete: (runId: string) => void
  disabled?: boolean
  t: ReturnType<typeof useT>
}

function FinishedList({
  runs,
  sourceLabel,
  outcomeLabel,
  onDelete,
  disabled,
  t,
}: FinishedListProps): ReactElement {
  const [openId, setOpenId] = useState<string | null>(null)
  return (
    <ul className="finished-list">
      {runs.map((run) => {
        const isOpen = openId === run.runId
        return (
          <li className={`finished-item finished-${run.outcome}`} key={run.runId}>
            <button
              className="finished-row"
              disabled={disabled || run.steps.length === 0}
              onClick={() => setOpenId(isOpen ? null : run.runId)}
              type="button"
            >
              <span className="finished-caret">
                {run.steps.length > 0 ? (isOpen ? '▾' : '▸') : ''}
              </span>
              <span className={`finished-dot finished-dot-${run.outcome}`} />
              <span className="finished-name">{run.label || t.taskUntitled}</span>
              <span className="run-tag">{sourceLabel(run.source)}</span>
              <span className={`finished-badge finished-badge-${run.outcome}`}>
                {outcomeLabel(run.outcome)}
              </span>
            </button>
            <button
              aria-label={t.delete}
              className="danger finished-delete"
              disabled={disabled}
              onClick={() => onDelete(run.runId)}
              title={t.delete}
              type="button"
            >
              ×
            </button>
            {isOpen && run.steps.length > 0 && (
              <ul className="running-steps finished-steps">
                {run.steps.map((step, index) => (
                  <li className={`running-step running-step-${step.kind}`} key={index}>
                    {step.text}
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}
