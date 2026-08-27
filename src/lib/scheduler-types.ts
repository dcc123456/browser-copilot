/**
 * Domain types for scheduled tasks.
 *
 * @module lib/scheduler-types
 */

/** When a task runs. */
export type Schedule =
  /**
   * No automatic run: the task exists only to be triggered by hand ("Run now"
   * in the UI, or a Feishu command). It never gets an alarm.
   */
  | { kind: 'none' }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  /**
   * Runs on the selected weekdays (0 = Sunday … 6 = Saturday, matching
   * `Date.getDay()`) at the given local time.
   */
  | { kind: 'weekly'; days: number[]; hour: number; minute: number }
  /**
   * Runs every `minutes`, starting at the time it was last (re)scheduled.
   *
   * The minimum is 1 minute, which is also the floor `chrome.alarms` enforces.
   */
  | { kind: 'interval'; minutes: number }

/** What the task actually does. */
export type TaskKind =
  /** The built-in: count PRs the user must review on GitHub. */
  | 'github-review-requests'
  /**
   * A generic prompt run through the agent.
   *
   * The prompt is sent as a user message; the agent can read/act on pages just
   * as it does in the side panel, subject to the configured mode.
   */
  | 'agent-prompt'
  /**
   * Runs a stored workflow graph via the workflow engine.
   */
  | 'workflow'

/** A configured task. */
export interface ScheduledTask {
  id: string
  name: string
  enabled: boolean
  schedule: Schedule
  kind: TaskKind
  /** Used when `kind === 'agent-prompt'`. */
  prompt?: string
  /** Used when `kind === 'workflow'`: the stored workflow to execute. */
  workflowId?: string
  /**
   * Per-task cap on model↔tool round trips for agent-prompt tasks. Scheduled
   * tasks run unattended in full-auto and can need more steps than an
   * interactive turn, so each task carries its own budget instead of using the
   * global setting. Defaults to {@link DEFAULT_TASK_MAX_TOOL_ROUNDS}.
   */
  maxToolRounds: number
  /** Whether the result is delivered via Feishu in addition to the run log. */
  notifyFeishu: boolean
  createdAt: number
  updatedAt: number
  // Last-run state, shown in the UI so the user can see whether the schedule is
  // healthy without opening Feishu.
  lastRunAt?: number
  lastStatus?: 'ok' | 'failed' | 'skipped'
  /** Short human-readable result line (e.g. "5 PRs waiting"). */
  lastSummary?: string
  lastError?: string
}

/** One execution record, kept for the UI and for debugging missed runs. */
/** One recorded progress line of a run, persisted for the history view. */
export interface TaskRunStep {
  /** Epoch ms when the step was recorded. */
  at: number
  /** Machine-ish label: "tool", "status", "result", "error", "info". */
  kind: 'tool' | 'status' | 'result' | 'error' | 'info'
  /** Human-readable text. */
  text: string
}

/** How a run ended. */
export type TaskRunOutcome = 'ok' | 'failed' | 'cancelled' | 'skipped'

export interface TaskRunLog {
  id: string
  /**
   * Configured task id for a saved/scheduled task. Ad-hoc runs (a chat turn or
   * a one-off Feishu instruction) have no task and leave this undefined, so they
   * still show up in the global run history but not under any task card.
   */
  taskId?: string
  /** Display label: task name, or a short label for an ad-hoc run. */
  label?: string
  /** Where the run was triggered from. */
  source?: 'chat' | 'schedule' | 'feishu' | 'manual'
  /**
   * 'schedule' (an alarm), 'feishu' (a bot command), or 'manual' (the UI).
   * @deprecated use `source`; retained for migrating older entries.
   */
  trigger: 'schedule' | 'feishu' | 'manual'
  startedAt?: number
  finishedAt?: number
  outcome?: TaskRunOutcome
  at: number
  ok: boolean
  /** True when the run was intentionally skipped (e.g. not logged in). */
  skipped: boolean
  summary: string
  /** True when a Feishu notification was attempted for this run. */
  notified?: boolean
  error?: string
  /** Detailed progress steps, persisted so history survives a worker restart. */
  steps?: TaskRunStep[]
}

/**
 * Feishu integration settings.
 *
 * Two independent uses:
 * - **Notifications** use a custom-bot incoming **webhook URL** (no app
 *   credentials; the simplest path for "tell me the result").
 * - **Remote control** receives commands from a person chatting to a Feishu bot,
 *   which requires a self-built app (app id + secret) and the long-connection
 *   mode. If only the webhook is set, notifications work but inbound commands do
 *   not.
 */
export interface FeishuConfig {
  /** Incoming webhook for a Feishu group custom bot. Empty disables notify. */
  webhookUrl: string
  /** Optional signing secret for the custom-bot webhook. */
  webhookSecret: string
  /** Self-built app credentials, for receiving commands via long connection. */
  appId: string
  appSecret: string
  /** Master switch for the inbound command connection. */
  botEnabled: boolean
}

export const EMPTY_FEISHU_CONFIG: FeishuConfig = {
  webhookUrl: '',
  webhookSecret: '',
  appId: '',
  appSecret: '',
  botEnabled: false,
}

/**
 * Default model↔tool round budget for a scheduled agent-prompt task. Scheduled
 * runs are unattended full-auto and often need more steps than an interactive
 * turn (which uses the global setting), so tasks default to 50.
 */
export const DEFAULT_TASK_MAX_TOOL_ROUNDS = 50
