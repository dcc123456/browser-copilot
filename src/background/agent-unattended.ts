/**
 * Runs a single unattended agent turn and returns its text answer.
 *
 * Shared by scheduled "agent prompt" tasks and by ad-hoc Feishu commands, so the
 * two entry points behave identically: the agent has no panel to stream to and no
 * human to click an approval button, so deltas are buffered into a string and
 * confirmations are auto-resolved.
 *
 * ## Autonomy
 *
 * Scheduled tasks run in the user's configured mode. Feishu ad-hoc commands are
 * treated as an explicit "go do this" and run in `full` mode — otherwise opening
 * weibo.com and reading it would pop a hidden confirmation that can never be
 * answered, and the command would always fail. Every action is still recorded in
 * the agent history like any other turn.
 *
 * @module background/agent-unattended
 */

import { runAgentTurn } from './agent'
import { getSettings } from '../lib/storage'
import type { AgentMode } from '../lib/types'
import { retain, release } from './keepalive'

export interface UnattendedResult {
  ok: boolean
  /** The agent's final text answer, or a short description when there is none. */
  answer: string
  error?: string
  /** True when the run was stopped via its abort signal rather than finishing. */
  cancelled?: boolean
}

export interface UnattendedOptions {
  /** Abort signal used to cancel a running turn (from the board or Feishu). */
  signal?: AbortSignal
  /**
   * Called for each progress step the agent emits — tool starts/results and
   * status/error lines. The Feishu bot uses this to stream steps back to chat;
   * the running-tasks registry records them for the board.
   */
  onStep?: (kind: 'tool' | 'status' | 'result' | 'error' | 'info', text: string) => void
}

/**
 * @param prompt The user instruction.
 * @param conversationId Stable id for history/action recording.
 * @param modeOverride When set, forces the autonomy mode for this turn (used by
 *   Feishu commands to run unattended in full mode).
 * @param options Cancellation and progress callbacks.
 */
export async function runUnattendedPrompt(
  prompt: string,
  conversationId: string,
  modeOverride?: AgentMode,
  options: UnattendedOptions = {},
): Promise<UnattendedResult> {
  retain()
  try {
    const settings = await getSettings()
    const collected: string[] = []
    const chunks: string[] = []
    const history: { role: string; content: string }[] = [
      { role: 'user', content: prompt },
    ]

    await runAgentTurn(history as never, {
      conversationId,
      signal: options.signal,
      send: (message) => {
        if (message.type === 'delta') chunks.push(message.text)
        if (message.type === 'tool.start') {
          collected.push(`→ ${message.name}`)
          options.onStep?.('tool', `→ ${message.name}`)
        }
        if (message.type === 'tool.result') {
          collected.push(`← ${message.summary}`)
          options.onStep?.('result', `← ${message.summary}`)
        }
        if (message.type === 'status') {
          options.onStep?.('status', message.text)
        }
        if (message.type === 'error') {
          collected.push(`! ${message.message}`)
          options.onStep?.('error', message.message)
        }
      },
      // No human is watching: auto-decline any confirmation. In full mode the
      // agent does not ask in the first place, so this only matters for
      // read/semi where it makes the model report a refusal and move on.
      confirm: async () => (modeOverride === 'full' ? true : false),
      getMode: async () => modeOverride ?? settings.mode,
      getMaxToolRounds: async () => settings.maxToolRounds,
      getToolConfig: async () => ({
        disabledTools: settings.disabledTools ?? [],
        disableSystemPrompt: settings.disableSystemPrompt === true,
      }),
    })

    const answer = chunks.join('').trim()
    if (answer) return { ok: true, answer }
    const trace = collected.join('\n').trim()
    return {
      ok: false,
      answer: trace || '(no answer)',
      error: trace ? undefined : 'The agent produced no answer.',
    }
  } catch (error) {
    // An AbortError is a deliberate cancellation, not a failure to report loudly.
    if (
      options.signal?.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      return { ok: false, answer: '', cancelled: true, error: 'Cancelled' }
    }
    return {
      ok: false,
      answer: '',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    release()
  }
}
