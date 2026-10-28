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
import type { ElementPickerFormat } from './types'
import type {
  Agent,
  AgentStatus,
  ConversationMeta,
  HistoryEntry,
  PageContext,
  PasswordEntry,
  Settings,
  Skill,
  UserProfile,
} from './types'
import type { FeishuConfig, ScheduledTask, TaskRunLog } from './scheduler-types'
import type { TokenDashboard, TokenRange } from './token-ledger'
import type { RunOutcomeKind, RunSource, RunStep, RunWindowKind } from '../background/running-tasks'
import type { Workflow, WorkflowMarketplaceRef } from './workflow/types'
import type { WorkflowGroup } from './workflow/groups'
import type { WorkflowDebugResult } from './workflow/auto-debug-patch'
import type { PendingTakeoverInfo } from './workflow/takeover-pending'
import type { DebugSessionStatsSummary, TakeoverStatsSummary } from './workflow/takeover-stats'
import type { ReplayFirstRunRecord } from './workflow/replay-metrics'
import type { WorkflowReview } from './workflow/review-patch'
import type { RepeatSuggestion } from './workflow/loop-collapse'
import type { SelectorProbeResult } from './workflow/selector-probe'
import type { AttachmentDescriptor, AttachmentSummary } from './attachments'
import type { UpdateState } from './update/types'

/** Aggregated token usage for one agent turn (summed across all tool rounds). */
export interface TurnTokenUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  totalTokens: number
}

/**
 * Why a workflow-generation turn has nothing to save.
 *
 * `no-actions` — the model never touched the page (it answered, or only read).
 * `all-failed` — it tried, and every attempt failed, so nothing was recorded.
 *
 * The distinction exists so the panel can say something useful instead of
 * showing nothing: only one of the two is worth suggesting a retry for.
 */
export type WorkflowDraftEmptyReason = 'no-actions' | 'all-failed' | 'validation-failed'
/** Extra context for the `validation-failed` empty reason (the issue list). */
export interface WorkflowDraftEmptyDetail {
  detail?: string
}

/**
 * Independent verification summary for a generated workflow (spec §5.5, §10.1).
 *
 * The draft card runs the shared repair engine's takeover-free verification
 * before it is offered, and reports the outcome here. A `verified` workflow is
 * one that executed successfully WITHOUT AI takeover and with the goal
 * achieved; anything else is still offered (saving is never blocked) but the
 * card shows why it is not yet independently proven.
 */
export interface GeneratedWorkflowRepairInfo {
  /** Whether the workflow ran successfully without AI takeover + goal achieved. */
  verified: boolean
  /** "VERIFIED" | "DRAFT" | "BLOCKED" outcome of the repair loop. */
  status: 'VERIFIED' | 'DRAFT' | 'BLOCKED'
  /** Symptom node (where execution failed), when known. */
  failedNodeId?: string
  /** Root-cause node(s) located by the deterministic analyzer. */
  rootCauseNodeIds: string[]
  /** Shared failure code (VerificationFailureType), when known. */
  failureType?: string
  /** Human-readable explanation of the diagnosis (redacted). */
  explanation: string
  /** How many repair rounds were attempted. */
  rounds: number
  /** Bounded transient retries performed before any patch (spec §6.3). */
  transientRetries?: number
  /**
   * True when verification succeeded only after a bounded transient retry —
   * telemetry bucket `TRANSIENT_RECOVERY`, distinct from first-pass success.
   */
  transientRecovery?: boolean
}

/** A running task as shown on the Tasks tab board. */
export interface RunningTaskView {
  runId: string
  taskId?: string
  workflowId?: string
  label: string
  source: RunSource
  startedAt: number
  steps: RunStep[]
  /** Browser window the run drives, once decided (see `running-tasks`). */
  windowId?: number
  /** Whether that window is shared with other runs or this run's own. */
  runWindowKind?: RunWindowKind
  /** Breakpoint step debugging: started from the editor's Testing mode. */
  testing?: boolean
  /** Breakpoint pause of a testing run; absent while it executes. */
  debug?: { paused: { nodeId: string; label: string; at: number } }
  /** Debug-mode per-block variable snapshots (the pause's Data view reads one). */
  snapshots?: { nodeId: string; label: string; at: number; variables: Record<string, unknown> }[]
}

/** A recently completed task as shown on the Tasks tab board. */
export interface FinishedTaskView {
  runId: string
  taskId?: string
  workflowId?: string
  label: string
  source: RunSource
  startedAt: number
  finishedAt: number
  outcome: RunOutcomeKind
  summary?: string
  steps: RunStep[]
  /** Browser window the run drove, kept so the badge survives settling. */
  windowId?: number
  runWindowKind?: RunWindowKind
}

/** Port name for the streaming agent channel. */
export const AGENT_PORT = 'agent'

/** Commands the side panel can issue. */
export type Command =
  | { type: 'settings.get' }
  | { type: 'settings.set'; patch: Partial<Settings> }
  /** Asks the background to re-check GitHub Releases; `force` skips the 5-min guard. */
  | { type: 'update.check'; force?: boolean }
  | { type: 'skills.list' }
  | { type: 'skills.save'; skill: Skill }
  | { type: 'skills.delete'; id: string }
  | { type: 'agents.list' }
  | { type: 'agents.save'; agent: Agent }
  | { type: 'agents.delete'; id: string }
  /** Restores a built-in agent to its shipped version (same id). */
  | { type: 'agents.reset'; id: string }
  | { type: 'provider.save'; profile: ProviderProfile }
  | { type: 'provider.delete'; id: string }
  /**
   * Makes `id` the active provider. `model` additionally switches that
   * profile's model in the same write — the chat composer's model picker
   * chooses both at once.
   */
  | { type: 'provider.activate'; id: string; model?: string }
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
  /**
   * Compress a stored conversation's context now, on request — the same
   * compaction the automatic threshold performs, just earlier. Refused while a
   * turn owns the conversation, because then the authoritative transcript is the
   * channel's in-memory copy, not the persisted one.
   */
  | { type: 'conversations.compact'; conversationId: string }

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
  /** Focus the browser window a run is driving (the board's window badge). */
  | { type: 'tasks.focusWindow'; runId: string }
  | { type: 'tasks.finished.delete'; runId: string }
  | { type: 'tasks.finished.clear' }

  // --- Feishu integration ---
  | { type: 'feishu.get' }
  | { type: 'feishu.save'; config: FeishuConfig }
  | { type: 'feishu.test' }

  // --- Workflows ---
  | { type: 'workflows.list' }
  | { type: 'workflows.get'; id: string }
  /**
   * Persist a workflow. `fromGeneration` marks a save from the chat
   * generation card: the background then hardens the graph against the live
   * page (verified selectors, persisted element waits) before writing it.
   * Editor/import saves skip that — hand-tuned selectors are never rewritten
   * behind the user's back.
   *
   * `verifyRun` is the card's opt-in checkbox: it alone decides whether the
   * saved workflow gets replayed for real right after the save. Hardening is a
   * read-only page probe and is NOT covered by it.
   */
  | {
      type: 'workflows.save'
      workflow: Workflow
      fromGeneration?: boolean
      verifyRun?: boolean
    }
  | { type: 'workflows.delete'; id: string }
  /**
   * Records the listing a workflow was published under.
   *
   * Publishing does not change the graph, so this is deliberately not a save:
   * the next publish reads the reference to update the same slug instead of
   * minting a new one, and the revision sequence must not show a fake edit.
   */
  | { type: 'workflows.marketplace'; id: string; marketplace: WorkflowMarketplaceRef }
  /**
   * Creates an independent copy of a stored workflow under a fresh id. The copy
   * keeps the graph, settings and trigger but starts with no revision history —
   * it is a new record, not another revision of the source.
   */
  | { type: 'workflows.duplicate'; id: string }
  /**
   * Files workflows into a group, or out of every group when `groupId` is null.
   * A move rewrites `folderId` only — it is not an edit, so it commits no
   * revision and does not reorder the list.
   */
  | { type: 'workflows.assignGroup'; ids: string[]; groupId: string | null }
  /** The workflow groups the user has created. */
  | { type: 'workflowGroups.list' }
  /** Creates a group (no `id`) or renames one (with `id`). */
  | { type: 'workflowGroups.save'; id?: string; name: string }
  /** Removes a group; its workflows fall back to the ungrouped section. */
  | { type: 'workflowGroups.delete'; id: string }
  /** Drag reorder: the group ids in their new top-to-bottom order. */
  | { type: 'workflowGroups.reorder'; ids: string[] }
  /**
   * Materialises the current conversation's operator-tool draft into a
   * Workflow WITHOUT persisting it. Used by the chat panel to populate the
   * review card at end of a workflow-generation turn. `error` is set when
   * there is no draft to compose.
   */
  | { type: 'workflows.draft.get'; conversationId: string }
  /**
   * Check every selector in the conversation's draft against the live page.
   *
   * Deliberately a separate command from `workflows.draft.get`: probing means
   * injecting a script into the page, which can be slow or fail outright on a
   * restricted URL. The save card must appear regardless, so the panel asks for
   * the card first and fills the probe results in when they arrive.
   */
  | { type: 'workflows.probe'; conversationId: string }
  /**
   * Fold one detected repeat run of the draft into a loop block. A `varying`
   * run is refused unless the page confirms a selector that matches exactly
   * the recorded elements — `folded: false` with a `reason` then reports that.
   */
  | {
      type: 'workflows.draft.fold'
      conversationId: string
      index: number
      /**
       * The folded run's node ids, from the suggestion the card rendered.
       * Preferred over `index`: the background re-detects runs on the CURRENT
       * draft, and an index computed against a stale list could target the
       * wrong run. When absent the index is used as before.
       */
      runIds?: string[]
    }
  /** Drops the operator-tool draft after the panel has saved or discarded it. */
  | { type: 'workflows.draft.clear'; conversationId: string }
  /**
   * AI node review of a conversation-generated workflow (before save): the
   * model judges which steps the replay genuinely needs. `review` is null
   * when no provider is configured or the call failed — the panel then keeps
   * every step and shows an availability hint.
   */
  | { type: 'workflows.review'; workflow: Workflow }
  | {
      type: 'workflows.run'
      id: string
      /** Run the graph starting at this node id ("run from here"). */ startAt?: string
      /**
       * Explicit target window (the editor popup's host window). Validated and
       * preferred over the sender-derived scope; the panel omits it and is
       * scoped by its own window instead.
       */
      windowId?: number
      /**
       * Breakpoint step debugging (Automa's testingMode): the run pauses before
       * every `$breakpoint` node and is driven with `debug.control`. Testing
       * runs are refused while one is already active.
       */
      testing?: boolean
    }
  /**
   * Answers a paused testing run. `stop` cancels the run; `resume` continues to
   * the next breakpoint; `next` pauses before the following node.
   */
  | {
      type: 'debug.control'
      runId: string
      action: 'resume' | 'next' | 'stop'
    }
  /**
   * AI takeover debug (AI 调试): run the workflow once; when a node fails, the
   * AI takes over THAT node — it sees the live page and completes the step's
   * purpose — then the remaining nodes keep running (retry up to 3 times).
   * Proposed node fixes come back as pending changes; nothing is applied to
   * the workflow until the user confirms. See
   * `background/workflow-engine/ai-takeover`.
   */
  | { type: 'workflows.debug'; id: string; /** See workflows.run.windowId. */ windowId?: number }
  /**
   * Unified repair (spec §10). The shared WorkflowRepairEngine runs a
   * takeover-free execution, diagnoses the failed vs root-cause nodes, and —
   * depending on `mode` — returns the analysis, a previewable patch, or an
   * applied + verified repair working copy (kept in the background pending the
   * user's commit; the formal workflow is never replaced automatically).
   */
  | {
      type: 'workflows.repair'
      id: string
      mode: 'ANALYZE' | 'SUGGEST' | 'AUTO_REPAIR'
      /** See workflows.run.windowId. */ windowId?: number
      /**
       * Set true when the user explicitly accepts a low-confidence proposal
       * (P2); absent ⇒ a low-confidence AUTO_REPAIR only returns the preview.
       */
      confirmed?: boolean
    }
  /** Commit (formally save) the verified repair working copy. */
  | { type: 'workflows.repairCommit'; id: string }
  /** Discard the repair working copy / pending patch. */
  | { type: 'workflows.repairDiscard'; id: string }
  /**
   * Per-node AI Fix: repair ONE operator node bounded by its own goal and
   * success criteria. Runs a bounded observe → execute → diagnose → verify
   * loop in the background; progress streams through `workflows.nodeFixEvent`
   * and the verified parameters come back for the user to apply manually. The
   * caller's node data is never mutated until the user applies the result.
   * A node without a stored contract is repaired from `userSuggestion` and/or
   * `errorLog`, judged by a criterion that exists only for that repair.
   */
  | {
      type: 'workflows.nodeFix'
      sessionId: string
      blockId: string
      blockData: Record<string, unknown>
      userSuggestion: string
      /** The failure output the user pasted (optional, prompt-only repairs). */
      errorLog?: string
      /** See workflows.run.windowId. */
      windowId?: number
    }
  /** Cancel an in-flight per-node AI fix (aborts execution and the LLM call). */
  | { type: 'workflows.nodeFixCancel'; sessionId: string }
  /**
   * Editor AI operator assistant: choose operator(s) for one utterance and fill
   * their parameters, against the canvas graph the editor already holds. One
   * model call in the background — it executes nothing and touches no workflow
   * draft, because the canvas is the source of truth and may carry unsaved
   * edits (specs/2026-10-19-editor-operator-ai-chat-design.md). The answer comes
   * back with an action — append a chain, or change the selected step in place —
   * for the editor to land (specs/2026-10-19-operator-ai-observe-and-edit-design.md
   * §4).
   */
  | {
      type: 'workflows.operatorAdvise'
      sessionId: string
      /** Conversation so far, oldest first; the newest user row is the ask. */
      messages: import('./workflow/operator-advise').OperatorAdviseMessage[]
      /** The current canvas as text, from `operatorDigestOf`. */
      graphDigest: string
      /** The selected step with its parameters, from `selectedOperatorSpecOf` —
       *  sent only when exactly one node is selected, and what lets the answer be
       *  an in-place `edit`/`replace` instead of an appended chain. */
      selectedSpec?: string
      /** See workflows.run.windowId — the page may only be read in that window. */
      windowId?: number
      /** The user's "don't read the page" override. Reading is on otherwise: a
       *  page read has no side effects, and it is what grounds the parameters. */
      skipPageRead?: boolean
      /** Locators the user picked by hand with the page picker for this turn.
       *  They outrank the page read: the user pointed at the element themselves. */
      pickedElements?: import('./workflow/operator-advise').PickedElement[]
      /** What the workflow is for — operator discovery's goal-alignment signal. */
      workflowGoal?: string
      /** Only used to attribute the token spend. */
      workflowId?: string
    }
  /** Cancel an in-flight assistant request (aborts the LLM call). */
  | { type: 'workflows.operatorAdviseCancel'; sessionId: string }
  /**
   * Editor AI operator assistant, the act-once half: perform the batch it just
   * picked ONCE against the page, so the node lands with the locator the site
   * really uses instead of the model's best guess. NO second model call — this is
   * the same resolve → probe → execute → re-locate sequence the generation bridge
   * runs on the record path, and it returns refined parameters plus what the page
   * reported (specs/2026-10-19-operator-ai-observe-and-edit-design.md §7).
   *
   * It touches the page, so it is never automatic: the editor asks the user first,
   * and the row says that acting is not undone by 撤销. Operators the assistant is
   * not allowed to run are skipped and named, not executed.
   */
  | {
      type: 'workflows.operatorObserve'
      sessionId: string
      /** The batch about to land, in chain order. */
      steps: import('./workflow/operator-advise').OperatorObserveStep[]
      /** See workflows.run.windowId — the assistant acts in that window only. */
      windowId?: number
      /** Only used to attribute the token spend of a block that calls a model. */
      workflowId?: string
    }
  /** Cancel an in-flight observation (aborts between steps; nothing lands). */
  | { type: 'workflows.operatorObserveCancel'; sessionId: string }
  /** Workflows with pending AI-takeover fixes awaiting user confirmation. */
  | { type: 'workflows.takeoverPending' }
  /** Aggregate AI-takeover success-rate stats (debug埋点). */
  | { type: 'workflows.takeoverStats' }
  /** Aggregate debug-SESSION stats: verified success rate + phase timing. */
  | { type: 'workflows.debugStats' }
  /**
   * Newest first-replay record per workflow — how the generated graph scored on
   * its first run at the revision it was generated at. Read-only evidence for
   * the workflow card; nothing about a run outcome gates anything.
   */
  | { type: 'workflows.firstRuns' }
  /** Applies the pending AI-takeover fixes to this workflow (user confirmed). */
  | {
      type: 'workflows.takeoverApply'
      id: string
      verify?: boolean
      /**
       * Set true when the user accepts a CRITICAL whole-graph rewrite after
       * seeing its risk level (P2, spec §8.4); absent ⇒ a CRITICAL rewrite is
       * refused and its risk is returned for confirmation.
       */
      confirmedRisk?: boolean
    }
  /** Discards the pending AI-takeover fixes for this workflow. */
  | { type: 'workflows.takeoverDiscard'; id: string }
  /**
   * Re-runs a workflow from its last clean checkpoint instead of its trigger
   * (M4 resume). `runId` identifies the earlier run whose checkpoints decide
   * where to pick up — for a non-idempotent flow (login / submit) re-driving
   * the finished prefix can only fail.
   */
  | {
      type: 'workflows.resume'
      id: string
      /** The earlier run to resume from. */
      runId: string
      /** See workflows.run.windowId. */
      windowId?: number
    }
  /**
   * Whether a workflow has a resumable point (M4): the panel only offers the
   * Resume action when the last run left a clean step to continue from.
   */
  | { type: 'workflows.resumePoint'; id: string }
  | { type: 'workflows.running'; workflowId?: string }

  // --- Workflow recovery protocol (spec §11 · Commit 10) ---
  /**
   * Single-entry recovery protocol. Carries an envelope with a unique request
   * id, the run/workflow and its revision, the phase, status, action and
   * timestamp. The action discriminates the operation:
   *
   *   - START             begin Diagnose → Proposal, then pause;
   *   - CONFIRM_REPAIR    apply + verify, then pause;
   *   - CONFIRM_OVERWRITE commit the verified working copy;
   *   - CANCEL            cancel before commit.
   *
   * A repeated START/confirm for the same request id is deduplicated by the
   * handler, and any response whose request/revision is stale is dropped by
   * the client guard.
   */
  | ({
      type: 'workflows.recovery'
      requestId: string
      runId: string
      workflowId: string
      workflowRevision?: number
      timestamp: number
    } & (
      | { action: 'START' }
      | { action: 'CONFIRM_REPAIR' }
      | { action: 'CONFIRM_OVERWRITE' }
      | { action: 'CANCEL' }
    ))

  // --- Autonomous repair (spec §12–§24 · Commit 7-14) ---
  /**
   * Start the autonomous repair orchestrator for a failed run (for
   * generated-strict workflows this may also be fired automatically by the
   * run path). The orchestrator runs diagnose → strategy → candidate → apply
   * → resume → verify, advancing strategies without asking until it either
   * commits a verified revision or hits a genuine blocker. Progress is
   * streamed through `workflows.repairEvent` messages.
   */
  | {
      type: 'workflows.autoRepair'
      id: string
      runId: string
      /** See workflows.run.windowId. */ windowId?: number
    }
  /** Cancel an in-flight autonomous repair (before it commits). */
  | { type: 'workflows.autoRepairCancel'; id: string }
  /** The current autonomous repair session snapshot (for late subscribers). */
  | { type: 'workflows.autoRepairStatus'; id: string }

  // --- Workflow recording (see background/record-controller.ts) ---
  /**
   * Start recording: injects the recorder into all http tabs (of `windowId`
   * when given — the editor's host window), sets the rec badge.
   */
  | { type: 'record.start'; windowId?: number }
  /** Stop recording and convert the captured blocks into a workflow. */
  | {
      type: 'record.stop'
      windowId?: number
      /**
       * Persist the recorded workflow under its own id (default true). The
       * editor sets false to append the steps to the workflow it already has.
       */
      save?: boolean
    }
  /** Whether a recording session is currently active. */
  | { type: 'record.status' }

  // --- Local agent bridge (see background/agent-client.ts) ---
  /** Current outbound WebSocket connection status to the local agent. */
  | { type: 'agent.status.get' }
  /**
   * Minimize this window's side panel into a floating page button. The
   * sender panel reports its own window (a window-level UI resolves it via
   * `chrome.windows.getCurrent()`); the worker validates it, marks the
   * window minimized (unattended runs stay scoped to it) and broadcasts the
   * floating button to its pages. The panel closes itself after the ack.
   */
  | { type: 'panel.minimize'; windowId: number }

  // --- Local-agent multi-window assignment ---
  /** Lists normal windows with their plugin state for the assignment UI. */
  | { type: 'agent.windows.list' }
  /**
   * Assigns a connected agent (by stable `agentName`) to a window, or removes
   * its assignment (`windowId: null`). The worker performs an atomic
   * read-modify-write of the whole bindings map so two panels assigning
   * concurrently cannot lose each other's entry.
   */
  | { type: 'agent.bindings.set'; agentId?: string; agentName: string; windowId: number | null }

  // --- Token usage dashboard ---
  /**
   * One dashboard read for a statistical window. Computed in the worker because
   * the ledger lives there (files or `storage.local`), and the panel must not
   * receive every raw record to add up a total.
   */
  | { type: 'tokens.stats'; range: TokenRange }
  /** Empties the ledger: both the capped detail records and the day rollup. */
  | { type: 'tokens.clear' }

/** Replies, discriminated by the command that produced them. */
export type CommandResult =
  | { type: 'settings'; settings: Settings }
  | { type: 'update.state'; state: UpdateState }
  | { type: 'skills.list'; skills: Skill[] }
  | { type: 'skills.save'; skill: Skill }
  | { type: 'skills.delete' }
  | { type: 'agents.list'; agents: Agent[] }
  | { type: 'agents.save'; agent: Agent }
  | { type: 'agents.delete' }
  | { type: 'agents.reset'; agent: Agent }
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
        /** Skill slash-picked for the turn, shown as its `/name` tag. */
        skillName?: string
      }[]
    }
  | { type: 'conversations.rename' }
  | { type: 'conversations.delete' }
  | {
      type: 'conversations.compact'
      outcome: 'compacted' | 'nothing' | 'busy'
      /** Messages replaced by the summary; only meaningful when compacted. */
      removed: number
    }
  | { type: 'tasks.list'; tasks: ScheduledTask[] }
  | { type: 'tasks.save' }
  | { type: 'tasks.delete' }
  | {
      type: 'tasks.run'
      outcome: { ok: boolean; skipped: boolean; summary: string; error?: string }
    }
  | { type: 'tasks.runs'; runs: TaskRunLog[] }
  | { type: 'tasks.runs.clear' }
  | { type: 'tasks.runs.delete' }
  | { type: 'tasks.running'; runs: RunningTaskView[]; finished: FinishedTaskView[] }
  | { type: 'tasks.cancel'; ok: boolean }
  /** Focus failed because the run's window closed in the meantime. */
  | { type: 'tasks.focusWindow'; ok: boolean; closed?: boolean }
  | { type: 'tasks.finished.delete' }
  | { type: 'tasks.finished.clear' }
  | { type: 'feishu.get'; config: FeishuConfig }
  | { type: 'feishu.save' }
  | { type: 'feishu.test'; ok: boolean; message?: string }

  // --- Panel minimize (floating page button) ---
  | { type: 'panel.minimize' }

  // --- Workflows ---
  | { type: 'workflows.list'; workflows: Workflow[] }
  | { type: 'workflows.get'; workflow?: Workflow }
  | { type: 'workflows.save' }
  | { type: 'workflows.delete' }
  | { type: 'workflows.marketplace' }
  | { type: 'workflows.duplicate'; workflow?: Workflow }
  | { type: 'workflows.assignGroup' }
  | { type: 'workflowGroups.list'; groups: WorkflowGroup[] }
  | { type: 'workflowGroups.save'; group: WorkflowGroup }
  | { type: 'workflowGroups.delete' }
  | { type: 'workflowGroups.reorder'; groups: WorkflowGroup[] }
  | {
      type: 'workflows.draft'
      workflow?: Workflow
      error?: string
      /**
       * Where `workflow` came from: `draft` when the model placed operator
       * blocks itself, `history` when it was compiled from the actions the
       * model performed. The card shows the difference because the history
       * path can contain exploratory steps worth dropping.
       */
      source?: 'draft' | 'history'
      /**
       * Set when there is nothing to save, and says WHY. Distinct from
       * `error`: an empty result is a normal outcome of a turn that only read
       * the page, and the panel shows a one-line explanation rather than
       * silence — a silent card is indistinguishable from a broken feature.
       */
      empty?: WorkflowDraftEmptyReason
      detail?: string
      /** Repeat runs worth folding, for the review card. */
      suggestions?: RepeatSuggestion[]
      /**
       * Independent verification + repair summary for the generated workflow
       * (spec §10.1). Populated when the background ran the shared repair
       * engine's takeover-free verification before offering the card.
       */
      repair?: GeneratedWorkflowRepairInfo
      /**
       * Every selector in the graph checked against the live page. `null` means
       * the page could not be probed — "not verified", not "all fine".
       */
      probes?: SelectorProbeResult[] | null
    }
  | {
      type: 'workflows.probe'
      /**
       * Selector verdicts for the conversation's draft. `null` means the page
       * could not be probed at all — "not verified", not "all fine".
       */
      probes: SelectorProbeResult[] | null
    }
  | {
      type: 'workflows.draft.fold'
      workflow?: Workflow
      folded: boolean
      /** Why nothing was folded, when `folded` is false. */
      reason?: string
      /** Set when the draft could not even be materialised. */
      error?: string
      suggestions?: RepeatSuggestion[]
    }
  | { type: 'workflows.draft.clear' }
  | {
      type: 'workflows.review'
      review: WorkflowReview | null
      /** Why the review is unavailable (timeout / endpoint / unusable reply). */
      error?: string
    }
  | {
      type: 'workflows.run'
      outcome: { ok: boolean; skipped: boolean; summary: string; error?: string; runId?: string }
    }
  | { type: 'debug.control'; ok: boolean; error?: string }
  | { type: 'workflows.debug'; result: WorkflowDebugResult }
  | {
      type: 'workflows.repair'
      data: import('./workflow/repair/repair-response').RepairResponseData
    }
  | { type: 'workflows.repairCommit' }
  | { type: 'workflows.repairDiscard' }
  | {
      type: 'workflows.nodeFix'
      data: import('./workflow/node-fix').NodeFixResultData
    }
  | { type: 'workflows.nodeFixCancel' }
  | {
      type: 'workflows.operatorAdvise'
      data: import('./workflow/operator-advise').OperatorAdviseResult
    }
  | { type: 'workflows.operatorAdviseCancel' }
  | {
      type: 'workflows.operatorObserve'
      data: import('./workflow/operator-advise').OperatorObserveResult
    }
  | { type: 'workflows.operatorObserveCancel' }
  | {
      type: 'workflows.recovery'
      /** Mirrors the request id; a client drops it when it no longer matches. */
      requestId: string
      workflowRevision?: number
      phase: import('./workflow/recovery-protocol').RecoveryPhaseState
      status: import('./workflow/recovery-protocol').RecoveryProtocolStatus
      summary: string
      timestamp: number
      /**
       * Patch operations carried with the AWAIT_REPAIR_CONFIRM proposal so the
       * client can render the per-node before/after and risk. Absent on other
       * phases; the formal workflow is never modified from these.
       */
      operations?: import('./workflow/repair/types').WorkflowPatchOperation[]
    }
  /** One autonomous-repair progress event (streamed while the repair runs). */
  | {
      type: 'workflows.repairEvent'
      event: import('./workflow/repair-events').RepairProgressEvent
    }
  /** The autonomous repair settled; carries the final status. */
  | {
      type: 'workflows.autoRepairResult'
      status: 'success' | 'exhausted' | 'blocked'
      reason?: string
      revision?: number
      attempts: number
      durationMs: number
      committed: boolean
    }
  | { type: 'workflows.takeoverPending'; items: PendingTakeoverInfo[] }
  | { type: 'workflows.takeoverStats'; summary: TakeoverStatsSummary }
  | { type: 'workflows.debugStats'; summary: DebugSessionStatsSummary }
  | { type: 'workflows.firstRuns'; records: ReplayFirstRunRecord[] }
  | {
      type: 'workflows.resume'
      outcome: {
        ok: boolean
        summary: string
        error?: string
        runId?: string
        /** Step index the run resumed from; absent when it started fresh. */
        resumedFrom?: number
      }
    }
  | {
      type: 'workflows.resumePoint'
      resumable: boolean
      /** The run whose checkpoints hold the point. */
      runId?: string
      /** 0-based step the run would resume from. */
      fromStepIndex?: number
    }
  | {
      type: 'workflows.takeoverApply'
      workflow: Workflow
      appliedCount: number
      /** Set when the apply requested a takeover-free verification re-run. */
      verified?: boolean
      /** Run summary from the verification re-run (first error when it failed). */
      verifySummary?: string
      /**
       * Risk level of a whole-graph rewrite (P2, spec §8.4). When a CRITICAL
       * rewrite was not confirmed, the apply is refused and this (with the
       * reasons) tells the panel to ask the user.
       */
      rewriteRisk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
      rewriteRiskReasons?: string[]
      /** True when the rewrite awaits explicit confirmation — nothing written. */
      riskConfirmationNeeded?: boolean
    }
  | { type: 'workflows.takeoverDiscard' }
  | { type: 'workflows.running'; runs: RunningTaskView[]; finished: FinishedTaskView[] }
  | { type: 'record.start'; recording: boolean }
  | {
      type: 'record.stop'
      workflowId?: string
      /** The converted graph, so the editor can append it without reloading. */
      workflow?: Workflow
    }
  | { type: 'record.status'; recording: boolean }

  // --- Local agent bridge ---
  | { type: 'agent.status'; status: AgentStatus }
  | { type: 'agent.windows'; windows: WindowChoice[] }

  // --- Token usage dashboard ---
  | { type: 'tokens.stats'; stats: TokenDashboard }
  | { type: 'tokens.clear' }

/** Envelope so a failed command never looks like a successful one. */
export type CommandResponse = { ok: true; data: CommandResult } | { ok: false; error: string }

/**
 * One-way push messages the service worker broadcasts to every extension page.
 *
 * Skills can change from a context that is not a panel command — the agent's
 * `create_skill` tool inside a chat turn — so the panel cannot rely on command
 * replies to notice. Pages listen for `skills.changed` and re-read the list.
 * The same applies to agents (`agents.changed`).
 */
export type WorkerBroadcast = { type: 'skills.changed' } | { type: 'agents.changed' }

/**
 * Fire-and-forget broadcast that the skill store changed.
 *
 * Never throws: a page that is closed (or not yet listening) makes the runtime
 * reject the send, and a failed notification is harmless — the list refreshes
 * the next time the panel reopens anyway.
 */
export function notifySkillsChanged(): void {
  void chrome.runtime
    .sendMessage({ type: 'skills.changed' } satisfies WorkerBroadcast)
    .catch(() => {})
}

/** Fire-and-forget broadcast that the agent store changed; never throws. */
export function notifyAgentsChanged(): void {
  void chrome.runtime
    .sendMessage({ type: 'agents.changed' } satisfies WorkerBroadcast)
    .catch(() => {})
}

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
      /**
       * Workflow name the user confirmed BEFORE the task started (workflow
       * generation mode only). The worker persists it so `prepare_workflow_goal`
       * adopts it as the authoritative contract name instead of deriving one.
       */
      workflowName?: string
    }
  | { type: 'confirm'; requestId: string; approved: boolean }
  /**
   * Answer to a `plan.request`: the user either approved the submitted plan or
   * rejected it with free-text feedback for the revision loop. Keyed by
   * `requestId` like `confirm` so concurrent cards resolve independently.
   */
  | { type: 'plan.decision'; requestId: string; approved: boolean; feedback?: string }
  /**
   * Answer to an `ask_user.request`: the user either typed/picked an answer
   * (`cancelled: false`) or dismissed the question (`cancelled: true`, empty
   * `answer`). Keyed by `requestId` like `confirm` so concurrent questions
   * resolve independently.
   */
  | { type: 'ask_user.answer'; requestId: string; answer: string; cancelled: boolean }
  /**
   * Stop the running turn. Scoped to one conversation: a panel may be watching
   * turns from several conversations (it takes over a stream on `resume`) and
   * Stop only ever refers to the conversation on screen.
   */
  | { type: 'cancel'; conversationId: string }
  /**
   * A supplementary instruction typed while this conversation's turn is still
   * running. It is queued on the live turn and injected into its transcript at
   * the next round boundary, so the SAME task adjusts its remaining work — a
   * workflow-generation draft keeps being built towards it, instead of the user
   * having to Stop and re-send. `text` is the user's words verbatim: no envelope,
   * because user turns are the transcript's spine.
   *
   * `noteId` is generated by the panel and is what the turn's
   * `chat.interjection.applied` echo refers to: a note the turn never applied
   * (the user pressed Stop, or the turn failed) stays visibly unacknowledged on
   * the panel, which then re-sends it instead of losing what the user typed.
   */
  | { type: 'chat.interject'; conversationId: string; text: string; noteId: string }
  | { type: 'reset'; conversationId: string }
  /**
   * Sent right after connecting: asks the worker for the stored transcript and
   * whether a turn is still running, so a reopened panel restores itself instead
   * of appearing empty.
   */
  | { type: 'resume'; conversationId: string }
  /**
   * Sent immediately after connecting: the window that hosts this panel. The
   * side panel is a window-level UI, not a tab, so `port.sender.tab` is
   * unreliable for it — the panel resolves its own window with
   * `chrome.windows.getCurrent()` and states it explicitly. The worker uses
   * this both for the automatic-trigger guard and to scope every chat turn of
   * this panel to its window.
   */
  | { type: 'panel.hello'; windowId: number }
  /**
   * Idle-timer heartbeat. An MV3 worker is evicted after ~30s without activity,
   * which would drop the port mid-turn; an inbound message resets that timer.
   */
  | { type: 'ping' }

/** Messages the service worker pushes back over the agent port. */
export type AgentServerMessage =
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool.start'; name: string; summary?: string }
  | { type: 'tool.result'; name: string; summary: string }
  | {
      type: 'confirm.request'
      requestId: string
      name: string
      /** Pretty-printed arguments for the user to inspect before approving. */
      argsPreview: string
    }
  /**
   * The agent is asking the user a clarifying question (`ask_user` tool). The
   * panel renders the question with the candidate approaches (the FIRST one is
   * the recommendation and is pre-selected) plus a free-text answer; the reply
   * travels back as {@link AgentClientMessage}'s `ask_user.answer`. Same
   * request/response shape as `confirm.request` — a pending question that
   * nobody can answer (cancel, panel closed) resolves cancelled instead of
   * hanging the turn.
   */
  | {
      type: 'ask_user.request'
      requestId: string
      question: string
      /** 3-6 candidate approaches with pros/cons; index 0 is the recommendation. */
      options: Array<{ label: string; pros: string; cons: string }>
    }
  /**
   * The agent submitted an execution plan (`present_plan` tool, active when the
   * plan skill is loaded). The panel renders the goal, the numbered steps and
   * the optional risk/split notes as an approval card; the reply travels back
   * as {@link AgentClientMessage}'s `plan.decision`. Same lifecycle as
   * `ask_user.request` — a pending card nobody answers (cancel, panel closed)
   * resolves rejected instead of hanging the turn.
   */
  | {
      type: 'plan.request'
      requestId: string
      /** One-line task goal the plan was derived from. */
      goal: string
      /** Ordered plan steps rendered as a numbered list. */
      steps: { title: string; detail?: string }[]
      /** Optional risk notes (login, CAPTCHA, irreversible steps). */
      risks?: string
      /** Optional split/composition note (workflow mode, multi-workflow plans). */
      split?: string
    }
  | { type: 'status'; text: string }
  /**
   * Cumulative token usage of the running turn, pushed after every LLM
   * request completes (each tool-calling round reports its own trailing
   * usage chunk). The value is the turn total so far — not the single
   * round's — so the panel can add the delta against the last value it
   * applied and the token bar tracks each request live instead of only
   * updating when the whole turn is done.
   */
  | { type: 'usage'; usage: TurnTokenUsage }
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
  /**
   * Answer to `chat.interject`, carrying the `noteId` of the note it answers: the
   * panel can have several supplements in flight, and the port is shared.
   * `queued: true` means the live turn took the instruction and will apply it at
   * its next round boundary. `queued: false` means the turn had already finished —
   * the panel must then send the same text as an ordinary message so nothing the
   * user typed is lost.
   */
  | { type: 'chat.interject.ack'; conversationId: string; noteId: string; queued: boolean }
  /**
   * The turn put these supplements into its transcript as user turns, before
   * building its next request. `noteId`s the turn never announced stay flagged on
   * the panel side, so an unapplied note ends up re-sent instead of dropped —
   * pressing Stop, or a turn failing, lands here.
   */
  | { type: 'chat.interjection.applied'; conversationId: string; noteIds: string[] }
  /**
   * Every card this turn was waiting on the user to answer is now dead: the turn
   * was stopped, failed or ended, and the worker has already resolved those
   * requests negatively. Without this the panel keeps rendering a card whose
   * answer goes nowhere — the task then waits on a promise nobody can settle.
   */
  | { type: 'interactions.dismissed'; conversationId: string }
  | { type: 'pong' }
  /**
   * One live review-log line, pushed over the agent port WHILE the workflow
   * review streams (model picked, verdicts arriving, …). The reviewing panel
   * subscribes via {@link onReviewLog} and renders the lines as they come.
   */
  | { type: 'workflows.reviewLog'; text: string }
  /** One per-node AI-fix progress event (streamed while the fix runs). */
  | {
      type: 'workflows.nodeFixEvent'
      event: import('./workflow/node-fix').NodeFixEvent
    }
  /**
   * The operator assistant's own model output, streamed while it answers:
   * `reasoning` is chain-of-thought, `text` the answer. The editor shows it live
   * and keeps the final text behind a disclosure.
   */
  | {
      type: 'workflows.operatorAdviseEvent'
      /** The request these deltas belong to; the dock filters on it. */
      sessionId: string
      channel: 'text' | 'reasoning'
      delta: string
    }
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
        /** Skill slash-picked for the turn, shown as its `/name` tag. */
        skillName?: string
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

// --- Live review log fan-out (panel side) -------------------------------------

/**
 * Subscriber for live AI review-log lines pushed over the agent port.
 * The port lives in the always-mounted chat component, so it forwards the
 * lines here and any open review dialog (chat card OR history tab) picks
 * them up through {@link onReviewLog}.
 */
type ReviewLogListener = (text: string) => void

const reviewLogListeners = new Set<ReviewLogListener>()

/** Forward one live review-log line to every subscribed dialog. */
export function emitReviewLog(text: string): void {
  for (const listener of reviewLogListeners) listener(text)
}

/** Subscribe to live review-log lines; returns an unsubscribe function. */
export function onReviewLog(listener: ReviewLogListener): () => void {
  reviewLogListeners.add(listener)
  return () => {
    reviewLogListeners.delete(listener)
  }
}

// --- Floating button (minimized plugin) ---------------------------------------

/**
 * Saved position of the floating button, as the button CENTER in percent of
 * the viewport (0–100 on both axes). Percentages survive navigation between
 * pages of different sizes and window resizes far better than raw pixels.
 */
export interface FloatingButtonPos {
  x: number
  y: number
}

/**
 * Messages from the floating-button content script to the service worker.
 * Not part of {@link Command}: the sender is a content script, not the panel,
 * and `floating.expand` must reach `sidePanel.open` inside the click gesture.
 */
export type FloatingButtonMessage =
  | { type: 'floating.status' }
  | { type: 'floating.expand' }
  /** The user dropped the button after dragging it; `x`/`y` are percentages. */
  | { type: 'floating.move'; x: number; y: number }

/** Worker → floating-button content script control messages. */
export type FloatingButtonControl =
  { type: 'floating.show'; pos?: FloatingButtonPos } | { type: 'floating.hide' }

/** Reply to `floating.status`. */
export interface FloatingStatusResponse {
  minimized: boolean
  /** Last saved drag position for this window, when one exists. */
  pos?: FloatingButtonPos
}

// --- On-page element picker launcher -----------------------------------------

/** Messages from the launcher content script to the service worker. */
export type ElementPickerLauncherMessage = { type: 'elementPicker.status' }

/** Worker → launcher content script: toggle state, copy locale and payload. */
export type ElementPickerControl = {
  type: 'elementPicker.set'
  enabled: boolean
  locale: 'en' | 'zh'
  format: ElementPickerFormat
  /** Pick without the card: the first click confirms the element. */
  hideCard: boolean
}

/** Reply to `elementPicker.status`. */
export interface ElementPickerStatusResponse {
  enabled: boolean
  locale: 'en' | 'zh'
  format: ElementPickerFormat
  hideCard: boolean
}

/**
 * One element the user confirmed in copy mode, reported to the worker so the
 * local agent can read and act on it (`read_selected_element`). Payload fields
 * are capped in the picker AND re-capped by the worker's store.
 */
export interface PickedElement {
  /** CSS selector the picker resolved to exactly this element. */
  selector: string
  tag: string
  id?: string
  classes?: string[]
  /** Visible text, capped. */
  text: string
  /** `outerHTML`, capped; `htmlTruncated` marks a cut. */
  html: string
  htmlTruncated?: boolean
  /** Page the element was picked on; a different current URL means stale. */
  url: string
  title: string
  pickedAt: number
}

// --- Multi-window picker (unattended window policy = "ask") --------------------

/** One selectable browser window in the multi-window picker. */
export interface WindowChoice {
  windowId: number
  /** Title of the window's active tab. */
  title: string
  /** Host of the active tab's URL, when available. */
  host?: string
  /** The window currently hosts a connected side panel. */
  isPanel: boolean
  /** The window's plugin is minimized (floating page button). */
  isMinimized: boolean
}

/**
 * Worker → every connected panel: the user must pick which plugin window an
 * unattended run (agent bridge / scheduled / Feishu) should act in. The first
 * `window.pick.response` wins; the worker times out and falls back.
 */
export type WindowPickRequest = {
  type: 'window.pick.request'
  requestId: string
  windows: WindowChoice[]
}

/** Panel → worker answer for a `window.pick.request`; `null` = cancelled. */
export type WindowPickResponse = {
  type: 'window.pick.response'
  requestId: string
  windowId: number | null
}
