/**
 * Agent-injected notes inside the transcript (progress reminders, blocker
 * notices).
 *
 * The wire format has no system-role slot mid-history, so a note has to travel
 * as a `user` message. It is NOT something the user said: it carries a stable
 * ASCII sentinel so persistence, replay, the history panel, compaction and any
 * future consumer can tell it apart from a real user turn.
 *
 * @module lib/agent-note
 */

/** Stable marker prefixed to every agent-injected note. */
export const AGENT_NOTE_SENTINEL = '[[agent-note]]'

/** Wraps instruction text as an agent note (model-facing English like other prompts). */
export function wrapAgentNote(instruction: string): string {
  return `${AGENT_NOTE_SENTINEL}\n${instruction}`
}

/** Whether a user-role message body is an agent-injected note. */
export function isAgentNoteText(text: string): boolean {
  return text.startsWith(AGENT_NOTE_SENTINEL)
}
