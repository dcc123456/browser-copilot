/**
 * Workflow runtime event subscription hooks.
 *
 * One place the sidepanel subscribes to the unsolicited background events:
 * autonomous repair progress (`workflows.repairEvent`). The hook keeps the
 * accumulated event stream per workflow and exposes it to the repair
 * progress dialog / running board.
 *
 * Pure React: transport is `chrome.runtime.onMessage`.
 *
 * @module sidepanel/hooks/useWorkflowRuntimeEvents
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RepairProgressEvent } from '../../lib/workflow/repair-events'

export interface RepairEventState {
  events: RepairProgressEvent[]
  running: boolean
}

interface RepairEventMessage {
  type: 'workflows.repairEvent'
  event: RepairProgressEvent
}

function isRepairEventMessage(message: unknown): message is RepairEventMessage {
  return !!message && (message as { type?: unknown }).type === 'workflows.repairEvent'
}

/**
 * Subscribe to repair progress events.
 *
 * @param workflowId when supplied, only that workflow's events accumulate;
 *                   undefined accumulates every workflow (keyed separately).
 */
export function useRepairEvents(workflowId?: string): {
  state: RepairEventState
  reset: () => void
} {
  const [events, setEvents] = useState<RepairProgressEvent[]>([])
  const runningRef = useRef(false)
  const [running, setRunning] = useState(false)

  const reset = useCallback(() => {
    setEvents([])
    runningRef.current = false
    setRunning(false)
  }, [])

  useEffect(() => {
    // Maps repair session ids to their workflow (from the started event).
    const sessionWorkflow = new Map<string, string>()
    const listener = (message: unknown): void => {
      if (!isRepairEventMessage(message)) return
      const event = message.event
      if (event.type === 'repair.started') {
        sessionWorkflow.set(event.sessionId, event.workflowId)
      }
      if (workflowId) {
        const owner =
          event.type === 'repair.started' ? event.workflowId : sessionWorkflow.get(event.sessionId)
        if (owner !== workflowId) return
      }

      setEvents((previous) => [...previous, event])
      const terminal =
        event.type === 'repair.success' ||
        event.type === 'repair.exhausted' ||
        event.type === 'repair.blocked'
      runningRef.current = !terminal
      setRunning(!terminal)
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [workflowId])

  return { state: { events, running }, reset }
}
