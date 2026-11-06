/**
 * Request/answer hub for the `parameter-prompt` dialog.
 *
 * One run can own at most one open prompt, but several runs (and two editor
 * windows) can be alive at once, so every request carries a random id and the
 * initiator's token. The request is broadcast to every extension page; only
 * the page that started the run matches the token and renders the dialog. The
 * answer comes back through `workflows.runInputAnswer`.
 *
 * The wait is bounded by the block's timeout (zero becomes the worker-lifetime
 * cap) and settles on cancellation. While waiting, the hub holds a keepalive:
 * without it an idle MV3 worker would be evicted and the dialog would answer a
 * dead run.
 *
 * The hub is injectable so tests can drive timeout / answer / abort without
 * `chrome`; the module-level instance is what the app uses.
 *
 * @module background/run-input-hub
 */

import { retain, release } from './keepalive'
import type { RunInputAnswer, RunInputPrompt, RunInputRequest } from '../lib/workflow/run-input'
import { newRunInputToken } from '../lib/workflow/run-input'

export interface RunInputHubDeps {
  /** Fan one message out to every extension page. No receiver is fine. */
  broadcast: (message: unknown) => Promise<void>
  retain?: () => void
  release?: () => void
}

export interface RunInputRequestInput extends RunInputPrompt {
  promptToken: string
  runId: string
  workflowId: string
  workflowName: string
}

export interface RunInputHub {
  request(input: RunInputRequestInput, signal: AbortSignal): Promise<RunInputAnswer>
  /** Answers a pending prompt; false when it already settled or never existed. */
  answer(requestId: string, answer: RunInputAnswer): boolean
}

interface PendingRequest {
  request: RunInputRequest
  settle: (answer: RunInputAnswer) => void
}

export function createRunInputHub(deps: RunInputHubDeps): RunInputHub {
  const pending = new Map<string, PendingRequest>()
  const hold = deps.retain ?? ((): void => {})
  const drop = deps.release ?? ((): void => {})

  const settle = (entry: PendingRequest, answer: RunInputAnswer): void => {
    if (!pending.delete(entry.request.requestId)) return
    drop()
    // Every surface hears the settle so a dialog that lost the race (or was
    // shown by a second page with the same token) closes itself.
    void deps.broadcast({ type: 'workflows.runInputSettled', requestId: entry.request.requestId })
    entry.settle(answer)
  }

  return {
    request(input, signal) {
      if (signal.aborted) {
        return Promise.resolve({ values: {}, cancelled: true })
      }
      const request: RunInputRequest = {
        ...input,
        requestId: newRunInputToken('input'),
        at: Date.now(),
      }
      return new Promise<RunInputAnswer>((resolve) => {
        const entry: PendingRequest = { request, settle: resolve }
        pending.set(request.requestId, entry)
        hold()
        const timer =
          request.timeoutMs > 0
            ? setTimeout(() => settle(entry, { values: {}, timedOut: true }), request.timeoutMs)
            : undefined
        const onAbort = (): void => settle(entry, { values: {}, cancelled: true })
        signal.addEventListener('abort', onAbort, { once: true })
        // Wrap the resolve so the listener/timer are torn down exactly once.
        const finish = entry.settle
        entry.settle = (answer) => {
          if (timer !== undefined) clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          finish(answer)
        }
        void deps.broadcast({ type: 'workflows.runInputRequest', request }).catch(() => {
          // No page listening: the timeout settles this on its own.
        })
      })
    },

    answer(requestId, answer) {
      const entry = pending.get(requestId)
      if (!entry) return false
      settle(entry, answer)
      return true
    },
  }
}

/** The app's hub: page fan-out plus the worker keepalive. */
const sharedHub = createRunInputHub({
  broadcast: async (message) => {
    try {
      await chrome.runtime.sendMessage(message)
    } catch {
      // No extension page subscribed.
    }
  },
  retain,
  release,
})

/** Ask the initiating page for the block's parameters. */
export function requestRunInput(
  input: RunInputRequestInput,
  signal: AbortSignal,
): Promise<RunInputAnswer> {
  return sharedHub.request(input, signal)
}

/** Resolve an open prompt from a page's answer. */
export function answerRunInput(requestId: string, answer: RunInputAnswer): boolean {
  return sharedHub.answer(requestId, answer)
}
