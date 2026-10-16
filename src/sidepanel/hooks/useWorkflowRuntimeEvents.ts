/**
 * Workflow runtime event subscription hooks.
 *
 * One place the sidepanel subscribes to the unsolicited background events:
 * autonomous repair progress (`workflows.repairEvent`) and the per-node AI fix
 * stream (`workflows.nodeFixEvent`). The hooks keep the accumulated event stream
 * and expose it to the repair progress dialog / running board / workflow dialog.
 *
 * Pure React: transport is `chrome.runtime.onMessage`.
 *
 * @module sidepanel/hooks/useWorkflowRuntimeEvents
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RepairProgressEvent } from '../../lib/workflow/repair-events'
import {
  nodeFixLogLinesOf,
  type NodeFixEvent,
  type NodeFixLogLabels,
} from '../../lib/workflow/node-fix'

export interface RepairEventState {
  events: RepairProgressEvent[]
  running: boolean
  /** Workflow the accumulated session belongs to ('' before `repair.started`). */
  workflowId: string
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
  const [sessionWorkflowId, setSessionWorkflowId] = useState('')

  const reset = useCallback(() => {
    setEvents([])
    runningRef.current = false
    setRunning(false)
    setSessionWorkflowId('')
  }, [])

  useEffect(() => {
    // Maps repair session ids to their workflow (from the started event).
    const sessionWorkflow = new Map<string, string>()
    const listener = (message: unknown): void => {
      if (!isRepairEventMessage(message)) return
      const event = message.event
      if (event.type === 'repair.started') {
        sessionWorkflow.set(event.sessionId, event.workflowId)
        setSessionWorkflowId(event.workflowId)
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

  return {
    state: { events, running, workflowId: workflowId ?? sessionWorkflowId },
    reset,
  }
}

/** How many fix events one panel keeps for its live log (a fix makes ~20). */
const NODE_FIX_LOG_CAP = 120

interface NodeFixEventMessage {
  type: 'workflows.nodeFixEvent'
  event: NodeFixEvent
}

/** Accumulates the per-node AI fix stream for this panel (transport: runtime messages). */
function useNodeFixEvents(): NodeFixEvent[] {
  const [events, setEvents] = useState<NodeFixEvent[]>([])

  useEffect(() => {
    const listener = (message: unknown): void => {
      const payload = message as NodeFixEventMessage | undefined
      if (!payload || payload.type !== 'workflows.nodeFixEvent' || !payload.event) return
      setEvents((previous) => [...previous, payload.event].slice(-NODE_FIX_LOG_CAP))
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  return events
}

/**
 * The AI fix stream as log lines — the same projection the editor's AI Fix
 * dialog shows, so both dialogs read one event stream in one wording.
 */
export function useNodeFixLog(labels: NodeFixLogLabels): string[] {
  return useNodeFixEvents().flatMap((event) => nodeFixLogLinesOf(event, labels))
}
