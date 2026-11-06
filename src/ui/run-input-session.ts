/**
 * The page's active `parameter-prompt` session.
 *
 * A run may be launched from more than one extension page at a time (two
 * editor windows; the side panel plus an editor tab). The background
 * broadcasts each prompt to every page together with the token of the page
 * that launched the run; a page only renders the dialog whose token matches the
 * run IT started.
 *
 * The token lives in module state rather than in component state on purpose:
 * the prompt host is mounted for the page's whole life and must see the token
 * the moment the run command is about to be sent — a React state update would
 * only reach the host's listener on the next render, which races the worker's
 * first broadcast.
 *
 * @module ui/run-input-session
 */

import { newRunInputToken } from '../lib/workflow/run-input'
import type { RunInputRequest } from '../lib/workflow/run-input'

let activeToken: string | null = null

/** Start a run from this page: subsequent prompts for it are ours to show. */
export function beginRunInputSession(): string {
  activeToken = newRunInputToken('prompt')
  return activeToken
}

/** The run is over (settled, failed, cancelled): stop claiming its prompts. */
export function endRunInputSession(token: string): void {
  if (activeToken === token) activeToken = null
}

/** Does this broadcast belong to the run THIS page launched? */
export function isOwnRunInput(request: RunInputRequest): boolean {
  return activeToken !== null && request.promptToken === activeToken
}

/** Test/diagnostic accessor. */
export function activeRunInputToken(): string | null {
  return activeToken
}
