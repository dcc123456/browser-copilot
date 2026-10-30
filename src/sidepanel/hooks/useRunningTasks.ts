/**
 * Live view of the worker's in-flight runs, shared by the activity board and
 * the Workflows / Tasks cards.
 *
 * The worker keeps running runs in memory (`background/running-tasks`); the
 * only way to see them is the `tasks.running` command, so every surface that
 * needs "is this item running right now?" polls the same snapshot. Keeping the
 * polling and the cancel bookkeeping here means the board and the two lists
 * cannot disagree about whether a run is still alive.
 *
 * @module sidepanel/hooks/useRunningTasks
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { sendCommand, type FinishedTaskView, type RunningTaskView } from '../../lib/messages'

/** Matches the activity board's refresh cadence. */
const POLL_MS = 1500

export interface RunningTasks {
  running: RunningTaskView[]
  /** Retained by the board's "recently finished" strip; lists ignore it. */
  finished: FinishedTaskView[]
  /** Run ids whose terminate request was accepted but has not unwound yet. */
  cancellingIds: ReadonlySet<string>
  cancel: (runId: string) => Promise<void>
  /** Re-read the snapshot (e.g. after deleting a finished entry). */
  refresh: () => Promise<void>
}

export function useRunningTasks(): RunningTasks {
  const [running, setRunning] = useState<RunningTaskView[]>([])
  const [finished, setFinished] = useState<FinishedTaskView[]>([])
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set())
  // Polls and a cancel-triggered refresh can overlap; one in flight is enough.
  const inFlight = useRef(false)
  const disposed = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const result = await sendCommand({ type: 'tasks.running' })
      if (disposed.current || result.type !== 'tasks.running') return
      setRunning(result.runs)
      setFinished(result.finished)

      // Drop "Cancelling…" from runs that have actually left the list, so a
      // later run of the same task never inherits the state.
      const runningIds = new Set(result.runs.map((run) => run.runId))
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
    } catch {
      /* Best-effort: keep the last snapshot and poll again. */
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    disposed.current = false
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => {
      disposed.current = true
      clearInterval(timer)
    }
  }, [refresh])

  const cancel = useCallback(
    async (runId: string): Promise<void> => {
      setCancellingIds((prev) => new Set(prev).add(runId))
      try {
        await sendCommand({ type: 'tasks.cancel', runId })
      } finally {
        await refresh()
      }
    },
    [refresh],
  )

  return { running, finished, cancellingIds, cancel, refresh }
}
