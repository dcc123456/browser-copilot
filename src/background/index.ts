/**
 * Service worker entry point.
 *
 * Every listener is registered synchronously at the top level: MV3 dispatches
 * events to a freshly started worker, and a listener attached inside an async
 * callback would miss the event that woke it.
 *
 * @module background/index
 */

import type { WireMessage } from '../lib/llm'
import { LlmError, listModels, testConnection } from '../lib/llm'
import type { AttachmentDescriptor } from '../lib/attachments'
import { rejectionMessage, sanitizeAttachments, toAttachmentSummaries } from '../lib/attachments'
import { getUserDisplayText, toRestoreMessages } from './restore'
import { retain, release } from './keepalive'
import {
  AGENT_PORT,
  type AgentClientMessage,
  type AgentServerMessage,
  type Command,
  type CommandResponse,
  type CommandResult,
  type WindowPickRequest,
  notifyAgentsChanged,
  notifySkillsChanged,
} from '../lib/messages'
import {
  forgetAgentWindow,
  handleWindowPickResponse,
  rememberAgentWindow,
  setWindowPickRequester,
} from './window-policy'
import { isInjectablePage } from '../lib/pages'
import {
  hasPluginWindows,
  initScopeWindowCleanup,
  isPluginWindow,
  currentPluginScope,
  latestPluginWindowId,
  listNormalWindows,
  normalScopeFromWindowId,
  registerPanelWindow,
  broadcastPanels,
  shouldTriggerVisitWeb,
  unregisterPort,
} from './automation-scope'
import {
  expandWindow,
  getFloatingButtonPos,
  initPanelMinimize,
  isMinimized,
  minimizeWindow,
  setFloatingButtonPos,
  whenRestoreSettled,
} from './panel-minimize'
import { warmupOcr } from './driver'
import { handlePickerMessage } from './picker-bridge'
import {
  startRecording,
  stopRecording,
  isRecording,
  handleRecordEvent,
  initRecordingLifecycle,
} from './record-controller'
import {
  startupWorkflows,
  initShortcutTriggers,
  handleShortcutPressed,
  initElementChangeTriggers,
  handleElementChange,
  setWorkflowRunner,
  rescheduleAllWorkflowTriggers,
  isWorkflowTriggerAlarm,
  handleWorkflowTriggerAlarm,
} from './workflow-triggers'
import { validateProfile } from '../lib/providers'
import { normalizeSkill, validateSkill, wrapSkillDirective } from '../lib/skills'
import { normalizeAgent, validateAgent } from '../lib/agents'
import {
  clearConversation,
  clearHistory,
  deleteAgent,
  deleteConversation,
  deleteHistory,
  deletePassword,
  deleteProfile,
  deleteProvider,
  deleteSkill,
  ensureSchema,
  resetAgentToBuiltIn,
  getTurnState,
  listAgents,
  listConversations,
  listHistory,
  listPasswords,
  listProfiles,
  listSkills,
  loadConversation,
  renameConversation,
  saveAgent,
  saveConversation,
  savePassword,
  saveProfile,
  saveProvider,
  saveSkill,
  setTurnState,
  getSettings,
  setSettings,
  getSkill,
  touchConversation,
} from '../lib/storage'
import { runAgentTurn } from './agent'
import {
  clearDraft,
  composeWorkflowFromDraft,
  draftRepeatRuns,
  foldDraftRun,
} from './operator-tool-handler'
import { createCollapseProbe } from './collapse-probe'
import { forgetGenerationSecrets } from './operator-tool-run'
import { resolveWorkflowForSave } from './history-compile'
import { probeWorkflowSelectors, hardenWorkflowSelectors } from './selector-probe'
import { persistDefaultWaits } from '../lib/workflow/runnability'
import { validateWorkflowForRun } from '../lib/workflow/validation'
import { activeTab, readActivePage, readActiveSelection } from './page'
import {
  clearRuns,
  deleteRun,
  deleteTask,
  getFeishuConfig,
  listRuns,
  listTasks,
  recordFinishedRun,
  saveFeishuConfig,
  saveTask,
} from '../lib/task-store'
import { listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow } from '../lib/workflow/storage'
import {
  describeNodeParams,
  patchNodeParams,
  type WorkflowDebugResult,
} from '../lib/workflow/auto-debug-patch'
import type { Workflow } from '../lib/workflow/types'
import {
  clearPendingTakeover,
  getPendingTakeover,
  listPendingTakeovers,
  savePendingTakeover,
} from '../lib/workflow/takeover-pending'
import {
  debugRunLabel,
  takeoverAutoRunBudget,
  takeoverMaxAttempts,
  takeoverProviderOf,
  type TakeoverReasonKind,
} from '../lib/workflow/ai-takeover'
import { executeWorkflow, findRunIdFor, getCheckpointStore } from './workflow-engine/run-workflow'
import { readPersistedCheckpoints } from './checkpoint-store'
import { resumePointOf, workflowFingerprintOf } from '../lib/workflow/checkpoints'
import { createAiTakeover } from './workflow-engine/ai-takeover'
import { runDebugSession, DEFAULT_MAX_ROUNDS } from './workflow-engine/debug-session'
import { runUnifiedDebug } from './workflow-engine/repair/unified-debug'
import type {
  RecoveryPhaseState,
  RecoveryProtocolStatus,
} from '../lib/workflow/recovery-protocol'
import {
  commitWorkflowRevision,
  currentRevisionOf,
  revisionMatchesBase,
} from '../lib/workflow/workflow-revision'
import { finalizeGeneratedWorkflow } from './workflow-engine/repair/generation-repair'
import { DEFAULT_REPAIR_POLICY } from '../lib/workflow/repair/types'
import { recordRepairRound } from '../lib/workflow/repair-metrics'
import { createBackgroundRunner } from './workflow-engine/repair/background-runner'
import { createAiRepairProposer } from './workflow-engine/repair/repair-provider'
import { toRepairResponse } from '../lib/workflow/repair/repair-response'
import {
  discardRepairSession,
  getRepairSession,
  putRepairSession,
  takeRepairSession,
} from './workflow-engine/repair/repair-session-store'
import { runUnattendedPrompt } from './agent-unattended'
import { streamCompletion } from '../lib/llm'
import { stripThinkBlocks } from '../lib/model-output'
import {
  buildAuditPrompt,
  buildGoalCheckPrompt,
  buildReplayPrompt,
  buildRewrittenWorkflow,
  parseGoalVerdict,
  parseWorkflowAudit,
} from '../lib/workflow/debug-rewrite'
import { classifyRewriteRisk } from '../lib/workflow/rewrite-risk'
import {
  recordDebugSession,
  recordTakeoverStat,
  summarizeDebugSessions,
  summarizeTakeoverStats,
  type DebugPhase,
} from '../lib/workflow/takeover-stats'
import { BLOCK_BY_ID } from '../lib/workflow/blocks/palette'
import { reviewWorkflow } from './workflow-engine/workflow-review'
import { initLastTabTracker } from './last-tab'
import { rescheduleAll, scheduleTask, triggerNow, onAlarm } from './scheduler'
import { FeishuBot, FEISHU_WATCHDOG_ALARM } from './feishu-bot'
import { isWebhookUrl, sendWebhookText } from '../lib/feishu'
import { agentClient } from './agent-client'
import {
  addStep,
  cancelRun,
  clearFinished,
  finishRun,
  forgetFinished,
  hydrateFinished,
  listFinished,
  listRunning,
  setFinishedPersister,
  startRun,
  type FinishedTask,
  type RunStepKind,
} from './running-tasks'

/** Whitelist used to narrow the engine's free-form step kinds for addStep. */
const RUN_STEP_KINDS: readonly RunStepKind[] = ['tool', 'status', 'result', 'error', 'info']

/**
 * One-shot budget for the debug graph audit (复演后的图审计). The model must
 * reason over the whole graph AND generate a corrected one, so this runs
 * longer than an ordinary completion; a timed-out audit degrades to "audit
 * unavailable" instead of blocking the session.
 */
const AUDIT_TIMEOUT_MS = 8 * 60_000

/**
 * One-shot budget for the goal-completion judge (目标达成判定). A single
 * judgement over run evidence — bounded, and an unavailable judge just means
 * the session falls back to the old no-error standard.
 */
const GOAL_CHECK_TIMEOUT_MS = 3 * 60_000

// Persist every finished run (with its steps) so the run log survives a worker
// eviction/restart. finishRun calls this synchronously; recordFinishedRun is
// async but fire-and-forget here.
setFinishedPersister((run: FinishedTask) => {
  void recordFinishedRun({
    runId: run.runId,
    taskId: run.taskId,
    // Persisted so the run stays attributable after a rename (see TaskRunLog).
    workflowId: run.workflowId,
    label: run.label,
    source: run.source,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    outcome: run.outcome,
    summary: run.summary,
    ...(run.error ? { error: run.error } : {}),
    steps: run.steps,
  }).catch((error: unknown) => {
    console.error('[Browser Copilot] could not persist finished run', error)
  })
})

// Seed the in-memory "recently finished" board from persisted logs so runs that
// completed before a worker restart still show up (with their steps).
void listRuns()
  .then((runs) => {
    hydrateFinished(
      runs
        .filter((r) => r.outcome && r.finishedAt)
        .slice(0, 30)
        .map((r) => ({
          runId: r.id,
          ...(r.taskId ? { taskId: r.taskId } : {}),
          ...(r.workflowId ? { workflowId: r.workflowId } : {}),
          label: r.label ?? r.summary?.slice(0, 40) ?? '',
          source:
            r.source ??
            (r.trigger === 'feishu' ? 'feishu' : r.trigger === 'manual' ? 'manual' : 'schedule'),
          startedAt: r.startedAt ?? r.finishedAt!,
          finishedAt: r.finishedAt!,
          outcome: r.outcome!,
          ...(r.summary ? { summary: r.summary } : {}),
          steps: r.steps ?? [],
        })),
    )
  })
  .catch(() => {})

// --- Lifecycle ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void ensureSchema()
  // Pre-compile the OCR WASM + language model in the offscreen document so the
  // first captcha read doesn't pay a multi-second cold start. Best effort.
  void getSettings()
    .then((s) => warmupOcr(s.ocrLanguage))
    .catch(() => {})
  void rescheduleAll().catch((error: unknown) =>
    console.error('[Browser Copilot] could not reschedule tasks', error),
  )
  void rescheduleAllWorkflowTriggers().catch((error: unknown) =>
    console.error('[Browser Copilot] could not reschedule workflow triggers', error),
  )
  if (chrome.contextMenus) {
    void registerContextMenuWorkflows().catch((error: unknown) =>
      console.error('[Browser Copilot] could not register context-menu workflows', error),
    )
  }
})

// A worker update/startup must also reconcile alarms: chrome.alarms persist across
// restarts, but code may have changed and a stale enabled flag needs correcting.
chrome.runtime.onStartup.addListener(() => {
  void getSettings()
    .then((s) => warmupOcr(s.ocrLanguage))
    .catch(() => {})
  void rescheduleAll().catch((error: unknown) =>
    console.error('[Browser Copilot] could not reschedule tasks', error),
  )
  void rescheduleAllWorkflowTriggers().catch((error: unknown) =>
    console.error('[Browser Copilot] could not reschedule workflow triggers', error),
  )
  void feishuBot.reconcile()
  // Run workflows whose trigger block is "on-startup". Scoped to the plugin
  // window when one exists (usually none is at browser start).
  void startupWorkflows()
    .then((wfs) => {
      for (const wf of wfs) void runWorkflowKeepalive(wf.id, latestPluginWindowId())
    })
    .catch((error: unknown) =>
      console.error('[Browser Copilot] on-startup workflows failed', error),
    )
  void initShortcutTriggers()
  void initElementChangeTriggers()
})

// Also fire on-startup workflows once when the service worker boots after install.
chrome.runtime.onInstalled.addListener(() => {
  void startupWorkflows()
    .then((wfs) => {
      for (const wf of wfs) void runWorkflowKeepalive(wf.id, latestPluginWindowId())
    })
    .catch(() => {})
})

// Fires for task alarms and the Feishu watchdog. Registered synchronously so an
// alarm wake is received even on a cold worker; the bot instance is declared
// below but the closure only runs when an alarm actually fires.
chrome.alarms.onAlarm.addListener((alarm) => {
  // Isolate each branch: an exception in one handler must not prevent the other
  // alarm type from being processed by the same wake.
  try {
    if (alarm.name === FEISHU_WATCHDOG_ALARM) {
      feishuBot.onWatchdog()
      return
    }
    if (isWorkflowTriggerAlarm(alarm.name)) {
      void handleWorkflowTriggerAlarm(alarm.name)
      return
    }
    onAlarm(alarm)
  } catch (error) {
    console.error('[Browser Copilot] alarm handler failed', alarm.name, error)
  }
})

/** Single long-lived Feishu bot connection (reconnects internally). */
const feishuBot = new FeishuBot()

// --- Workflow trigger listeners ------------------------------------------------

/**
 * (Re)creates a right-click context-menu item for every enabled workflow whose
 * trigger is `context-menu`. Rebuilding from scratch keeps the menu in sync with
 * storage: deleted workflows vanish, renames update the label, re-enabled ones
 * reappear.
 */
async function registerContextMenuWorkflows(): Promise<void> {
  const workflows = (await listWorkflows()).filter(
    (wf) => wf.trigger?.type === 'context-menu' && wf.trigger.enabled !== false,
  )
  try {
    chrome.contextMenus.removeAll()
  } catch {
    /* may already be cleared */
  }
  for (const wf of workflows) {
    try {
      chrome.contextMenus.create({
        id: wf.trigger?.menuItemId ?? wf.id,
        title: wf.name,
        contexts: ['page'],
      })
    } catch (error) {
      console.error('[Browser Copilot] could not create context menu item', wf.id, error)
    }
  }
}

/**
 * Runs a workflow, holding the worker alive for the duration so a context-menu
 * click or navigation that triggers it cannot strand the run mid-way.
 *
 * `scopeWindowId` pins the run to the window the trigger came from (panel run
 * button, visit-web match in a panel window, context menu on one of its tabs).
 * Undefined keeps the legacy global resolution — scheduled/startup/shortcut
 * alarm runs are unattended and have no window to bind to.
 */
async function runWorkflowKeepalive(workflowId: string, scopeWindowId?: number): Promise<void> {
  const wf = await getWorkflow(workflowId)
  if (!wf) return
  retain()
  try {
    await executeWorkflow(wf, {
      source: 'manual',
      ...(scopeWindowId !== undefined ? { scopeWindowId } : {}),
    })
  } finally {
    release()
  }
}

/**
 * Run a generated draft through the shared repair engine (spec §10.1).
 *
 * The first (and every) verification is an independent, takeover-free run;
 * when it fails the deterministic analyzer locates the root cause and a
 * minimal patch is proposed, validated, applied to the working copy and
 * replayed. Saving is never blocked by the outcome:
 *
 *   - VERIFIED → the draft ran independently; returned as-is.
 *   - DRAFT    → budget exhausted on a non-structural failure; the possibly
 *                patched workflow is still offered, with the diagnosis.
 *   - BLOCKED  → a structural problem; the workflow is still returned so the
 *                user can open AI debug, but the card flags the structure.
 *
 * Runs entirely under a keepalive retain so the worker cannot be evicted mid
 * verification. Execution errors are contained: a repair run that itself
 * throws degrades to returning the original draft (never a lost generation).
 */
async function verifyGeneratedDraft(workflow: Workflow): Promise<{
  workflow: Workflow
  info: import('../lib/messages').GeneratedWorkflowRepairInfo
}> {
  const settings = await getSettings()
  const modelConfig = takeoverProviderOf(settings)
  const proposer = modelConfig
    ? createAiRepairProposer({
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        model: modelConfig.model,
        headers: modelConfig.headers,
      })
    : undefined

  const runner = createBackgroundRunner({ executeWorkflow })
  let rounds = 0
  retain()
  try {
    const result = await finalizeGeneratedWorkflow(workflow, {
      runner,
      // Replay planning reads the durable checkpoints the verify run just
      // wrote through the real run-workflow store.
      store: getCheckpointStore(),
      ...(proposer ? { propose: (context) => proposer.propose(context) } : {}),
      // Conservative generation policy: keep the total verification bounded so
      // offering the save card never stalls the turn for long.
      policy: { maxRepairRounds: 2, maxTotalDurationMs: 45_000 },
      onStep: () => undefined,
    })
    rounds = result.patches.length
    // Repair telemetry (spec §14): one round log for the generation entry, with
    // no raw variable values — only node ids, the failure code and the result.
    const startedAtForMetric = Date.now()
    void recordRepairRound({
      at: Date.now(),
      sessionId: `gen-${workflow.id}-${startedAtForMetric}`,
      round: Math.max(1, rounds),
      entry: 'GENERATION',
      ...(result.lastAnalysis?.failedNodeId
        ? { failedNodeId: result.lastAnalysis.failedNodeId }
        : {}),
      rootCauseNodeIds: result.lastAnalysis?.rootCauseNodeIds ?? [],
      ...(result.lastAnalysis?.failureType ? { failureType: result.lastAnalysis.failureType } : {}),
      transientRetries: result.transientRetries,
      ...(result.patches[result.patches.length - 1]?.patchSetId
        ? { patchSetId: result.patches[result.patches.length - 1]!.patchSetId }
        : {}),
      patchedNodeIds: [
        ...new Set(result.patches.flatMap((patch) => patch.operations.map((op) => op.nodeId))),
      ],
      ...(result.lastVerification?.checkpointId
        ? { replayFromNodeId: result.lastAnalysis?.replayFromNodeId }
        : {}),
      usedCheckpoint: !!result.lastVerification?.checkpointId,
      usedAiTakeover: result.lastVerification?.usedAiTakeover === true,
      ...(result.lastVerification?.goalAchieved !== undefined
        ? { goalAchieved: result.lastVerification.goalAchieved }
        : {}),
      // A verified outcome reached WITHOUT a patch but after a bounded retry
      // is a TRANSIENT_RECOVERY — a distinct telemetry bucket (§1.3).
      result:
        result.status === 'VERIFIED'
          ? result.recoveredFromTransient
            ? 'TRANSIENT_RECOVERY'
            : 'VERIFIED'
          : result.status === 'BLOCKED'
            ? 'DRAFT'
            : 'DRAFT',
      durationMs: 0,
    })
    return {
      workflow: result.workingCopy,
      info: {
        verified: result.status === 'VERIFIED',
        status: result.status,
        ...(result.lastAnalysis?.failedNodeId
          ? { failedNodeId: result.lastAnalysis.failedNodeId }
          : {}),
        rootCauseNodeIds: result.lastAnalysis?.rootCauseNodeIds ?? [],
        ...(result.lastAnalysis?.failureType
          ? { failureType: result.lastAnalysis.failureType }
          : {}),
        explanation: result.lastAnalysis?.explanation ?? result.reason ?? '',
        rounds,
        transientRetries: result.transientRetries,
        ...(result.recoveredFromTransient ? { transientRecovery: true } : {}),
      },
    }
  } catch (error) {
    // The repair orchestration must never make the generated workflow vanish.
    return {
      workflow,
      info: {
        verified: false,
        status: 'DRAFT',
        rootCauseNodeIds: [],
        explanation: error instanceof Error ? error.message : String(error),
        rounds,
      },
    }
  } finally {
    release()
  }
}

// Let the trigger module launch workflows (keyboard-shortcut triggers carry
// the window they were pressed in; alarm-driven ones pass nothing).
setWorkflowRunner((workflowId, scopeWindowId) => {
  void runWorkflowKeepalive(workflowId, scopeWindowId)
})

// Right-click "run workflow" items. Guarded: the API is not present in tests and
// may be unavailable on some builds.
if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info) => {
    void (async () => {
      try {
        const workflows = await listWorkflows()
        const wf = workflows.find(
          (w) =>
            w.trigger?.type === 'context-menu' &&
            (w.trigger.menuItemId !== undefined
              ? w.trigger.menuItemId === info.menuItemId
              : w.id === info.menuItemId),
        )
        // The user clicked the menu item on a specific tab: run scoped to THAT
        // window (an explicit gesture acts where it happened). `tab` is present
        // at runtime but missing from this @types/chrome version's OnClickData.
        const menuTab = (info as { tab?: chrome.tabs.Tab }).tab
        if (wf) await runWorkflowKeepalive(wf.id, menuTab?.windowId)
      } catch (error) {
        console.error('[Browser Copilot] context-menu workflow failed', error)
      }
    })()
  })
}

// Visit-web workflows: fire when a matching page commits navigation. Defensive —
// ignore any scheme other than http(s), and fall back to substring matching if
// the stored pattern is not a valid regular expression.
//
// Plugin-window guard: once the plugin runs anywhere (a connected side panel
// OR a minimized one), matching navigations only fire in windows that run the
// plugin — a window without the plugin belongs to the user, and an automation
// starting there would hijack it. With the plugin closed everywhere the guard
// is a no-op (global listening, the long-standing default).
if (chrome.webNavigation?.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    void (async () => {
      try {
        const url = details.url
        if (!/^https?:/i.test(url)) return
        // `windowId` is present at runtime but missing from this
        // @types/chrome version's WebNavigation callback details.
        const navWindowId = (details as { windowId?: number }).windowId
        if (!shouldTriggerVisitWeb(hasPluginWindows(), isPluginWindow(navWindowId))) return
        const href = new URL(url).href
        const workflows = await listWorkflows()
        const wf = workflows.find((w) => {
          if (w.trigger?.type !== 'visit-web' || !w.trigger.urlPattern) return false
          try {
            return new RegExp(w.trigger.urlPattern).test(href)
          } catch {
            return href.includes(w.trigger.urlPattern)
          }
        })
        // Run scoped to the window the matching page opened in (a plugin
        // window — connected or minimized — by the guard above); undefined
        // when the plugin is closed everywhere.
        if (wf)
          await runWorkflowKeepalive(wf.id, isPluginWindow(navWindowId) ? navWindowId : undefined)
      } catch (error) {
        console.error('[Browser Copilot] visit-web workflow failed', error)
      }
    })()
  })
}

/** Records an agent step onto a running-task board entry, ignoring stale runs. */
function recordStep(
  kind: 'tool' | 'status' | 'result' | 'error' | 'info',
  text: string,
  runId: string,
): void {
  addStep(runId, kind, text)
}

// An MV3 worker can start cold on any event (an alarm, a port reconnect, a
// command). Reconcile schedules and the bot connection at module load so a task
// is never missed because the worker had not run its install/startup handlers.
initLastTabTracker()
// Drop closed windows from the panel registry so trigger guards stay honest.
initScopeWindowCleanup()
// Restore minimized-plugin marks (chrome.storage.session) after a worker restart.
initPanelMinimize()
void rescheduleAll().catch((error: unknown) =>
  console.error('[Browser Copilot] could not reschedule tasks', error),
)
void rescheduleAllWorkflowTriggers().catch((error: unknown) =>
  console.error('[Browser Copilot] could not reschedule workflow triggers', error),
)
void feishuBot.reconcile()
// Start/stop the outbound local-agent WebSocket on every worker wake.
void agentClient.sync()

/**
 * The toolbar icon is handled manually rather than via `openPanelOnActionClick`,
 * so a failure to open is logged instead of silently doing nothing.
 *
 * ## `sidePanel.open` must be called synchronously
 *
 * `open()` requires an active user gesture, and a gesture is only valid for the
 * synchronous portion of the handler. Any `await` before it yields to the event
 * loop, after which Chrome treats the gesture as consumed and `open()` rejects
 * with "may only be called in response to a user gesture".
 */
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})

chrome.action.onClicked.addListener((tab) => {
  // Opening the panel from the toolbar also retires the minimized state and
  // the floating page button — the plugin is plainly expanded again.
  if (typeof tab.windowId === 'number' && isMinimized(tab.windowId)) {
    expandWindow(tab.windowId)
    void broadcastFloating(tab.windowId, 'floating.hide')
  }
  // Nothing may be awaited before `open()`; see the note above.
  const opened =
    tab.windowId !== undefined
      ? chrome.sidePanel.open({ windowId: tab.windowId })
      : tab.id !== undefined
        ? chrome.sidePanel.open({ tabId: tab.id })
        : Promise.resolve()

  // Surface a failure instead of hiding it: a silent catch here is what made an
  // earlier gesture bug invisible.
  opened.catch((error: unknown) => {
    console.error('[Browser Copilot] could not open the side panel', error)
  })
})

/**
 * Sends one floating-button control message to every (injectable) tab of a
 * window. Tabs without the content script (chrome://, discarded, closed
 * mid-race) reject the send — swallowed, they simply show nothing until their
 * next load, where the script's own `floating.status` query decides.
 *
 * `floating.show` carries the window's saved drag position (if the user moved
 * the button before), so every page mounts the button where it was dropped.
 */
async function broadcastFloating(
  windowId: number,
  type: 'floating.show' | 'floating.hide',
): Promise<void> {
  const pos = type === 'floating.show' ? await getFloatingButtonPos(windowId) : undefined
  const tabs = await chrome.tabs.query({ windowId }).catch(() => [])
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === 'number')
      .map(async (tab) => {
        const tabId = tab.id as number
        try {
          await chrome.tabs.sendMessage(tabId, { type, ...(pos ? { pos } : {}) })
        } catch {
          if (type !== 'floating.show') return
          // No receiver: the tab was open before the extension (re)loaded, so
          // the manifest-declared content script was never injected there and
          // the broadcast silently no-ops — leaving the minimized plugin
          // invisible on that page. Inject the script on demand: it queries
          // `floating.status` on boot and mounts by itself. A rejection here
          // (chrome:// pages, discarded tabs, no host access) just means the
          // toolbar icon remains the expand fallback for that page.
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: [floatingButtonScriptFile()],
            })
          } catch {
            /* page cannot host content scripts */
          }
        }
      }),
  )
}

/**
 * The built (content-hashed) floating-button script file, resolved from the
 * manifest's own declaration so no build-time path is duplicated here.
 */
function floatingButtonScriptFile(): string {
  for (const entry of chrome.runtime.getManifest().content_scripts ?? []) {
    const file = entry.js?.find((name) => name.includes('floating-button'))
    if (file) return file
  }
  throw new Error('floating-button content script is not declared in the manifest')
}

// --- Message channel ---------------------------------------------------------
//
// Exactly ONE onMessage listener: special protocols (element picker, workflow
// recording events, keyboard-shortcut triggers) are claimed BEFORE the generic
// command switch. Previously each had its own listener, so a non-command
// message (e.g. picker:start) ALSO reached the command handler, which threw
// "Unknown command" and raced the real response — the root cause of the picker
// error and flaky run/record buttons.
// Multi-window picker: relay a pick request to every connected panel
// (extension pages) and let the first `window.pick.response` answer it.
// window-policy owns the pending map and the 30s timeout; this is only the
// chrome.runtime plumbing.
setWindowPickRequester(async (request: WindowPickRequest) => {
  try {
    await chrome.runtime.sendMessage(request)
  } catch {
    // No panel was listening (e.g. the picker dialog is not mounted in any
    // open panel) — the timeout fallback in window-policy answers null.
  }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 0. Floating-button protocol — MUST be handled before any await: the
  // content-script click gesture only carries over to `sidePanel.open` when
  // the listener calls it synchronously. The picker/shortcut checks below
  // await first, which silently broke the reopen on some builds.
  if (message?.type === 'floating.status') {
    const windowId = sender?.tab?.windowId
    // The query itself may have just woken the worker, and the session-state
    // restore runs asynchronously — answering synchronously would report a
    // stale `false` and the minimized plugin would show no button at all.
    void whenRestoreSettled()
      .then(async () => ({
        minimized: isMinimized(windowId),
        // The button's last dragged position, so a remount (new page,
        // navigation) puts it back where the user dropped it.
        ...(typeof windowId === 'number'
          ? { pos: (await getFloatingButtonPos(windowId)) ?? undefined }
          : {}),
      }))
      .then((response) => {
        try {
          sendResponse(response)
        } catch {
          /* the asker navigated away before the answer */
        }
      })
    return true
  }
  if (message?.type === 'floating.move') {
    // The user dropped the dragged button. Persist per window so every page
    // of this window remounts it there. Not gesture-sensitive — plain storage.
    const windowId = sender?.tab?.windowId
    const x = (message as { x?: unknown }).x
    const y = (message as { y?: unknown }).y
    if (typeof windowId === 'number' && typeof x === 'number' && typeof y === 'number') {
      void setFloatingButtonPos(windowId, { x, y })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }))
      return true
    }
    sendResponse({ ok: false })
    return
  }
  if (message?.type === 'floating.expand') {
    const windowId = sender?.tab?.windowId
    if (typeof windowId === 'number') {
      // Open first, retire the minimized mark only once the panel is really
      // open: a rejected open() (gesture race right after worker wake) then
      // leaves the mark AND the button intact, so the next click can retry.
      // No isMinimized guard here either — a stale button click is exactly
      // the desync we want to self-heal.
      const opened =
        sender?.tab?.id !== undefined
          ? chrome.sidePanel.open({ tabId: sender.tab.id })
          : chrome.sidePanel.open({ windowId })
      void opened
        .then(() => {
          expandWindow(windowId)
          void broadcastFloating(windowId, 'floating.hide')
        })
        .catch((error: unknown) => {
          console.error(
            '[Browser Copilot] could not reopen the side panel from the floating button',
            error,
          )
        })
    }
    sendResponse({ ok: true })
    return
  }

  void (async () => {
    try {
      // 另存为 picker 请求由侧面板处理，这里直接放行。
      if (message?.type === 'download:save-picker') return false as unknown as void

      // 1. Recording events are one-way (in-page recorder -> controller).
      if (handleRecordEvent(message)) {
        sendResponse({ ok: true })
        return
      }

      // 2. Element picker start/verify/result/cancel.
      const picker = await handlePickerMessage(message)
      if (picker.handled) {
        sendResponse(picker.response)
        return
      }

      // 3. Keyboard-shortcut triggers from the injected tab listener.
      if (await handleShortcutPressed(message, sender)) {
        sendResponse({ ok: true })
        return
      }

      // 3.1 Element-change triggers from an injected MutationObserver.
      if (await handleElementChange(message, sender)) {
        sendResponse({ ok: true })
        return
      }

      // 3.6 Multi-window picker answer from a panel.
      if (message?.type === 'window.pick.response') {
        const pick = message as { requestId: string; windowId: number | null }
        handleWindowPickResponse(pick.requestId, pick.windowId)
        sendResponse({ ok: true })
        return
      }

      // 4. Generic command channel (workflows.*, settings, skills, ...).
      const data = await handleCommand(message as Command, sender)
      sendResponse({ ok: true, data } satisfies CommandResponse)
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies CommandResponse)
    }
  })()
  // Keep the response channel open for the async work above.
  return true
})

// Wire tab/navigation listeners for workflow recording.
initRecordingLifecycle()

function runningBoardsView(workflowIdFilter?: string): {
  runs: {
    runId: string
    taskId?: string
    workflowId?: string
    label: string
    source: ReturnType<typeof listRunning>[number]['source']
    startedAt: number
    steps: ReturnType<typeof listRunning>[number]['steps']
  }[]
  finished: {
    runId: string
    taskId?: string
    workflowId?: string
    label: string
    source: ReturnType<typeof listFinished>[number]['source']
    startedAt: number
    finishedAt: number
    outcome: ReturnType<typeof listFinished>[number]['outcome']
    summary?: string
    error?: string
    steps: ReturnType<typeof listFinished>[number]['steps']
  }[]
} {
  const mapFinished = (r: ReturnType<typeof listFinished>[number]) => ({
    runId: r.runId,
    taskId: r.taskId,
    workflowId: r.workflowId,
    label: r.label,
    source: r.source,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    outcome: r.outcome,
    summary: r.summary,
    error: r.error,
    steps: r.steps,
    ...(r.snapshots ? { snapshots: r.snapshots } : {}),
  })
  const matches = <T extends { workflowId?: string }>(r: T): boolean =>
    !workflowIdFilter || r.workflowId === workflowIdFilter
  return {
    runs: listRunning()
      .filter(matches)
      .map((r) => ({
        runId: r.runId,
        taskId: r.taskId,
        workflowId: r.workflowId,
        label: r.label,
        source: r.source,
        startedAt: r.startedAt,
        steps: r.steps,
        ...(r.snapshots ? { snapshots: r.snapshots } : {}),
      })),
    finished: listFinished().filter(matches).map(mapFinished),
  }
}

/**
 * The window scope of an extension-page sender (side panel / editor): the
 * sender tab's window, validated to still exist and be `normal`. The editor
 * popup is a `popup`-type window, so its commands degrade to unscoped.
 */
async function scopeOfSender(sender?: chrome.runtime.MessageSender): Promise<number | undefined> {
  const scope = await normalScopeFromWindowId(sender?.tab?.windowId)
  return scope?.windowId
}

/** A short unique id correlating every record of one debug session. */
function newDebugSessionId(): string {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `dbg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function handleCommand(
  command: Command,
  sender?: chrome.runtime.MessageSender,
): Promise<CommandResult> {
  // Window scope of the extension page that sent this command, if any.
  // Page reads and panel-run workflows act inside THAT window; commands from
  // non-extension senders or the editor popup resolve to undefined (global).
  const senderScopeWindowId = await scopeOfSender(sender)
  // An explicit command windowId — the editor popup's HOST window, appended
  // when the panel opened it — wins over the sender-derived scope: the
  // editor's own window is a popup (never a valid scope), so it carries the
  // window that opened it. A stale id (host window closed) degrades to the
  // sender scope, which for the editor means the legacy global chain.
  const commandWindowId = (command as { windowId?: number }).windowId
  const scopeWindowId =
    commandWindowId !== undefined
      ? ((await normalScopeFromWindowId(commandWindowId).catch(() => undefined))?.windowId ??
        senderScopeWindowId)
      : senderScopeWindowId
  switch (command.type) {
    case 'settings.get':
      return { type: 'settings', settings: await getSettings() }

    case 'settings.set': {
      const settings = await setSettings(command.patch)
      // The local-agent bridge reads settings: reconcile the connection now.
      void agentClient.sync()
      return { type: 'settings', settings }
    }

    case 'agent.status.get':
      return { type: 'agent.status', status: agentClient.getStatus() }

    case 'agent.windows.list':
      return { type: 'agent.windows', windows: await listNormalWindows() }

    case 'agent.bindings.set': {
      // Atomic read-modify-write of the whole name -> windowId map: two panels
      // assigning different connections at the same instant must not lose each
      // other's entry (a panel-side settings.set patch would clobber it).
      const name = command.agentName.trim()
      if (!name) throw new Error('agent.bindings.set: agentName is required.')
      const current = await getSettings()
      const bindings = { ...(current.localAgentBindings ?? {}) }
      if (command.windowId === null) {
        delete bindings[name]
        forgetAgentWindow(command.agentId)
      } else {
        // Only a window that still exists and hosts the plugin can be assigned.
        const scope = await normalScopeFromWindowId(command.windowId)
        if (!scope || !isPluginWindow(scope.windowId)) {
          throw new Error('agent.bindings.set: target window is not a plugin window.')
        }
        bindings[name] = scope.windowId
        rememberAgentWindow(command.agentId, scope.windowId)
      }
      const settings = await setSettings({ localAgentBindings: bindings })
      return { type: 'settings', settings }
    }

    case 'panel.minimize': {
      // The panel reports its own window (a window-level UI resolves it via
      // chrome.windows.getCurrent()). Validated: only a real normal window can
      // be minimized. The panel closes itself (window.close) after this ack.
      const scope = await normalScopeFromWindowId(command.windowId)
      if (!scope) throw new Error('panel.minimize: unknown or non-normal window.')
      minimizeWindow(scope.windowId)
      // Mark first, broadcast second: even if the panel fails to close, the
      // minimized state (and its scope semantics) is already consistent.
      void broadcastFloating(scope.windowId, 'floating.show')
      return { type: 'panel.minimize' }
    }

    case 'skills.list':
      return { type: 'skills.list', skills: await listSkills() }

    case 'skills.save': {
      const normalized = normalizeSkill(command.skill)
      const problems = validateSkill(normalized, await listSkills())
      if (problems.length > 0) {
        // Codes, not sentences: the panel owns the wording so validation errors
        // appear in the user's chosen language.
        throw new Error(`skill:${problems.map((problem) => problem.code).join(',')}`)
      }
      await saveSkill(normalized)
      // Other panels (and the sending one, as a cheap idempotent refresh)
      // re-read the list so a saved skill reaches the picker immediately.
      notifySkillsChanged()
      return { type: 'skills.save', skill: normalized }
    }

    case 'skills.delete':
      await deleteSkill(command.id)
      notifySkillsChanged()
      return { type: 'skills.delete' }

    case 'agents.list':
      return { type: 'agents.list', agents: await listAgents() }

    case 'agents.save': {
      // Built-in agents are directly editable: the edit carries a real
      // updatedAt, which stops seed refreshes from overwriting it; the
      // agents.reset command restores the shipped version on demand.
      const normalized = normalizeAgent(command.agent)
      const problems = validateAgent(normalized, await listAgents())
      if (problems.length > 0) {
        // Codes, not sentences: the panel owns the localized wording.
        throw new Error(`agent:${problems.map((problem) => problem.code).join(',')}`)
      }
      await saveAgent(normalized)
      notifyAgentsChanged()
      return { type: 'agents.save', agent: normalized }
    }

    case 'agents.delete':
      await deleteAgent(command.id)
      notifyAgentsChanged()
      return { type: 'agents.delete' }

    case 'agents.reset': {
      const agent = await resetAgentToBuiltIn(command.id)
      notifyAgentsChanged()
      return { type: 'agents.reset', agent }
    }

    case 'provider.save': {
      const problems = validateProfile(command.profile)
      if (problems.length > 0) {
        throw new Error(problems.map((problem) => problem.message).join(' '))
      }
      return { type: 'settings', settings: await saveProvider(command.profile) }
    }

    case 'provider.delete':
      return { type: 'settings', settings: await deleteProvider(command.id) }

    case 'provider.activate':
      return { type: 'settings', settings: await setSettings({ activeProviderId: command.id }) }

    case 'provider.test': {
      const problems = validateProfile(command.profile)
      if (problems.length > 0) {
        throw new Error(problems.map((problem) => problem.message).join(' '))
      }
      await testConnection({
        apiKey: command.profile.apiKey,
        baseUrl: command.profile.baseUrl,
        model: command.profile.model,
        ...(command.profile.headers ? { headers: command.profile.headers } : {}),
      })
      return { type: 'provider.test' }
    }

    case 'provider.models': {
      const models = await listModels({
        apiKey: command.profile.apiKey,
        baseUrl: command.profile.baseUrl,
        ...(command.profile.headers ? { headers: command.profile.headers } : {}),
      })
      return { type: 'provider.models', models }
    }

    case 'page.read':
      return {
        type: 'page.read',
        page: await readActivePage(
          command.maxChars,
          scopeWindowId === undefined ? undefined : { windowId: scopeWindowId },
        ),
      }

    case 'page.check': {
      const tab = await activeTab(
        scopeWindowId === undefined ? undefined : { windowId: scopeWindowId },
      )
      if (!tab || typeof tab.id !== 'number') {
        return {
          type: 'page.check',
          readable: false,
          reason: 'No active tab was found.',
        }
      }
      const readable = isInjectablePage(tab.url)
      return {
        type: 'page.check',
        readable,
        ...(tab.url ? { tabUrl: tab.url } : {}),
        ...(tab.title ? { tabTitle: tab.title } : {}),
        ...(readable
          ? {}
          : {
              reason:
                'Only ordinary http(s) pages can be automated. Browser pages (chrome://), the Web Store, and local files are off limits to every extension.',
            }),
      }
    }

    case 'profiles.list':
      return { type: 'profiles.list', profiles: await listProfiles() }
    case 'profiles.save':
      await saveProfile(command.profile)
      return { type: 'profiles.save' }
    case 'profiles.delete':
      await deleteProfile(command.id)
      return { type: 'profiles.delete' }

    case 'passwords.list':
      return { type: 'passwords.list', entries: await listPasswords() }
    case 'passwords.save':
      await savePassword(command.entry)
      return { type: 'passwords.save' }
    case 'passwords.delete':
      await deletePassword(command.id)
      return { type: 'passwords.delete' }

    case 'history.list':
      return { type: 'history.list', entries: await listHistory() }
    case 'history.delete':
      await deleteHistory(command.id)
      return { type: 'history.delete' }
    case 'history.clear':
      await clearHistory()
      return { type: 'history.clear' }

    case 'conversations.list':
      return { type: 'conversations.list', conversations: await listConversations() }
    case 'conversations.get': {
      const [meta, messages] = await Promise.all([
        (async () => (await listConversations()).find((entry) => entry.id === command.id))(),
        loadConversation(command.id),
      ])
      const visible = messages
        .filter(
          (
            entry,
          ): entry is {
            role: 'user' | 'assistant'
            content: string
            attachments?: AttachmentDescriptor[]
          } =>
            (entry.role === 'user' || entry.role === 'assistant') &&
            typeof entry.content === 'string' &&
            // Keep attachment-only user turns (empty text) so their files
            // still render when the conversation is reopened.
            (entry.content.trim().length > 0 ||
              (entry.role === 'user' && (entry.attachments?.length ?? 0) > 0)),
        )
        .map((entry) => ({
          role: entry.role,
          // Hide model-only envelopes (skill directive, selection block);
          // falls back to legacy unwrapping for older transcripts.
          text: entry.role === 'user' ? getUserDisplayText(entry) : entry.content,
          ...(entry.role === 'user' && entry.attachments?.length
            ? { attachments: toAttachmentSummaries(entry.attachments) }
            : {}),
        }))
      return {
        type: 'conversations.get' as const,
        id: command.id,
        title: meta?.title ?? 'Conversation',
        messages: visible,
      }
    }
    case 'conversations.rename':
      await renameConversation(command.id, command.title)
      return { type: 'conversations.rename' }
    case 'conversations.delete':
      await deleteConversation(command.id)
      return { type: 'conversations.delete' }

    case 'tasks.list':
      return { type: 'tasks.list', tasks: await listTasks() }
    case 'tasks.save':
      await saveTask(command.task)
      await scheduleTask(command.task.id)
      return { type: 'tasks.save' }
    case 'tasks.delete':
      await deleteTask(command.id)
      await scheduleTask(command.id) // clears the alarm for a deleted task
      await clearRuns(command.id)
      return { type: 'tasks.delete' }
    case 'tasks.run': {
      const outcome = await triggerNow(command.id, 'manual')
      return { type: 'tasks.run', outcome }
    }
    case 'tasks.runs':
      return { type: 'tasks.runs', runs: await listRuns(command.taskId) }
    case 'tasks.runs.clear':
      await clearRuns(command.taskId)
      return { type: 'tasks.runs.clear' }
    case 'tasks.runs.delete':
      await deleteRun(command.id)
      forgetFinished(command.id)
      return { type: 'tasks.runs.delete' }
    case 'tasks.running':
      return { type: 'tasks.running', ...runningBoardsView() }
    case 'tasks.cancel':
      return { type: 'tasks.cancel', ok: cancelRun(command.runId) }
    case 'tasks.finished.delete':
      // Remove from the board and its persisted run log entry.
      forgetFinished(command.runId)
      await deleteRun(command.runId)
      return { type: 'tasks.finished.delete' }
    case 'tasks.finished.clear':
      // Clear the board and all persisted task-run logs (chat runs are excluded
      // by the store and never persisted).
      clearFinished()
      await clearRuns()
      return { type: 'tasks.finished.clear' }

    case 'feishu.get':
      return { type: 'feishu.get', config: await getFeishuConfig() }
    case 'feishu.save':
      await saveFeishuConfig(command.config)
      void feishuBot.reconcile()
      return { type: 'feishu.save' }
    case 'feishu.test': {
      const config = await getFeishuConfig()
      if (!isWebhookUrl(config.webhookUrl)) {
        return { type: 'feishu.test', ok: false, message: 'Webhook URL is not set or invalid.' }
      }
      try {
        await sendWebhookText(
          config.webhookUrl,
          '✅ Browser Copilot 测试消息：飞书通知已连通。',
          config.webhookSecret,
        )
        return { type: 'feishu.test', ok: true }
      } catch (error) {
        return {
          type: 'feishu.test',
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }

    case 'workflows.list':
      return { type: 'workflows.list', workflows: await listWorkflows() }

    case 'workflows.get':
      return { type: 'workflows.get', workflow: await getWorkflow(command.id) }

    case 'workflows.save': {
      let workflow = command.workflow
      if (command.fromGeneration) {
        // A save from the generation card gets the two hardening passes (see
        // specs/2026-09-19-first-run-success-design.md): element locators are
        // re-picked against the live page (the page the user just generated
        // on is the best evidence the graph will ever get), and the element
        // waits the run path would force anyway are persisted so every
        // consumer of the graph sees them. Editor/import saves skip both —
        // hand-tuned selectors are never rewritten behind the user's back.
        // The page may already be closed or restricted: hardening returns the
        // graph unchanged then, which degrades to exactly the old behavior.
        await hardenWorkflowSelectors(workflow, { scope: await currentPluginScope() })
        workflow = persistDefaultWaits(workflow)
      }
      // Every formal save is a commit on the revision sequence: a new workflow
      // starts at revision 1; a later save (manual edit or re-generated content)
      // bumps it. Bump here so callers never have to compute the number.
      {
        const nextSave = commitWorkflowRevision(workflow, {
          source: command.fromGeneration ? 'generation' : 'manual-edit',
        })
        workflow = {
          ...workflow,
          updatedAt: workflow.updatedAt || Date.now(),
          revision: nextSave.revision,
          revisionHistory: nextSave.revisionHistory,
        }
      }
      await saveWorkflow(workflow)
      await rescheduleAllWorkflowTriggers()
      return { type: 'workflows.save' }
    }

    case 'workflows.delete':
      await deleteWorkflow(command.id)
      await rescheduleAllWorkflowTriggers()
      return { type: 'workflows.delete' }

    case 'workflows.draft.get': {
      // Materialise the workflow for the panel's review card without persisting
      // it. The user reviews and clicks save themselves.
      //
      // `resolveWorkflowForSave` owns the source order (operator draft, then
      // compiled action history) AND the third outcome — "nothing to save, and
      // here is why". It is deliberately not inlined here: the previous version
      // of this case returned early whenever the draft was empty, which meant
      // the history fallback below it never ran and the panel got neither a
      // workflow nor an explanation. That is how the save card disappeared.
      //
      // The selector probes used to run here. They now go through
      // `workflows.probe`, because probing injects a script into the page and
      // must never be able to delay or swallow the card.
      const conversation = (await listConversations()).find(
        (entry) => entry.id === command.conversationId,
      )
      const resolved = await resolveWorkflowForSave(
        command.conversationId,
        conversation?.title?.trim() || 'Workflow',
      )
      if ('empty' in resolved)
        return { type: 'workflows.draft', empty: resolved.empty, detail: resolved.detail }

      // Generation repair (spec §10.1, Phase 7): run the already-formed
      // generated workflow through the SAME shared repair engine the debug
      // path uses — independent (takeover-free) verify → diagnose → minimal
      // patch → replay. First-pass verification never permits AI takeover.
      //
      // This is deliberately NON-BLOCKING: a verified workflow is returned as
      // is; when the repair budget is exhausted the (possibly patched) draft
      // is still offered, with the diagnosis carried in `repair` so the card
      // can show the symptom vs root cause. Only structural problems surface
      // as a status; the user can still save and continue in AI debug.
      const repairSummary = await verifyGeneratedDraft(resolved.workflow)
      return {
        type: 'workflows.draft',
        workflow: repairSummary.workflow,
        source: resolved.source,
        repair: repairSummary.info,
        // Pure detection, so the card can offer folding without a round trip.
        // Only meaningful for a draft the model built step by step; a compiled
        // history has no repeated runs to detect.
        ...(resolved.source === 'draft'
          ? { suggestions: await draftRepeatRuns(command.conversationId) }
          : {}),
      }
    }

    case 'workflows.probe': {
      // Ask the page whether the graph's selectors still resolve. Re-resolving
      // the workflow instead of taking it from the panel keeps this command
      // stateless, and the answer is about the page — not about the trigger
      // tweaks the panel may have made since.
      const conversation = (await listConversations()).find(
        (entry) => entry.id === command.conversationId,
      )
      const resolved = await resolveWorkflowForSave(
        command.conversationId,
        conversation?.title?.trim() || 'Workflow',
      )
      if ('empty' in resolved) return { type: 'workflows.probe', probes: null }
      // A null scope (no plugin window reachable) is "not verified", and
      // `probeWorkflowSelectors` reports that rather than pretending success.
      const scope = await currentPluginScope()
      return {
        type: 'workflows.probe',
        probes: await probeWorkflowSelectors(resolved.workflow, scope),
      }
    }

    case 'workflows.draft.fold': {
      // Folding rewrites the DRAFT (not a saved workflow): the user is still
      // reviewing, and an unwanted fold is undone by discarding the card.
      const outcome = await foldDraftRun(
        command.conversationId,
        command.index,
        // The panel is the user's active surface, so probe the tab it is
        // working in — the same scope the other panel-driven paths resolve.
        createCollapseProbe(await currentPluginScope()),
        new AbortController().signal,
        // Match the run by the ids the card rendered, not by list position:
        // the background re-detects on the current draft, and positions can
        // drift if anything touched the draft since the card was built.
        command.runIds,
      )
      const out = await composeWorkflowFromDraft(command.conversationId, { save: false })
      if ('error' in out) {
        return { type: 'workflows.draft.fold', folded: false, error: out.error }
      }
      return {
        type: 'workflows.draft.fold',
        workflow: out.workflow,
        folded: outcome.folded,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        suggestions: await draftRepeatRuns(command.conversationId),
      }
    }

    case 'workflows.draft.clear': {
      // Panel finishes with a draft (saved or discarded) — drop both the
      // cached copy and the persisted mirror so the next operator-tool turn in
      // the same conversation starts fresh instead of appending to an
      // already-saved workflow. Resolved credentials go with it: a value must
      // not outlive the generation that resolved it.
      await clearDraft(command.conversationId)
      forgetGenerationSecrets(command.conversationId)
      return { type: 'workflows.draft.clear' }
    }

    case 'workflows.review': {
      // Null (unavailable) is a valid outcome: the panel then keeps every
      // step. A real failure (timeout / endpoint error / unusable reply)
      // becomes `error` so the panel can show WHY instead of a bare hint.
      try {
        return {
          type: 'workflows.review',
          review: await reviewWorkflow(command.workflow, (text) =>
            broadcastPanels({ type: 'workflows.reviewLog', text }),
          ),
        }
      } catch (error) {
        return {
          type: 'workflows.review',
          review: null,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    case 'workflows.run': {
      const workflow = await getWorkflow(command.id)
      if (!workflow) throw new Error('Workflow not found.')
      // Refuse to start a workflow that cannot work. This gate is ONLY on the
      // user-initiated run path: `executeWorkflow` itself must stay permissive,
      // because the alarm / context-menu / shortcut triggers reach it with
      // graphs that are already known-good, and a newly added rule must not be
      // able to break them. Warnings are surfaced to the run log instead of
      // blocking — an unarmed trigger kind still runs perfectly well when the
      // user starts it by hand.
      const gate = validateWorkflowForRun(workflow)
      if (gate.errors.length > 0) {
        throw new Error(`无法运行该工作流：\n${gate.errors.map((e) => `· ${e}`).join('\n')}`)
      }
      for (const warning of gate.warnings) console.warn(`[workflows.run] ${warning}`)
      // Optional AI takeover on plain runs (settings.takeoverOnRun, default
      // off): a failed node gets one agent episode, its fix lands as pending
      // for user confirmation — same closure as the debug session, without
      // the verify loop.
      const settings = await getSettings()
      let takeover: ReturnType<typeof createAiTakeover> | undefined
      if (settings.takeoverOnRun) {
        const provider = takeoverProviderOf(settings)
        takeover = createAiTakeover({
          ...(provider ? { provider } : {}),
          // M1-10(c): an automatic run gets a SINGLE takeover episode (cost
          // ceiling) — the fix lands as pending for the user to confirm, it
          // must not loop 3×40 unattended. Overridable via
          // BC_TAKEOVER_AUTORUN_BUDGET.
          takeoverBudget: takeoverAutoRunBudget(),
          onTakeover: (report) => {
            void recordTakeoverStat({
              at: Date.now(),
              workflowId: workflow.id,
              nodeId: report.nodeId,
              completed: report.completed,
              attempts: report.attempts,
              ...(report.reasonKind ? { reasonKind: report.reasonKind } : {}),
            })
          },
        })
      }
      const r = await executeWorkflow(workflow, {
        source: 'manual',
        startAt: (command as { startAt?: string }).startAt,
        debug: workflow.settings?.debugMode === true,
        ...(takeover ? { aiTakeover: takeover } : {}),
        // Panel run button: act inside the panel's window (undefined for the
        // editor popup, which is not a normal window).
        ...(scopeWindowId !== undefined ? { scopeWindowId } : {}),
      })
      return {
        type: 'workflows.run',
        outcome: {
          ok: r.outcome === 'ok',
          skipped: false,
          summary: r.summary ?? '',
          error: r.outcome === 'failed' ? r.summary : undefined,
          runId: r.runId,
        },
      }
    }

    case 'workflows.resumePoint': {
      // M4: does this workflow have a clean step to continue from? The panel
      // uses it to decide whether to offer the Resume action at all — resuming
      // a workflow that never ran (or that finished) would be meaningless.
      const workflow = await getWorkflow(command.id)
      if (!workflow) return { type: 'workflows.resumePoint', resumable: false }
      // The last run is usually NOT in this session's memory: an MV3 worker is
      // evicted once a run settles, and the panel asks later. The persisted
      // index is what carries the run id across that gap.
      const runId = await findRunIdFor(command.id)
      if (!runId) return { type: 'workflows.resumePoint', resumable: false }
      const inMemory = getCheckpointStore().load(runId)
      const checkpoints =
        inMemory.length > 0 ? inMemory : await readPersistedCheckpoints(runId).catch(() => [])
      const point = resumePointOf(workflow, checkpoints)
      if (!point || point.kind !== 'ok') {
        // side-effect-unknown / fingerprint-mismatch are not offerable — the
        // resume itself will report the structured reason.
        return { type: 'workflows.resumePoint', resumable: false }
      }
      return {
        type: 'workflows.resumePoint',
        resumable: true,
        runId,
        fromStepIndex: point.fromStepIndex,
      }
    }

    case 'workflows.resume': {
      // M4 resume: re-run a workflow from its last clean checkpoint instead of
      // its trigger. For a non-idempotent flow (login / submit / send) the
      // finished prefix cannot be re-driven — the login form is gone — so the
      // retry must skip it. Unresumable runs simply start from the beginning.
      const workflow = await getWorkflow(command.id)
      if (!workflow) throw new Error('Workflow not found.')
      const r = await executeWorkflow(workflow, {
        source: 'manual',
        resumeFrom: command.runId,
        debug: workflow.settings?.debugMode === true,
        ...(scopeWindowId !== undefined ? { scopeWindowId } : {}),
      })
      return {
        type: 'workflows.resume',
        outcome: {
          ok: r.outcome === 'ok',
          summary: r.summary ?? '',
          ...(r.outcome === 'failed' ? { error: r.error ?? r.summary } : {}),
          runId: r.runId,
          ...(r.resumedFrom !== undefined ? { resumedFrom: r.resumedFrom } : {}),
        },
      }
    }

    case 'workflows.debug': {
      const workflow = await getWorkflow(command.id)
      if (!workflow) throw new Error('Workflow not found.')
      // Same panel-window scoping as a manual run: panel-started debugs act
      // only inside that window; editor popups degrade to the global scope.
      const scope =
        scopeWindowId === undefined
          ? undefined
          : await normalScopeFromWindowId(scopeWindowId).catch(() => undefined)
      // One tracked "debug session" run wraps the whole loop: the panel's live
      // log modal polls the board for it, and it lands in History when done.
      const session = startRun({
        label: debugRunLabel(workflow.name),
        source: 'manual',
        workflowId: workflow.id,
      })
      // The debug run spans the workflow plus possibly several agent takeovers;
      // hold the worker alive for the whole session (released in `finally`).
      retain()
      // Session-level telemetry: the metric that matters is "did this session
      // end with a takeover-free pass?", with per-phase timing so the remaining
      // bottleneck can be attributed. Every record of this session carries the
      // same sessionId.
      const sessionId = newDebugSessionId()
      const sessionStartedAt = Date.now()
      const phases: Partial<Record<DebugPhase, number>> = {}
      let rewriteVerifyArmed = false
      let goalJudgeResponded = false
      let lastReasonKind: TakeoverReasonKind | undefined
      const timePhase = async <T>(phase: DebugPhase, fn: () => Promise<T>): Promise<T> => {
        const started = Date.now()
        try {
          return await fn()
        } finally {
          phases[phase] = (phases[phase] ?? 0) + (Date.now() - started)
        }
      }
      let debugResult: WorkflowDebugResult | undefined
      try {
        // Dedicated takeover model when configured; else the chat model.
        const settings = await getSettings()
        const provider = takeoverProviderOf(settings)
        // Bring the run's tab to the foreground so the takeover agent acts on
        // the page the workflow was actually driving.
        const pinTab = async (tabId: number): Promise<void> => {
          const tab = await chrome.tabs.get(tabId).catch(() => undefined)
          if (!tab) return
          await chrome.tabs.update(tabId, { active: true }).catch(() => undefined)
          if (typeof tab.windowId === 'number') {
            await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
          }
        }
        // Phase 2 of the redefined debug: when the node-level loop fails, a
        // FULL agent re-executes the whole task on the live page exactly like
        // the first chat run (snapshot → act → verify), and its actual tool
        // trace becomes the ground truth for the graph audit.
        const replay = provider
          ? async (
              wf: Workflow,
              onStep: (kind: 'tool' | 'status' | 'result' | 'error', text: string) => void,
            ) =>
              timePhase('replay', async () => {
                const trace: string[] = []
                const result = await runUnattendedPrompt(
                  buildReplayPrompt(wf),
                  `workflow-replay:${workflow.id}`,
                  'full',
                  {
                    maxToolRounds: 30,
                    ...(scopeWindowId !== undefined ? { scopeWindowId } : {}),
                    onStep: (kind, text) => {
                      if (kind === 'tool' || kind === 'result' || kind === 'error') {
                        trace.push(
                          `${kind === 'tool' ? '→' : kind === 'result' ? '←' : '!'} ${text}`,
                        )
                        if (trace.length > 80) trace.splice(0, trace.length - 80)
                      }
                      onStep(kind === 'info' ? 'status' : kind, text)
                    },
                  },
                )
                return {
                  completed: result.ok && !result.cancelled,
                  summary: (result.answer ?? '').trim().slice(0, 800),
                  trace,
                }
              })
          : undefined
        // Phase 3: one-shot model call that audits the graph against the
        // replay and proposes a corrected WHOLE graph. The graph is validated
        // (known blocks, resolvable edges, trigger present) before it can be
        // offered to the user.
        const audit = provider
          ? async (
              wf: Workflow,
              replayResult: { completed: boolean; summary: string; trace: string[] },
              failure: { error?: string; takeoverNote?: string },
            ) =>
              timePhase('audit', async () => {
                const result = await streamCompletion(
                  {
                    apiKey: provider.apiKey,
                    baseUrl: provider.baseUrl,
                    model: provider.model,
                    messages: [
                      {
                        role: 'user',
                        content: buildAuditPrompt(wf, replayResult, failure),
                      },
                    ],
                    headers: provider.headers,
                    signal: AbortSignal.timeout(AUDIT_TIMEOUT_MS),
                  },
                  {},
                )
                const parsed = parseWorkflowAudit(stripThinkBlocks(result.content))
                if (!parsed) return null
                // Identity (id/name/settings/plan/folder) comes from the SAVED
                // workflow, not the auto-wait clone; only the graph is replaced.
                const rewritten = parsed.graph
                  ? buildRewrittenWorkflow(workflow, parsed.graph)
                  : null
                // A validated rewrite triggers a takeover-free verify run next —
                // tag that run as 'rewrite-verify' rather than a fix-verify.
                if (rewritten) rewriteVerifyArmed = true
                return {
                  diagnosis: parsed.diagnosis,
                  nodes: parsed.nodes,
                  changes: parsed.changes,
                  rewritten,
                }
              })
          : undefined
        const result = await runDebugSession(workflow, {
          maxRounds: 2,
          // Repeat-dead-end threshold from the shared repair policy (spec §13),
          // not the legacy hardcoded constant.
          maxSameFailureSignature: DEFAULT_REPAIR_POLICY.maxSameFailureSignature,
          // M4: stamp the session id onto every run this session spawns.
          sessionId,
          ...(replay && audit
            ? {
                replay,
                audit,
                saveRewrite: async (workflowId, runId, rewrite) => {
                  await savePendingTakeover({
                    workflowId,
                    runId,
                    fixes: [],
                    rewrite,
                    createdAt: Date.now(),
                    sessionId,
                  })
                },
              }
            : {}),
          run: async (wf, opts) => {
            // A run with the takeover hook is the node-level phase; a
            // takeover-free run is the fix-verify — or the rewrite-verify once
            // the audit produced a corrected graph.
            const phase: DebugPhase = opts.aiTakeover
              ? 'takeover'
              : rewriteVerifyArmed
                ? 'rewrite-verify'
                : 'verify'
            return timePhase(phase, async () => {
              // Per-node param summaries resolved per pass: the graph evolves
              // between rounds (auto-wait copy, applied fixes).
              const params = new Map<string, string>()
              const labels = new Map<string, string>()
              for (const node of wf.drawflow.nodes) {
                const summary = describeNodeParams(node)
                if (summary) params.set(node.id, summary)
                const blockId =
                  typeof node.data?.['blockId'] === 'string' ? node.data['blockId'] : node.label
                const desc =
                  typeof node.data?.['description'] === 'string' ? node.data['description'] : ''
                labels.set(
                  node.id,
                  desc
                    ? `${BLOCK_BY_ID.get(blockId)?.name ?? blockId}: ${desc}`
                    : (BLOCK_BY_ID.get(blockId)?.name ?? blockId),
                )
              }
              // Evidence trail for the goal-completion judge: what the run
              // actually did, resolved to human-readable lines.
              const evidenceSteps: { kind: string; text: string }[] = []
              const result = await executeWorkflow(wf, {
                source: 'manual',
                debug: wf.settings?.debugMode === true,
                ...(opts.aiTakeover ? { aiTakeover: opts.aiTakeover } : {}),
                ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
                ...(scopeWindowId !== undefined ? { scopeWindowId } : {}),
                onStep: (kind, nodeId, text) => {
                  const runKind: RunStepKind = (RUN_STEP_KINDS as readonly string[]).includes(kind)
                    ? (kind as RunStepKind)
                    : 'status'
                  if (kind === 'tool' && nodeId) {
                    const label = labels.get(nodeId) ?? nodeId
                    const summary = params.get(nodeId)
                    evidenceSteps.push({ kind, text: `${label}${summary ? `（${summary}）` : ''}` })
                    addStep(session.runId, 'tool', `⚙ ${label}${summary ? `（${summary}）` : ''}`, {
                      nodeId,
                    })
                  } else {
                    evidenceSteps.push({ kind, text })
                    addStep(session.runId, runKind, text, ...(nodeId ? [{ nodeId }] : []))
                  }
                },
              })
              return {
                runId: result.runId,
                outcome: result.outcome,
                summary: result.summary,
                error: result.error,
                ...(result.variables ? { variables: result.variables } : {}),
                // Node-aware failure evidence (spec §13): the actual failed
                // node from the real trace, so the repeat-dead-end signature
                // distinguishes different nodes instead of using 'session'.
                ...(result.trace?.failedNodeId ? { failedNodeId: result.trace.failedNodeId } : {}),
                steps: evidenceSteps.slice(-40),
              }
            })
          },
          createTakeover: ({ onEvent, onTakeover }) =>
            createAiTakeover({
              ...(scope ? { scope } : {}),
              ...(provider ? { provider } : {}),
              pinTab,
              // Global session retry budget (M2-12): cap takeover attempts
              // across the whole debug session, not just per node.
              takeoverBudget: takeoverMaxAttempts() * DEFAULT_MAX_ROUNDS,
              onEvent: (kind, text) => {
                // Agent tool steps get the 🤖 marker so they read apart from
                // engine steps in the session log; statuses pass through.
                onEvent(
                  kind,
                  kind === 'tool' || kind === 'result' || kind === 'error' ? `🤖 ${text}` : text,
                )
              },
              onTakeover: (report) => {
                onTakeover(report)
                if (!report.completed && report.reasonKind) lastReasonKind = report.reasonKind
                void recordTakeoverStat({
                  at: Date.now(),
                  workflowId: workflow.id,
                  nodeId: report.nodeId,
                  completed: report.completed,
                  attempts: report.attempts,
                  phase: 'takeover',
                  sessionId,
                  ...(report.reasonKind ? { reasonKind: report.reasonKind } : {}),
                  ...(typeof report.durationMs === 'number'
                    ? { durationMs: report.durationMs }
                    : {}),
                })
              },
            }),
          savePending: async (workflowId, runId, fixes) => {
            // Pending, NOT applied: the user confirms on the panel. Latest
            // session replaces earlier ones.
            await savePendingTakeover({
              workflowId,
              runId,
              fixes,
              createdAt: Date.now(),
              sessionId,
            })
          },
          ...(provider
            ? {
                goalCheck: async (
                  wf: Workflow,
                  evidence: {
                    runId: string
                    summary?: string
                    steps: { kind: string; text: string }[]
                    variables: Record<string, unknown>
                    runFailed?: boolean
                  },
                ) => {
                  // One-shot judge call: did this run actually complete the
                  // workflow's goal? `runFailed` switches the framing so a
                  // FAILED run is also tested for the terminal-state case
                  // (a login flow that already logged in can never re-run).
                  // An unavailable judge (throw/timeout/garbage) degrades to
                  // the no-error standard.
                  const result = await streamCompletion(
                    {
                      apiKey: provider.apiKey,
                      baseUrl: provider.baseUrl,
                      model: provider.model,
                      messages: [
                        {
                          role: 'user',
                          content: buildGoalCheckPrompt(wf, evidence, {
                            runFailed: evidence.runFailed === true,
                          }),
                        },
                      ],
                      headers: provider.headers,
                      signal: AbortSignal.timeout(GOAL_CHECK_TIMEOUT_MS),
                    },
                    {},
                  )
                  const verdict = parseGoalVerdict(stripThinkBlocks(result.content))
                  if (verdict) goalJudgeResponded = true
                  return verdict
                },
              }
            : {}),
          onDebugStep: (kind, text) => addStep(session.runId, kind, text),
        })
        debugResult = result
        finishRun(session.runId, {
          outcome: result.cancelled ? 'cancelled' : result.ok ? 'ok' : 'failed',
          summary: result.summary,
          ...(result.error ? { error: result.error } : {}),
        })
        return { type: 'workflows.debug', result }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        finishRun(session.runId, { outcome: 'failed', summary: text, error: text })
        throw error
      } finally {
        // Session telemetry, recorded on BOTH paths: an unreported hard failure
        // would silently inflate the success rate. `verified` is the strict
        // definition (takeover-free pass), never "the AI rescued it".
        const verified = debugResult?.verified === true
        const phaseOrder: DebugPhase[] = ['takeover', 'verify', 'replay', 'audit', 'rewrite-verify']
        const entered = phaseOrder.filter((phase) => (phases[phase] ?? 0) > 0)
        const failedPhase =
          verified || debugResult?.cancelled || !debugResult
            ? undefined
            : entered[entered.length - 1]
        void recordDebugSession({
          at: Date.now(),
          sessionId,
          workflowId: workflow.id,
          ok: debugResult?.ok === true,
          verified,
          goalAchieved: debugResult?.goalAchieved === true,
          judgeAvailable: goalJudgeResponded,
          rounds: debugResult?.rounds ?? 0,
          attempts: debugResult?.attempts ?? 0,
          durationMs: Date.now() - sessionStartedAt,
          phases,
          ...(failedPhase ? { failedPhase } : {}),
          ...(lastReasonKind ? { reasonKind: lastReasonKind } : {}),
        })
        release()
      }
    }

    case 'workflows.repair': {
      // Unified repair (spec §10). The same engine drives all three modes;
      // AI takeover is disabled for every execution. The formal workflow is
      // never replaced here — a verified working copy waits in memory until
      // the user sends workflows.repairCommit.
      const repairWorkflow = await getWorkflow(command.id)
      if (!repairWorkflow) throw new Error('Workflow not found.')
      const runner = createBackgroundRunner({
        executeWorkflow,
        ...(command.windowId !== undefined ? { scopeWindowId: command.windowId } : {}),
      })
      const settings = await getSettings()
      const modelConfig = takeoverProviderOf(settings)
      const proposer = modelConfig
        ? createAiRepairProposer({
            apiKey: modelConfig.apiKey,
            baseUrl: modelConfig.baseUrl,
            model: modelConfig.model,
            headers: modelConfig.headers,
          })
        : undefined

      retain()
      try {
        const result = await runUnifiedDebug(repairWorkflow, command.mode, {
          runner,
          // The repair engine needs a checkpoint store for replay planning.
          // Use the run-workflow module's real (synchronous) store: the
          // checkpoints were written during the just-finished execution.
          store: getCheckpointStore(),
          ...(proposer ? { propose: (ctx) => proposer.propose(ctx) } : {}),
          // Pass the user's explicit low-confidence acceptance through (P2).
          ...(command.confirmed ? { userConfirmed: true } : {}),
        })

        // A verified AUTO_REPAIR: keep the working copy for the commit step.
        if (command.mode === 'AUTO_REPAIR' && result.ok && result.workingCopy && result.patch) {
          putRepairSession({
            workflowId: repairWorkflow.id,
            workingCopy: result.workingCopy,
            patch: result.patch,
            analysis: result.analysis,
            verification: result.verification,
            // Optimistic-lock base (spec §11.3): bind the pending repair to the
            // formal workflow version + content it was produced against.
            baseUpdatedAt: repairWorkflow.updatedAt,
            baseHash: workflowFingerprintOf(repairWorkflow),
            baseRevision: currentRevisionOf(repairWorkflow),
            createdAt: Date.now(),
          })
        }

        return {
          type: 'workflows.repair',
          data: toRepairResponse(
            repairWorkflow.id,
            result.analysis,
            result.verification,
            command.mode,
            result.patch?.operations ?? [],
            {
              ok: result.ok,
              reason: result.reason,
              ...(result.needsConfirmation ? { needsConfirmation: true } : {}),
            },
          ),
        }
      } finally {
        release()
      }
    }

    case 'workflows.repairCommit': {
      // Formally save the verified repair working copy. The pending session
      // must exist and its working copy must have been verified WITHOUT AI
      // takeover (it is only ever stored after such a result).
      const pending = takeRepairSession(command.id)
      if (!pending) throw new Error('No verified repair to commit for this workflow.')

      // Optimistic lock (spec §11.3): re-read the formal workflow and verify it
      // has not changed since the repair was produced. A stale patch — one that
      // would overwrite newer edits — is refused together with its session, and
      // the user must re-run the diagnosis against the current workflow.
      const current = await getWorkflow(command.id)
      if (current) {
        if (current.updatedAt !== pending.baseUpdatedAt) {
          discardRepairSession(command.id)
          throw new Error(
            'The workflow changed since this repair was proposed; the patch is stale. Please run AI repair again.',
          )
        }
        if (workflowFingerprintOf(current) !== pending.baseHash) {
          discardRepairSession(command.id)
          throw new Error(
            'The workflow content changed since this repair was proposed; the patch is stale. Please run AI repair again.',
          )
        }
      }

      // Keep the revision sequence consistent even on the legacy commit path.
      const nextRevision = commitWorkflowRevision(pending.workingCopy, {
        source: 'ai-repair',
      })
      const repaired: Workflow = {
        ...pending.workingCopy,
        updatedAt: Date.now(),
        revision: nextRevision.revision,
        revisionHistory: nextRevision.revisionHistory,
      }
      await saveWorkflow(repaired)
      return { type: 'workflows.repairCommit' }
    }

    case 'workflows.repairDiscard': {
      const existed = discardRepairSession(command.id)
      if (!existed) {
        // Nothing in-memory (worker may have restarted): report honestly.
        return { type: 'workflows.repairDiscard' }
      }
      return { type: 'workflows.repairDiscard' }
    }

    case 'workflows.takeoverPending':
      return { type: 'workflows.takeoverPending', items: await listPendingTakeovers() }

    case 'workflows.takeoverStats':
      return { type: 'workflows.takeoverStats', summary: await summarizeTakeoverStats() }

    case 'workflows.debugStats':
      return { type: 'workflows.debugStats', summary: await summarizeDebugSessions() }

    case 'workflows.takeoverApply': {
      // Applies the PENDING AI-takeover fixes to the workflow — only ever on
      // the user's explicit confirmation from the panel. A pending WHOLE-GRAPH
      // rewrite (the debug audit path) replaces the graph instead of patching
      // individual params. After applying, an OPT-IN takeover-free verification
      // re-run (M1-10a) proves the patched node no longer errors.
      const pending = await getPendingTakeover(command.id)
      if (!pending || (pending.fixes.length === 0 && !pending.rewrite)) {
        throw new Error('No pending AI takeover fixes for this workflow.')
      }
      const workflow = await getWorkflow(command.id)
      if (!workflow) throw new Error('Workflow not found.')
      let applied = workflow
      let appliedCount = 0
      let rewriteRisk: import('../lib/workflow/rewrite-risk').RewriteRiskVerdict | undefined
      if (pending.rewrite) {
        // Risk gate (P2, spec §8.4): classify the whole-graph rewrite against
        // the current workflow before anything is written. CRITICAL rewrites
        // (trigger/goal removed, etc.) are refused until the user explicitly
        // accepts the risk via confirmedRisk.
        const candidate: Workflow = { ...pending.rewrite.workflow, id: workflow.id }
        rewriteRisk = classifyRewriteRisk(workflow, candidate)
        if (rewriteRisk.level === 'CRITICAL' && command.confirmedRisk !== true) {
          return {
            type: 'workflows.takeoverApply',
            workflow,
            appliedCount: 0,
            rewriteRisk: rewriteRisk.level,
            rewriteRiskReasons: rewriteRisk.reasons,
            riskConfirmationNeeded: true,
          }
        }
        applied = { ...pending.rewrite.workflow, id: workflow.id, updatedAt: Date.now() }
        appliedCount = pending.rewrite.changes.length
      } else {
        // LEGACY confirm path (spec §15 Phase 9): user-approved pending
        // takeover fixes are merged via the low-level graph op. This is the
        // one sanctioned direct patchNodeParams call outside PatchEngine; it
        // must be folded into PatchEngine when the old takeover pending format
        // is retired.
        const changes: string[] = []
        for (const fix of pending.fixes) {
          const result = patchNodeParams(applied, fix.nodeId, fix.paramsPatch)
          if (result.changed) {
            applied = result.workflow
            changes.push(...result.changes)
          }
        }
        appliedCount = changes.length
      }
      if (!pending.rewrite && appliedCount === 0) {
        // Nothing actually changed — no point saving or verifying.
        await clearPendingTakeover(command.id)
        return { type: 'workflows.takeoverApply', workflow, appliedCount: 0 }
      }
      applied.updatedAt = Date.now()
      {
        // Applying AI-takeover fixes is itself a formal commit (spec §18).
        const nextApplied = commitWorkflowRevision(applied, { source: 'ai-repair' })
        applied.revision = nextApplied.revision
        applied.revisionHistory = nextApplied.revisionHistory
      }
      await saveWorkflow(applied)
      await rescheduleAllWorkflowTriggers()
      await clearPendingTakeover(command.id)
      // M1-10(a): optional takeover-free verification after applying the fix.
      // Off by default and only when a live panel window is available, so we
      // never silently drive the browser for the user.
      let verified: boolean | undefined
      let verifySummary: string | undefined
      if (command.verify === true && scopeWindowId !== undefined) {
        try {
          const r = await executeWorkflow(applied, {
            source: 'manual',
            debug: false,
            scopeWindowId,
          })
          verified = r.outcome === 'ok'
          verifySummary = r.summary
        } catch (error) {
          verifySummary = error instanceof Error ? error.message : String(error)
        }
      }
      return {
        type: 'workflows.takeoverApply',
        workflow: applied,
        appliedCount,
        ...(rewriteRisk
          ? {
              rewriteRisk: rewriteRisk.level,
              ...(rewriteRisk.reasons.length ? { rewriteRiskReasons: rewriteRisk.reasons } : {}),
            }
          : {}),
        ...(verified !== undefined
          ? { verified, ...(verifySummary !== undefined ? { verifySummary } : {}) }
          : {}),
      }
    }

    case 'workflows.takeoverDiscard': {
      await clearPendingTakeover(command.id)
      return { type: 'workflows.takeoverDiscard' }
    }

    case 'workflows.running': {
      const boards = runningBoardsView((command as { workflowId?: string }).workflowId)
      return { type: 'workflows.running', ...boards }
    }

    case 'workflows.recovery': {
      // Single-entry recovery protocol (spec §11 · Commit 10/11). Drives the
      // unified engine: START runs Diagnose → Proposal automatically and pauses;
      // CONFIRM_REPAIR applies + verifies and pauses; CONFIRM_OVERWRITE commits;
      // CANCEL discards. De-dupe identical in-flight actions (double click).
      const key = `${command.requestId}:${command.action}`
      if (recoveryActionSeen.has(key)) {
        return recoveryEnvelopeResult(command, recoveryOutcomeFor(command.requestId),
          'duplicate action ignored', command.timestamp)
      }
      recoveryActionSeen.add(key)

      const targetWorkflow = await getWorkflow(command.workflowId)
      if (!targetWorkflow) throw new Error('Workflow not found.')

      if (command.action === 'CANCEL') {
        discardRepairSession(command.workflowId)
        rememberRecoveryOutcome(command.requestId, {
          phase: 'CANCELLED', status: 'done',
        })
        return recoveryEnvelopeResult(command,
          { phase: 'CANCELLED', status: 'done' }, 'recovery cancelled', command.timestamp)
      }

      // Engine dependencies (same construction as workflows.repair).
      const recoveryRunner = createBackgroundRunner({ executeWorkflow })
      const recoverySettings = await getSettings()
      const recoveryModel = takeoverProviderOf(recoverySettings)
      const recoveryProposer = recoveryModel
        ? createAiRepairProposer({
            apiKey: recoveryModel.apiKey,
            baseUrl: recoveryModel.baseUrl,
            model: recoveryModel.model,
            headers: recoveryModel.headers,
          })
        : undefined

      retain()
      try {
        if (command.action === 'START') {
          // Diagnose → Proposal, automatically and in sequence.
          const analysis = await runUnifiedDebug(targetWorkflow, 'ANALYZE', {
            runner: recoveryRunner,
            store: getCheckpointStore(),
          })
          if (analysis.ok) {
            const outcome = { phase: 'DONE', status: 'done' } as const
            rememberRecoveryOutcome(command.requestId, outcome)
            return recoveryEnvelopeResult(command, outcome, 'workflow already healthy', command.timestamp)
          }
          const suggestion = await runUnifiedDebug(targetWorkflow, 'SUGGEST', {
            runner: recoveryRunner,
            store: getCheckpointStore(),
            ...(recoveryProposer ? { propose: (ctx) => recoveryProposer.propose(ctx) } : {}),
          })
          if (!suggestion.patch) {
            const outcome = { phase: 'HUMAN_TAKEOVER', status: 'failed' } as const
            rememberRecoveryOutcome(command.requestId, outcome)
            return recoveryEnvelopeResult(command, outcome,
              suggestion.reason ?? 'no patch proposed', command.timestamp)
          }
          // Keep the patch for CONFIRM_REPAIR (no working copy applied yet).
          putRepairSession({
            workflowId: targetWorkflow.id,
            workingCopy: targetWorkflow,
            patch: suggestion.patch,
            analysis: suggestion.analysis,
            verification: suggestion.verification,
            baseUpdatedAt: targetWorkflow.updatedAt,
            baseHash: workflowFingerprintOf(targetWorkflow),
            baseRevision: currentRevisionOf(targetWorkflow),
            requestId: command.requestId,
            createdAt: Date.now(),
          })
          const summary = `proposal ready: ${suggestion.patch.operations.length} operation(s)`
          const outcome = { phase: 'AWAIT_REPAIR_CONFIRM', status: 'waiting' } as const
          rememberRecoveryOutcome(command.requestId, outcome)
          return recoveryEnvelopeResult(command, outcome, summary, command.timestamp,
            suggestion.patch.operations)
        }

        if (command.action === 'CONFIRM_REPAIR') {
          const pending = getRepairSession(command.workflowId)
          if (!pending?.patch) throw new Error('No repair proposal to apply.')
          // Apply + verify on a working copy via AUTO_REPAIR with explicit accept.
          const applied = await runUnifiedDebug(targetWorkflow, 'AUTO_REPAIR', {
            runner: recoveryRunner,
            store: getCheckpointStore(),
            ...(recoveryProposer ? { propose: (ctx) => recoveryProposer.propose(ctx) } : {}),
            userConfirmed: true,
          })
          if (!applied.ok || !applied.workingCopy || !applied.verification?.verified) {
            const outcome = { phase: 'FAILED', status: 'failed' } as const
            rememberRecoveryOutcome(command.requestId, outcome)
            return recoveryEnvelopeResult(command, outcome,
              applied.reason ?? 'the patched workflow did not verify on replay', command.timestamp)
          }
          putRepairSession({
            workflowId: targetWorkflow.id,
            workingCopy: applied.workingCopy,
            patch: pending.patch,
            analysis: applied.analysis,
            verification: applied.verification,
            baseUpdatedAt: targetWorkflow.updatedAt,
            baseHash: workflowFingerprintOf(targetWorkflow),
            baseRevision: pending.baseRevision,
            requestId: command.requestId,
            createdAt: Date.now(),
          })
          const outcome = { phase: 'AWAIT_OVERWRITE_CONFIRM', status: 'waiting' } as const
          rememberRecoveryOutcome(command.requestId, outcome)
          return recoveryEnvelopeResult(command, outcome,
            'repair verified; awaiting overwrite confirmation', command.timestamp)
        }

        // CONFIRM_OVERWRITE — commit the verified working copy.
        const pending = getRepairSession(command.workflowId)
        if (!pending?.workingCopy) throw new Error('No verified repair to commit.')
        const current = await getWorkflow(command.workflowId)
        if (current) {
          // Revision conflict: any concurrent commit (manual, generation or a
          // newer repair) moves the formal revision past the base.
          if (!revisionMatchesBase(current, pending.baseRevision)) {
            discardRepairSession(command.workflowId)
            throw new Error(
              'The workflow revision changed since this repair was proposed; the patch is stale. Please run AI repair again.',
            )
          }
          if (current.updatedAt !== pending.baseUpdatedAt) {
            discardRepairSession(command.workflowId)
            throw new Error('The workflow changed since this repair was proposed; the patch is stale.')
          }
          if (workflowFingerprintOf(current) !== pending.baseHash) {
            discardRepairSession(command.workflowId)
            throw new Error('The workflow content changed since this repair was proposed; the patch is stale.')
          }
        }
        const next = commitWorkflowRevision(pending.workingCopy, {
          source: 'ai-repair',
          repairSessionId: command.requestId,
        })
        const committed: Workflow = {
          ...pending.workingCopy,
          updatedAt: Date.now(),
          revision: next.revision,
          revisionHistory: next.revisionHistory,
        }
        await saveWorkflow(committed)
        discardRepairSession(command.workflowId)
        {
          const outcome = { phase: 'DONE', status: 'done' } as const
          rememberRecoveryOutcome(command.requestId, outcome)
          return recoveryEnvelopeResult(command, outcome,
            `workflow updated to revision ${next.revision}`, command.timestamp)
        }
      } finally {
        release()
      }
    }

    case 'record.start':
      // Recording is confined to the command's window scope when present
      // (the editor's host window); otherwise it stays global as before.
      await startRecording(scopeWindowId)
      return { type: 'record.start', recording: true }
    case 'record.stop': {
      // The recorder cleans up with the scope it STARTED with (state), so the
      // stop command carries no window.
      const workflowId = await stopRecording()
      return { type: 'record.stop', workflowId }
    }
    case 'record.status':
      return { type: 'record.status', recording: isRecording() }

    default: {
      const exhaustive: never = command
      throw new Error(`Unknown command: ${JSON.stringify(exhaustive)}`)
    }
  }
}

// --- Agent port --------------------------------------------------------------

/**
 * Guards against overlapping turns for one conversation.
 *
 * Module scope is safe here precisely because it is disposable: if the worker is
 * evicted, no turn can still be running, so an empty set is the correct state.
 * Durable data (the transcript) lives in session storage instead.
 */
const activeTurns = new Set<string>()

/**
 * Recovery action de-dupe keys (`requestId:ACTION`) for the in-flight recovery
 * protocol. Module scope is intentional: worker eviction cancels every in-flight
 * request, so a fresh empty map is correct after a restart.
 */
const recoveryActionSeen = new Set<string>()

/** Outcome last observed for a recovery request, for a duplicate-action echo. */
const recoveryOutcomes = new Map<
  string,
  { phase: RecoveryPhaseState; status: RecoveryProtocolStatus }
>()

function rememberRecoveryOutcome(
  requestId: string,
  outcome: { phase: RecoveryPhaseState; status: RecoveryProtocolStatus },
): void {
  recoveryOutcomes.set(requestId, outcome)
}

function recoveryOutcomeFor(requestId: string): {
  phase: RecoveryPhaseState
  status: RecoveryProtocolStatus
} {
  return recoveryOutcomes.get(requestId) ?? { phase: 'DIAGNOSING', status: 'running' }
}

type RecoveryCommand = Extract<Command, { type: 'workflows.recovery' }>

/** Build a workflows.recovery result echoing the request id and outcome. */
function recoveryEnvelopeResult(
  command: RecoveryCommand,
  outcome: { phase: RecoveryPhaseState; status: RecoveryProtocolStatus },
  summary: string,
  timestamp: number,
  operations?: RecoveryResultOperations,
): Extract<CommandResult, { type: 'workflows.recovery' }> {
  return {
    type: 'workflows.recovery',
    requestId: command.requestId,
    ...(typeof command.workflowRevision === 'number'
      ? { workflowRevision: command.workflowRevision }
      : {}),
    phase: outcome.phase,
    status: outcome.status,
    summary,
    timestamp,
    ...(operations && operations.length > 0 ? { operations } : {}),
  }
}

type RecoveryResultOperations =
  Extract<CommandResult, { type: 'workflows.recovery' }>['operations']

/**
 * Live in-memory transcripts of currently running turns, keyed by
 * conversation id (the same array object the turn mutates).
 *
 * The persisted transcript only updates when the turn finishes, so a panel
 * that reconnects mid-turn must replay THIS instead of storage to show what
 * the turn has produced so far. Disposable like `activeTurns`: worker
 * eviction ends every turn, so an empty map is the correct state.
 */
const liveHistories = new Map<string, WireMessage[]>()

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== AGENT_PORT) return

  // The side panel lives in a normal browser window: remember its window id so
  // chat turns scope to it, and register it so automatic visit-web triggers
  // stay quiet in the user's other windows. `port.sender.tab` is unreliable
  // for a window-level panel, so this is only a seed — the panel asserts its
  // real window right after connecting via `panel.hello`.
  let panelWindowId: number | undefined = port.sender?.tab?.windowId
  if (typeof panelWindowId === 'number') registerPanelWindow(panelWindowId, port)

  /** Pending confirmation resolvers, keyed by request id. */
  const pending = new Map<string, (approved: boolean) => void>()
  /**
   * Pending `ask_user` resolvers, keyed by request id. Resolves with the
   * user's typed/picked answer, or `cancelled: true` when the question can no
   * longer be answered (turn cancelled, panel closed).
   */
  const pendingAskUser = new Map<string, (answer: { answer: string; cancelled: boolean }) => void>()
  /**
   * Pending `present_plan` resolvers, keyed by request id. Resolves with the
   * user's approve/reject decision (rejection carries revision feedback), or
   * a rejected decision when the card can no longer be answered.
   */
  const pendingPlan = new Map<
    string,
    (decision: { approved: boolean; feedback?: string }) => void
  >()
  let controller: AbortController | null = null

  const send = (message: AgentServerMessage): void => {
    try {
      port.postMessage(message)
    } catch {
      // The panel closed mid-stream; nothing to do.
    }
  }

  port.onMessage.addListener((raw) => {
    const message = raw as AgentClientMessage

    // Heartbeat: receiving it is the point — it resets the worker idle timer.
    if (message.type === 'panel.hello') {
      // The panel stated its own window (a window-level UI has no reliable
      // sender.tab). Register it for the trigger guard and scope this panel's
      // turns; overrides any sender-derived guess.
      panelWindowId = message.windowId
      registerPanelWindow(message.windowId, port)
      // A connected panel means the plugin is expanded in this window: retire
      // a stale minimized mark (e.g. the user opened the panel from the
      // toolbar) and clear the page's floating button.
      if (isMinimized(message.windowId)) {
        expandWindow(message.windowId)
        void broadcastFloating(message.windowId, 'floating.hide')
      }
      send({ type: 'pong' })
      return
    }

    if (message.type === 'ping') {
      send({ type: 'pong' })
      return
    }

    if (message.type === 'confirm') {
      pending.get(message.requestId)?.(message.approved)
      pending.delete(message.requestId)
      return
    }

    if (message.type === 'ask_user.answer') {
      pendingAskUser.get(message.requestId)?.({
        answer: message.answer,
        cancelled: message.cancelled,
      })
      pendingAskUser.delete(message.requestId)
      return
    }

    if (message.type === 'plan.decision') {
      pendingPlan.get(message.requestId)?.({
        approved: message.approved,
        ...(message.feedback ? { feedback: message.feedback } : {}),
      })
      pendingPlan.delete(message.requestId)
      return
    }

    if (message.type === 'reset') {
      void clearConversation(message.conversationId)
      return
    }

    if (message.type === 'resume') {
      const conversationId = message.conversationId
      void (async () => {
        const [persisted, state] = await Promise.all([
          loadConversation(conversationId),
          getTurnState(conversationId),
        ])
        // While a turn is still running, prefer its live in-memory transcript:
        // the persisted copy only updates when the turn finishes, so replaying
        // storage would show a stale conversation without the in-flight work.
        const history = liveHistories.get(conversationId) ?? persisted
        // Replay every visible turn: user text, assistant text (including the
        // empty-content tool-call turns, which carry no text), and tool chips.
        // This is the full conversation the user saw, not a redacted summary,
        // so continuing a thread shows exactly where it left off.
        const messages = toRestoreMessages(history)

        send({
          type: 'restore',
          messages,
          // Trust the live set over stored state: if the worker was evicted and
          // respawned, no turn can actually still be running.
          running: activeTurns.has(conversationId),
        })
        if (state?.error && !activeTurns.has(conversationId)) {
          send({ type: 'error', message: state.error })
        }
      })()
      return
    }

    if (message.type === 'cancel') {
      controller?.abort()
      // Unblock anything waiting on a confirmation.
      for (const resolve of pending.values()) resolve(false)
      pending.clear()
      // …and on a pending clarifying question: nobody will answer it now.
      for (const resolve of pendingAskUser.values()) resolve({ answer: '', cancelled: true })
      pendingAskUser.clear()
      // …and on a pending plan card: rejected, so the model stops instead of
      // executing an unapproved plan.
      for (const resolve of pendingPlan.values()) resolve({ approved: false })
      pendingPlan.clear()
      return
    }

    if (message.type !== 'chat') return

    const conversationId = message.conversationId
    if (activeTurns.has(conversationId)) {
      send({ type: 'error', message: 'Still working on the previous message.' })
      return
    }

    activeTurns.add(conversationId)
    const turnController = new AbortController()
    controller = turnController
    // Re-validate panel-supplied attachments up front: drop malformed or
    // over-limit entries rather than failing the whole turn, and derive a
    // label so files-only messages are still identifiable on the tasks board.
    const sanitized = sanitizeAttachments(message.attachments)
    const attachmentLabel = sanitized.kept.map((attachment) => `[📎 ${attachment.name}]`).join(' ')
    // Surface this chat turn on the running-tasks board so it can be seen and
    // terminated from the Tasks tab. Reuse the turn's AbortController so the
    // board's cancel and the panel's cancel are the same signal.
    const trackedRun = startRun({
      label: (message.text || attachmentLabel).slice(0, 40),
      source: 'chat',
      controller: turnController,
    })
    const sendWithTracking = (msg: AgentServerMessage): void => {
      send(msg)
      if (msg.type === 'tool.start') recordStep('tool', `→ ${msg.name}`, trackedRun.runId)
      else if (msg.type === 'tool.result')
        recordStep('result', `← ${msg.summary}`, trackedRun.runId)
      else if (msg.type === 'status') recordStep('status', msg.text, trackedRun.runId)
      else if (msg.type === 'error') recordStep('error', msg.message, trackedRun.runId)
    }
    // Hold the worker open for the whole turn, so collapsing the panel does not
    // kill work in progress.
    retain()
    void setTurnState({ conversationId, running: true, at: Date.now() })

    void (async () => {
      let history: WireMessage[] = []
      let failure: string | undefined
      try {
        sendWithTracking({ type: 'phase', phase: 'preparing' })
        history = await loadConversation(conversationId)
        // Register the live transcript so a panel that reconnects mid-turn
        // (minimize/expand, crash, worker recycle) resumes the CURRENT state,
        // not the last persisted snapshot. Deregistered in `finally` below.
        liveHistories.set(conversationId, history)

        // Scope the whole turn to the panel's own window, resolved once up
        // front: selection reading, /run workflows and every agent tool call
        // share it. A window that died before the turn started (or an unknown
        // one) degrades to undefined = legacy global resolution.
        const scope = await normalScopeFromWindowId(panelWindowId)

        let text = message.text
        let grantedPageUrl: string | undefined
        if (message.includeSelection) {
          sendWithTracking({ type: 'phase', phase: 'reading-page' })
          try {
            // Scoped: read the selection in the PANEL's window — the focused
            // window may be another one the user is browsing by hand.
            const page = await readActiveSelection(scope)
            if (page.selection.trim().length > 0) {
              grantedPageUrl = page.url
              text =
                `Content selected on the page I am viewing:\n` +
                `Title: ${page.title}\nURL: ${page.url}\n` +
                `Selection:\n${page.selection}\n\n` +
                `My question: ${message.text}`
            } else {
              sendWithTracking({
                type: 'status',
                text: 'Nothing is selected on the page — sent your message without a selection.',
              })
            }
          } catch (error) {
            sendWithTracking({
              type: 'status',
              text: `Could not read the selection: ${
                error instanceof Error ? error.message : String(error)
              }`,
            })
          }
        }

        // When a skill is pinned for this turn, bind its directive directly to
        // the user's message. The full instructions are in the system prompt,
        // but an imperative wrapper next to the user's own text makes the model
        // far less likely to ignore or refuse the skill.
        if (message.skillId) {
          const pinned = await getSkill(message.skillId)
          if (pinned) text = wrapSkillDirective(pinned, text)
        }

        // Report anything dropped during sanitization before the turn proper,
        // so the panel can show why an attachment is missing from the message.
        for (const rejected of sanitized.rejected) {
          sendWithTracking({
            type: 'status',
            text: `Skipped attachment: ${rejectionMessage(rejected.name, rejected.code)}`,
          })
        }

        history.push({
          role: 'user',
          content: text,
          // Keep the raw panel text for replay/UI: `text` may carry the
          // skill directive and the page-selection envelope, which are
          // model-facing only and must not be rendered as the user's message.
          displayContent: message.text,
          ...(sanitized.kept.length ? { attachments: sanitized.kept } : {}),
        })
        // Persist metadata so the conversation appears in the history list;
        // fall back to an attachment-derived label for files-only messages.
        await touchConversation(conversationId, message.text || attachmentLabel)

        // Slash-command interception: `/run <workflow>` executes a saved
        // workflow directly instead of feeding the message to the model. On a
        // match we report the outcome and finish the turn before `runAgentTurn`
        // runs; the surrounding try/finally still persists the conversation and
        // finishes the tracked run exactly once.
        const runMatch = /^\/run\s+(.+)$/.exec(message.text.trim())
        if (runMatch) {
          const nameOrId = runMatch[1]!.trim()
          const wf = (await listWorkflows()).find(
            (w) => w.id === nameOrId || w.name.toLowerCase() === nameOrId.toLowerCase(),
          )
          if (!wf) {
            throw new Error(`工作流不存在：${nameOrId}`)
          }
          sendWithTracking({ type: 'phase', phase: 'sending' })
          // /run from the panel acts inside the panel's window too.
          const result = await executeWorkflow(wf, {
            source: 'chat',
            ...(scope ? { scopeWindowId: scope.windowId } : {}),
          })
          if (result.outcome === 'ok') {
            sendWithTracking({
              type: 'status',
              text: result.summary || `工作流「${wf.name}」执行完成。`,
            })
          } else if (result.outcome === 'cancelled') {
            sendWithTracking({ type: 'status', text: '工作流已终止。' })
          } else {
            sendWithTracking({ type: 'error', message: result.summary || '工作流执行失败。' })
          }
          sendWithTracking({ type: 'done' })
          return
        }

        // The mode is read freshly per action (see AgentDeps.getMode), so a
        // switch in the panel takes effect on the next tool call within the
        // same turn. We still read once here so the system prompt reflects
        // the mode at turn start.
        const getMode = async () => (await getSettings()).mode
        const getMaxToolRounds = async () => (await getSettings()).maxToolRounds
        const getToolConfig = async () => {
          const s = await getSettings()
          return {
            disabledTools: s.disabledTools ?? [],
            basePrompt: s.systemPromptOverride ?? '',
          }
        }
        sendWithTracking({ type: 'phase', phase: 'sending' })
        const turnUsage = await runAgentTurn(history, {
          send: sendWithTracking,
          signal: turnController.signal,
          // Panel conversations get the supervisor/delegation machinery;
          // unattended entry points leave this off.
          enableDelegation: true,
          ...(message.skillId ? { skillId: message.skillId } : {}),
          ...(grantedPageUrl ? { grantedPageUrl } : {}),
          ...(scope ? { scopeWindowId: scope.windowId } : {}),
          conversationId,
          getMode,
          getMaxToolRounds,
          getToolConfig,
          confirm: (name, argsPreview) =>
            new Promise<boolean>((resolve) => {
              const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              pending.set(requestId, resolve)
              send({ type: 'confirm.request', requestId, name, argsPreview })
            }),
          // ask_user uses the port-level `send` (not sendWithTracking), like
          // `confirm`, so delegated sub-agents inherit a working question
          // channel: their muted `deps.send` drops progress messages, but the
          // question card must still reach the panel.
          askUser: ({ question, options }) =>
            new Promise<{ answer: string; cancelled: boolean }>((resolve) => {
              const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              pendingAskUser.set(requestId, resolve)
              send({ type: 'ask_user.request', requestId, question, options })
            }),
          // present_plan rides the same port-level `send` as ask_user so
          // delegated sub-agents inherit a working approval channel; the plan
          // card must reach the panel even when the specialist's progress
          // stream is muted.
          planDecision: ({ goal, steps, risks, split }) =>
            new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
              const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              pendingPlan.set(requestId, resolve)
              send({
                type: 'plan.request',
                requestId,
                goal,
                steps,
                ...(risks ? { risks } : {}),
                ...(split ? { split } : {}),
              })
            }),
        })
        sendWithTracking({ type: 'done', ...(turnUsage ? { usage: turnUsage } : {}) })
      } catch (error) {
        failure =
          error instanceof LlmError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error)
        sendWithTracking({ type: 'error', message: failure })
      } finally {
        // Persist whatever was accumulated, including partial tool exchanges, so
        // an interrupted turn does not lose the conversation. A failed save is
        // surfaced rather than silently swallowed: losing a transcript the user
        // just watched being written is worth one status line.
        if (history.length > 0) {
          try {
            await saveConversation(conversationId, history)
          } catch (saveError) {
            sendWithTracking({
              type: 'status',
              text: `Could not save this conversation: ${
                saveError instanceof Error ? saveError.message : String(saveError)
              }`,
            })
          }
        }
        await setTurnState({
          conversationId,
          running: false,
          at: Date.now(),
          ...(failure ? { error: failure } : {}),
        }).catch(() => {})
        activeTurns.delete(conversationId)
        liveHistories.delete(conversationId)
        // The turn's stream went to the port that existed when it started; a
        // panel reopened mid-turn is watching a different (or no) port and
        // would otherwise sit on a stale snapshot with a busy spinner forever.
        // Broadcast the end so any panel showing this conversation re-pulls
        // the final transcript (including the answer produced after reopen).
        void chrome.runtime
          .sendMessage({ type: 'conversation.ended', conversationId })
          .catch(() => {})
        finishRun(trackedRun.runId, {
          outcome: turnController.signal.aborted ? 'cancelled' : failure ? 'failed' : 'ok',
          summary: failure,
        })
        if (controller === turnController) controller = null
        release()
      }
    })()
  })

  port.onDisconnect.addListener(() => {
    // Deliberately does NOT abort an in-flight turn. The panel disconnects both
    // when the user closes it and when the worker is recycled, and in either
    // case the right behaviour is to let the stream finish and persist, so the
    // answer is waiting in the transcript afterwards.
    //
    // Confirmations are the exception: nobody can answer them once the panel is
    // gone, so they resolve as declined instead of hanging until the turn caps.
    for (const resolve of pending.values()) resolve(false)
    pending.clear()
    // Same for pending clarifying questions: nobody can answer them now.
    for (const resolve of pendingAskUser.values()) resolve({ answer: '', cancelled: true })
    pendingAskUser.clear()
    // Same for pending plan cards: nobody can approve them now.
    for (const resolve of pendingPlan.values()) resolve({ approved: false })
    pendingPlan.clear()
    // The window keeps hosting a panel only while at least one of its ports is
    // connected; dropping ours may retire it from the trigger guard.
    unregisterPort(port)
  })
})
