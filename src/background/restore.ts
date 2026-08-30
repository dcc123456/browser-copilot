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
      return {
        role: entry.role,
        text: typeof entry.content === 'string' ? entry.content : '',
        ...(entry.role === 'user' && entry.attachments?.length
          ? { attachments: toAttachmentSummaries(entry.attachments) }
          : {}),
      }
    })
}
