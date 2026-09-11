/**
 * Replay-view construction for the agent port.
 *
 * Lives in its own module so tests can exercise the transcript → replay
 * mapping without importing the service worker entry point, which registers
 * listeners as an import side effect.
 *
 * @module background/restore
 */

import type { AttachmentSummary } from '../lib/attachments'
import { toAttachmentSummaries } from '../lib/attachments'
import type { WireMessage } from '../lib/llm'
import { summarizeToolResult } from './agent'

/** One replayed transcript entry, shaped for the side panel. */
export interface RestoreMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
  attachments?: AttachmentSummary[]
}

/**
 * Leading directive bound to a user turn when a skill was pinned for it
 * (see `wrapSkillDirective`). Transcripts saved before displayContent existed
 * carry this envelope inside the user `content`; the regex lets replays strip
 * it back to what the user actually typed. The bracket body contains no other
 * `]`, so a non-greedy match stops at the real closing bracket.
 */
const LEGACY_SKILL_DIRECTIVE =
  /^\[The user has selected the skill "[^"]*" and it is ACTIVE\.[\s\S]*?\]\n{2}/

/** Opening of the envelope prepended when "attach page selection" was on. */
const LEGACY_SELECTION_PREFIX = 'Content selected on the page I am viewing:\n'
/** Marker separating the captured selection from the user's own question. */
const LEGACY_QUESTION_MARKER = '\n\nMy question: '

/**
 * Best-effort recovery of the user's real text from a page-selection envelope
 * persisted before displayContent existed. Only acts on the exact envelope
 * shape; the question follows the FINAL marker because selection text itself
 * could contain the same words.
 */
function unwrapLegacySelection(text: string): string {
  if (!text.startsWith(LEGACY_SELECTION_PREFIX) || !text.includes('\nSelection:\n')) {
    return text
  }
  const markerAt = text.lastIndexOf(LEGACY_QUESTION_MARKER)
  return markerAt >= 0 ? text.slice(markerAt + LEGACY_QUESTION_MARKER.length) : text
}

/** Minimal shape of a stored user turn needed for display recovery. */
type UserTurnLike = { content: string; displayContent?: string }

/**
 * Returns the text the UI should show for a stored user turn.
 *
 * Prefers `displayContent` (the raw user text saved alongside the model-facing
 * `content`). For transcripts persisted before that field existed, strips the
 * skill directive and/or page-selection envelopes that used to be baked into
 * `content` — otherwise reopening an old conversation showed internal prompt
 * text as if the user had typed it.
 */
export function getUserDisplayText(entry: UserTurnLike): string {
  if (typeof entry.displayContent === 'string') return entry.displayContent
  let text = entry.content
  const directive = LEGACY_SKILL_DIRECTIVE.exec(text)
  if (directive) text = text.slice(directive[0].length)
  return unwrapLegacySelection(text)
}

/**
 * Maps a stored transcript to the `restore` / `conversations.get` replay
 * shape. Tool results are rendered through the same summarizer live turns use,
 * labeled with the tool name recovered from the assistant turn's tool_calls,
 * and user attachments are reduced to summaries (no inline text content) so
 * reopening a conversation stays cheap.
 */
export function toRestoreMessages(history: readonly WireMessage[]): RestoreMessage[] {
  // Build a tool_call_id -> tool name map from the assistant turns, so a
  // replayed tool result can be labeled with its action instead of dumped as
  // raw JSON. The stored tool content is the raw result string; the
  // human-readable chip is regenerated here the same way live turns do.
  const toolNames = new Map<string, string>()
  for (const entry of history) {
    if (entry.role !== 'assistant' || !entry.tool_calls) continue
    for (const call of entry.tool_calls) {
      if (call.id && call.function?.name) toolNames.set(call.id, call.function.name)
    }
  }
  return history
    .filter(
      (entry) =>
        entry.role === 'user' || entry.role === 'assistant' || entry.role === 'tool',
    )
    .map((entry) => {
      if (entry.role === 'tool') {
        const name = toolNames.get(entry.tool_call_id) ?? 'tool'
        return {
          role: 'tool' as const,
          text: `← ${name}: ${summarizeToolResult(name, entry.content)}`,
        }
      }
      if (entry.role === 'user') {
        return {
          role: 'user' as const,
          text: getUserDisplayText(entry),
          ...(entry.attachments?.length
            ? { attachments: toAttachmentSummaries(entry.attachments) }
            : {}),
        }
      }
      return {
        role: 'assistant' as const,
        text: typeof entry.content === 'string' ? entry.content : '',
      }
    })
}
