/**
 * Wire protocol between the side panel and the service worker.
 *
 * Two channels, chosen deliberately:
 * - Request/response commands go over `chrome.runtime.sendMessage`.
 * - The agent turn uses a long-lived `chrome.runtime.connect` port. An open
 *   port keeps the service worker alive for the duration of the stream, which
 *   `sendMessage` would not, and it lets tokens arrive incrementally.
 *
 * @module lib/messages
 */

import type { ProviderProfile } from './providers'
import type { PageContext, Settings, Skill } from './types'

/** Port name for the streaming agent channel. */
export const AGENT_PORT = 'agent'

/** Commands the side panel can issue. */
export type Command =
  | { type: 'settings.get' }
  | { type: 'settings.set'; patch: Partial<Settings> }
  | { type: 'skills.list' }
  | { type: 'skills.save'; skill: Skill }
  | { type: 'skills.delete'; id: string }
  | { type: 'provider.save'; profile: ProviderProfile }
  | { type: 'provider.delete'; id: string }
  | { type: 'provider.activate'; id: string }
  | { type: 'provider.test'; profile: ProviderProfile }
  | { type: 'provider.models'; profile: ProviderProfile }
  | { type: 'page.read'; maxChars?: number }
  /**
   * Reports whether the active tab can be read at all.
   *
   * Separate from `page.read` because the answer is useful before there is
   * anything to read: "this is a chrome:// page" is a permanent property of the
   * tab, not a transient scraping failure, and the user needs to hear it as a
   * diagnostic rather than as an error mid-conversation.
   */
  | { type: 'page.check' }

/** Replies, discriminated by the command that produced them. */
export type CommandResult =
  | { type: 'settings'; settings: Settings }
  | { type: 'skills.list'; skills: Skill[] }
  | { type: 'skills.save'; skill: Skill }
  | { type: 'skills.delete' }
  | { type: 'provider.test' }
  | { type: 'provider.models'; models: string[] }
  | { type: 'page.read'; page: PageContext }
  | {
      type: 'page.check'
      readable: boolean
      tabUrl?: string
      tabTitle?: string
      /** Present when the tab cannot be read, explaining why. */
      reason?: string
    }

/** Envelope so a failed command never looks like a successful one. */
export type CommandResponse =
  | { ok: true; data: CommandResult }
  | { ok: false; error: string }

/** Messages the side panel sends over the agent port. */
export type AgentClientMessage =
  | {
      type: 'chat'
      /**
       * Conversation this turn belongs to. The panel owns this id and reuses it
       * across reconnects, so history survives service-worker eviction.
       */
      conversationId: string
      /** The user's text for this turn. */
      text: string
      /** When true, the current page is scraped and prepended as context. */
      includePage: boolean
      /**
       * Skill the user selected for this turn, if any.
       *
       * Sent per turn rather than held as connection state, because the worker can
       * be evicted between turns and would otherwise lose the selection.
       */
      skillId?: string
    }
  | { type: 'confirm'; requestId: string; approved: boolean }
  | { type: 'cancel' }
  | { type: 'reset'; conversationId: string }
  /**
   * Sent right after connecting: asks the worker for the stored transcript and
   * whether a turn is still running, so a reopened panel restores itself instead
   * of appearing empty.
   */
  | { type: 'resume'; conversationId: string }
  /**
   * Idle-timer heartbeat. An MV3 worker is evicted after ~30s without activity,
   * which would drop the port mid-turn; an inbound message resets that timer.
   */
  | { type: 'ping' }

/** Messages the service worker pushes back over the agent port. */
export type AgentServerMessage =
  | { type: 'delta'; text: string }
  | { type: 'tool.start'; name: string }
  | { type: 'tool.result'; name: string; summary: string }
  | {
      type: 'confirm.request'
      requestId: string
      name: string
      /** Pretty-printed arguments for the user to inspect before approving. */
      argsPreview: string
    }
  | { type: 'status'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  /**
   * The stored transcript replayed after `resume`. `running` tells the panel
   * whether to show itself as busy because a turn continued without it.
   */
  | {
      type: 'restore'
      messages: { role: 'user' | 'assistant'; text: string }[]
      running: boolean
    }

/** Typed `sendMessage` wrapper; rejects when the worker reports a failure. */
export async function sendCommand(command: Command): Promise<CommandResult> {
  const response = (await chrome.runtime.sendMessage(command)) as CommandResponse | undefined
  if (!response) throw new Error('No response from the extension service worker.')
  if (!response.ok) throw new Error(response.error)
  return response.data
}
