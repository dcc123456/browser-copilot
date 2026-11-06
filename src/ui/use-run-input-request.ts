/**
 * Receives the worker's `workflows.runInputRequest` broadcasts for the run this
 * page started, and answers them.
 *
 * The listener is mounted for the page's lifetime (not only while a token is
 * set) so a prompt that arrives immediately after the run command is still
 * seen; `isOwnRunInput` filters against the live session token at receipt time.
 *
 * More than one prompt can be outstanding in theory (a run waiting on a
 * `parameter-prompt` while another workflow starts), so requests queue and are
 * shown one at a time. A `runInputSettled` broadcast removes a request that
 * timed out or was cancelled from elsewhere.
 *
 * @module ui/use-run-input-request
 */

import { useCallback, useEffect, useState } from 'react'
import { sendCommand } from '../lib/messages'
import type { RunInputAnswer, RunInputRequest } from '../lib/workflow/run-input'
import { isOwnRunInput } from './run-input-session'

export interface RunInputController {
  /** The prompt to render now, if any. */
  request: RunInputRequest | null
  submit: (values: Record<string, string>) => void
  /** Stops the run behind this prompt. */
  cancel: () => void
}

export function useRunInputRequest(): RunInputController {
  const [pending, setPending] = useState<RunInputRequest[]>([])

  useEffect(() => {
    const handler = (message: unknown): undefined => {
      const msg = message as
        { type?: string; request?: RunInputRequest; requestId?: string } | undefined
      if (msg?.type === 'workflows.runInputRequest' && msg.request) {
        const request = msg.request
        if (!isOwnRunInput(request)) return undefined
        setPending((prev) =>
          prev.some((item) => item.requestId === request.requestId) ? prev : [...prev, request],
        )
      } else if (msg?.type === 'workflows.runInputSettled' && typeof msg.requestId === 'string') {
        const settledId = msg.requestId
        setPending((prev) => prev.filter((item) => item.requestId !== settledId))
      }
      return undefined
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  const answer = useCallback((requestId: string, response: RunInputAnswer): void => {
    // Close first: the answer is best-effort, and a failure here must not leave
    // a dialog the user already dismissed on screen.
    setPending((prev) => prev.filter((item) => item.requestId !== requestId))
    void sendCommand({
      type: 'workflows.runInputAnswer',
      requestId,
      values: response.values,
      ...(response.cancelled ? { cancelled: true } : {}),
    }).catch(() => {
      // The run already settled (timeout / cancel / worker gone).
    })
  }, [])

  const current = pending[0] ?? null

  return {
    request: current,
    submit: (values) => {
      if (current) answer(current.requestId, { values })
    },
    cancel: () => {
      if (current) answer(current.requestId, { values: {}, cancelled: true })
    },
  }
}
