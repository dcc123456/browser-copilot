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
import type {
  AgentStatus,
  ConversationMeta,
  HistoryEntry,
  PageContext,
  PasswordEntry,
  Settings,
  Skill,
  UserProfile,
} from './types'
import type {
  FeishuConfig,
  ScheduledTask,
  TaskRunLog,
} from './scheduler-types'
import type { RunOutcomeKind, RunSource, RunStep } from '../background/running-tasks'
import type { Workflow } from './workflow/types'
import type { AttachmentDescriptor, AttachmentSummary } from './attachments'

/** Aggregated token usage for one agent turn (summed across all tool rounds). */
export interface TurnTokenUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  totalTokens: number
}

/** A running task as shown on the Tasks tab board. */
export interface RunningTaskView {
  runId: string
  taskId?: string
  label: string
  source: RunSource
  startedAt: number
  steps: RunStep[]
}

/** A recently completed task as shown on the Tasks tab board. */
export interface FinishedTaskView {
  runId: string
  taskId?: string
  label: string
  source: RunSource
  startedAt: number
  finishedAt: number
  outcome: RunOutcomeKind
  summary?: string
  steps: RunStep[]
}

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
   */
  | { type: 'page.check' }

  // --- User profiles (autofill memory) ---
  | { type: 'profiles.list' }
  | { type: 'profiles.save'; profile: UserProfile }
  | { type: 'profiles.delete'; id: string }

  // --- Password vault ---
  | { type: 'passwords.list' }
  | { type: 'passwords.save'; entry: PasswordEntry }
  | { type: 'passwords.delete'; id: string }

  // --- Action history ---
  | { type: 'history.list' }
  | { type: 'history.delete'; id: string }
  | { type: 'history.clear' }

  // --- Conversations ---
  | { type: 'conversations.list' }
  | { type: 'conversations.get'; id: string }
  | { type: 'conversations.rename'; id: string; title: string }
  | { type: 'conversations.delete'; id: string }

  // --- Scheduled tasks ---
  | { type: 'tasks.list' }
  | { type: 'tasks.save'; task: ScheduledTask }
  | { type: 'tasks.delete'; id: string }
  | { type: 'tasks.run'; id: string }
  | { type: 'tasks.runs'; taskId?: string }
  | { type: 'tasks.runs.clear'; taskId?: string }
  | { type: 'tasks.runs.delete'; id: string }
  | { type: 'tasks.running' }
  | { type: 'tasks.cancel'; runId: string }
  | { type: 'tasks.finished.delete'; runId: string }
  | { type: 'tasks.finished.clear' }

  // --- Feishu integration ---
  | { type: 'feishu.get' }
  | { type: 'feishu.save'; config: FeishuConfig }
  | { type: 'feishu.test' }

  // --- Workflows ---
  | { type: 'workflows.list' }
  | { type: 'workflows.get'; id: string }
  | { type: 'workflows.save'; workflow: Workflow }
  | { type: 'workflows.delete'; id: string }
  | { type: 'workflows.run'; id: string; /** Run the graph starting at this node id ("run from here"). */ startAt?: string }
  | { type: 'workflows.running'; workflowId?: string }

  // --- Workflow recording (see background/record-controller.ts) ---
  /** Start recording: injects the recorder into all http tabs, sets the rec badge. */
  | { type: 'record.start' }
  /** Stop recording and convert the captured blocks into a saved workflow. */
  | { type: 'record.stop' }
  /** Whether a recording session is currently active. */
  | { type: 'record.status' }

  // --- Local agent bridge (see background/agent-client.ts) ---
  /** Current outbound WebSocket connection status to the local agent. */
  | { type: 'agent.status.get' }

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
      reason?: string
    }
  | { type: 'profiles.list'; profiles: UserProfile[] }
  | { type: 'profiles.save' }
  | { type: 'profiles.delete' }
  | { type: 'passwords.list'; entries: PasswordEntry[] }
  | { type: 'passwords.save' }
  | { type: 'passwords.delete' }
  | { type: 'history.list'; entries: HistoryEntry[] }
  | { type: 'history.delete' }
  | { type: 'history.clear' }
  | { type: 'conversations.list'; conversations: ConversationMeta[] }
  | {
      type: 'conversations.get'
      id: string
      title: string
      messages: {
        role: 'user' | 'assistant' | 'tool'
        text: string
        attachments?: AttachmentSummary[]
      }[]
    }
  | { type: 'conversations.rename' }
  | { type: 'conversations.delete' }
  | { type: 'tasks.list'; tasks: ScheduledTask[] }
  | { type: 'tasks.save' }
  | { type: 'tasks.delete' }
  | { type: 'tasks.run'; outcome: { ok: boolean; skipped: boolean; summary: string; error?: string } }
  | { type: 'tasks.runs'; runs: TaskRunLog[] }
  | { type: 'tasks.runs.clear' }
  | { type: 'tasks.runs.delete' }
  | { type: 'tasks.running'; runs: RunningTaskView[]; finished: FinishedTaskView[] }
  | { type: 'tasks.cancel'; ok: boolean }
  | { type: 'tasks.finished.delete' }
  | { type: 'tasks.finished.clear' }
  | { type: 'feishu.get'; config: FeishuConfig }
  | { type: 'feishu.save' }
  | { type: 'feishu.test'; ok: boolean; message?: string }

  // --- Workflows ---
  | { type: 'workflows.list'; workflows: Workflow[] }
  | { type: 'workflows.get'; workflow?: Workflow }
  | { type: 'workflows.save' }
  | { type: 'workflows.delete' }
  | { type: 'workflows.run'; outcome: { ok: boolean; skipped: boolean; summary: string; error?: string; runId?: string } }
  | { type: 'workflows.running'; runs: RunningTaskView[]; finished: FinishedTaskView[] }
  | { type: 'record.start'; recording: boolean }
  | { type: 'record.stop'; workflowId?: string }
  | { type: 'record.status'; recording: boolean }

  // --- Local agent bridge ---
  | { type: 'agent.status'; status: AgentStatus }

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
      /**
       * When true, the user's current text selection on the active tab is
       * prepended as context (lightweight — only the selection, not the page).
       */
      includeSelection: boolean
      /**
       * Skill the user selected for this turn, if any.
       *
       * Sent per turn rather than held as connection state, because the worker can
       * be evicted between turns and would otherwise lose the selection.
       */
      skillId?: string
      /**
       * Files attached to this turn, sent once with the opening `chat`
       * message: full descriptors (image data URLs, inline text content).
       * The worker re-validates them before persisting.
       */
      attachments?: AttachmentDescriptor[]
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
  /**
   * A short, machine-named progress phase. The panel maps it to localized text
   * so the worker never has to know the UI language. Emitted at the key points
   * between "user pressed send" and the first streamed token, which otherwise
   * looks like a hang.
   */
  | {
      type: 'phase'
      phase: 'preparing' | 'reading-page' | 'sending' | 'thinking' | 'responding'
    }
  | { type: 'done'; usage?: TurnTokenUsage }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  /**
   * The stored transcript replayed after `resume`. `running` tells the panel
   * whether to show itself as busy because a turn continued without it.
   */
  | {
      type: 'restore'
      messages: {
        role: 'user' | 'assistant' | 'tool'
        text: string
        attachments?: AttachmentSummary[]
      }[]
      running: boolean
    }

/** Typed `sendMessage` wrapper; rejects when the worker reports a failure. */
export async function sendCommand(command: Command): Promise<CommandResult> {
  const response = (await chrome.runtime.sendMessage(command)) as CommandResponse | undefined
  if (!response) throw new Error('No response from the extension service worker.')
  if (!response.ok) throw new Error(response.error)
  return response.data
}
