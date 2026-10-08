/**
 * Editor-side subscription to the autonomous repair event stream.
 *
 * The run path starts the repair in the background (see
 * `workflows.run` in `background/index.ts`), so the editor tab only sees the
 * broadcast `workflows.repairEvent` messages. This hook filters them to the
 * workflow open in this editor and collapses them into one UI state — always
 * settled once a terminal event arrives, so the chip never keeps spinning
 * after the repair gave up.
 *
 * @module workflow-editor/use-repair-events
 */
import { useCallback, useEffect, useState } from 'react'
import { sendCommand } from '../lib/messages'
import type { RepairProgressEvent } from '../lib/workflow/repair-events'
import { repairEventIsTerminal } from '../lib/workflow/repair-events'

export type EditorRepairState = 'idle' | 'running' | 'success' | 'failed'

export interface EditorRepairStatus {
  state: EditorRepairState
  /** Why the repair stopped (terminal event reason). */
  reason?: string
}

interface RepairEventMessage {
  type: 'workflows.repairEvent'
  event: RepairProgressEvent
}

export function useRepairEvents(workflowId: string | undefined): {
  status: EditorRepairStatus
  cancel: () => void
} {
  const [status, setStatus] = useState<EditorRepairStatus>({ state: 'idle' })

  useEffect(() => {
    if (!workflowId) return
    // Session ids belonging to this workflow (learned from `repair.started`).
    const sessions = new Set<string>()
    const listener = (message: unknown): void => {
      const payload = message as RepairEventMessage | undefined
      if (!payload || payload.type !== 'workflows.repairEvent') return
      const event = payload.event
      if (event.type === 'repair.started') {
        if (event.workflowId !== workflowId) return
        sessions.add(event.sessionId)
        setStatus({ state: 'running' })
        return
      }
      if (!sessions.has(event.sessionId)) return
      if (event.type === 'repair.attempt-failed') return
      if (!repairEventIsTerminal(event.type)) return
      setStatus({
        state: event.type === 'repair.success' ? 'success' : 'failed',
        ...('reason' in event ? { reason: event.reason } : {}),
      })
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [workflowId])

  const cancel = useCallback((): void => {
    if (!workflowId) return
    void sendCommand({ type: 'workflows.autoRepairCancel', id: workflowId }).catch(() => undefined)
  }, [workflowId])

  return { status, cancel }
}
