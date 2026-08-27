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
import { retain, release } from './keepalive'
import {
  AGENT_PORT,
  type AgentClientMessage,
  type AgentServerMessage,
  type Command,
  type CommandResponse,
  type CommandResult,
} from '../lib/messages'
import { isInjectablePage } from '../lib/pages'
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
  setWorkflowRunner,
} from './workflow-triggers'
import { validateProfile } from '../lib/providers'
import { normalizeSkill, validateSkill, wrapSkillDirective } from '../lib/skills'
import {
  clearConversation,
  clearHistory,
  deleteConversation,
  deleteHistory,
  deletePassword,
  deleteProfile,
  deleteProvider,
  deleteSkill,
  ensureSchema,
  getTurnState,
  listConversations,
  listHistory,
  listPasswords,
  listProfiles,
  listSkills,
  loadConversation,
  renameConversation,
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
import { runAgentTurn, summarizeToolResult } from './agent'
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
import {
  listWorkflows,
  getWorkflow,
  saveWorkflow,
  deleteWorkflow,
} from '../lib/workflow/storage'
import { executeWorkflow } from './workflow-engine/run-workflow'
import { rescheduleAll, scheduleTask, triggerNow, onAlarm } from './scheduler'
import { FeishuBot, FEISHU_WATCHDOG_ALARM } from './feishu-bot'
import { isWebhookUrl, sendWebhookText } from '../lib/feishu'
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
} from './running-tasks'

// Persist every finished run (with its steps) so the run log survives a worker
// eviction/restart. finishRun calls this synchronously; recordFinishedRun is
// async but fire-and-forget here.
setFinishedPersister((run: FinishedTask) => {
  void recordFinishedRun({
    runId: run.runId,
    taskId: run.taskId,
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
          label: r.label ?? r.summary?.slice(0, 40) ?? '',
          source: r.source ?? (r.trigger === 'feishu' ? 'feishu' : r.trigger === 'manual' ? 'manual' : 'schedule'),
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
  void rescheduleAll().catch((error: unknown) =>
    console.error('[Browser Copilot] could not reschedule tasks', error),
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
  void rescheduleAll().catch((error: unknown) =>
    console.error('[Browser Copilot] could not reschedule tasks', error),
  )
  void feishuBot.reconcile()
  // Run workflows whose trigger block is "on-startup".
  void startupWorkflows()
    .then((wfs) => {
      for (const wf of wfs) void runWorkflowKeepalive(wf.id)
    })
    .catch((error: unknown) =>
      console.error('[Browser Copilot] on-startup workflows failed', error),
    )
  void initShortcutTriggers()
})

// Also fire on-startup workflows once when the service worker boots after install.
chrome.runtime.onInstalled.addListener(() => {
  void startupWorkflows()
    .then((wfs) => {
      for (const wf of wfs) void runWorkflowKeepalive(wf.id)
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
 */
async function runWorkflowKeepalive(workflowId: string): Promise<void> {
  const wf = await getWorkflow(workflowId)
  if (!wf) return
  retain()
  try {
    await executeWorkflow(wf, { source: 'manual' })
  } finally {
    release()
  }
}

// Let the trigger module launch workflows (keyboard-shortcut triggers).
setWorkflowRunner((workflowId) => {
  void runWorkflowKeepalive(workflowId)
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
            (w.trigger.menuItemId !== undefined ? w.trigger.menuItemId === info.menuItemId : w.id === info.menuItemId),
        )
        if (wf) await runWorkflowKeepalive(wf.id)
      } catch (error) {
        console.error('[Browser Copilot] context-menu workflow failed', error)
      }
    })()
  })
}

// Visit-web workflows: fire when a matching page commits navigation. Defensive —
// ignore any scheme other than http(s), and fall back to substring matching if
// the stored pattern is not a valid regular expression.
if (chrome.webNavigation?.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    void (async () => {
      try {
        const url = details.url
        if (!/^https?:/i.test(url)) return
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
        if (wf) await runWorkflowKeepalive(wf.id)
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
void rescheduleAll().catch((error: unknown) =>
  console.error('[Browser Copilot] could not reschedule tasks', error),
)
void feishuBot.reconcile()

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
void chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {})

chrome.action.onClicked.addListener((tab) => {
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

// --- Message channel ---------------------------------------------------------
//
// Exactly ONE onMessage listener: special protocols (element picker, workflow
// recording events, keyboard-shortcut triggers) are claimed BEFORE the generic
// command switch. Previously each had its own listener, so a non-command
// message (e.g. picker:start) ALSO reached the command handler, which threw
// "Unknown command" and raced the real response — the root cause of the picker
// error and flaky run/record buttons.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
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
      if (await handleShortcutPressed(message)) {
        sendResponse({ ok: true })
        return
      }

      // 4. Generic command channel (workflows.*, settings, skills, ...).
      const data = await handleCommand(message as Command)
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
  runs: { runId: string; taskId?: string; workflowId?: string; label: string; source: ReturnType<typeof listRunning>[number]['source']; startedAt: number; steps: ReturnType<typeof listRunning>[number]['steps'] }[]
  finished: { runId: string; taskId?: string; workflowId?: string; label: string; source: ReturnType<typeof listFinished>[number]['source']; startedAt: number; finishedAt: number; outcome: ReturnType<typeof listFinished>[number]['outcome']; summary?: string; error?: string; steps: ReturnType<typeof listFinished>[number]['steps'] }[]
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
      })),
    finished: listFinished().filter(matches).map(mapFinished),
  }
}

async function handleCommand(command: Command): Promise<CommandResult> {
  switch (command.type) {
    case 'settings.get':
      return { type: 'settings', settings: await getSettings() }

    case 'settings.set':
      return { type: 'settings', settings: await setSettings(command.patch) }

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
      return { type: 'skills.save', skill: normalized }
    }

    case 'skills.delete':
      await deleteSkill(command.id)
      return { type: 'skills.delete' }

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
        page: await readActivePage(command.maxChars),
      }

    case 'page.check': {
      const tab = await activeTab()
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
        (async () =>
          (await listConversations()).find((entry) => entry.id === command.id))(),
        loadConversation(command.id),
      ])
      const visible = messages
        .filter(
          (entry): entry is { role: 'user' | 'assistant'; content: string } =>
            (entry.role === 'user' || entry.role === 'assistant') &&
            typeof entry.content === 'string' &&
            entry.content.trim().length > 0,
        )
        .map((entry) => ({ role: entry.role, text: entry.content }))
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

    case 'workflows.save':
      await saveWorkflow(command.workflow)
      return { type: 'workflows.save' }

    case 'workflows.delete':
      await deleteWorkflow(command.id)
      return { type: 'workflows.delete' }

    case 'workflows.run': {
      const workflow = await getWorkflow(command.id)
      if (!workflow) throw new Error('Workflow not found.')
      const r = await executeWorkflow(workflow, { source: 'manual' })
      return {
        type: 'workflows.run',
        outcome: {
          ok: r.outcome === 'ok',
          skipped: false,
          summary: r.summary ?? '',
          error: r.outcome === 'failed' ? r.summary : undefined,
        },
      }
    }

    case 'workflows.running': {
      const boards = runningBoardsView((command as { workflowId?: string }).workflowId)
      return { type: 'workflows.running', ...boards }
    }

    case 'record.start':
      await startRecording()
      return { type: 'record.start', recording: true }
    case 'record.stop': {
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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== AGENT_PORT) return

  /** Pending confirmation resolvers, keyed by request id. */
  const pending = new Map<string, (approved: boolean) => void>()
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
    if (message.type === 'ping') {
      send({ type: 'pong' })
      return
    }

    if (message.type === 'confirm') {
      pending.get(message.requestId)?.(message.approved)
      pending.delete(message.requestId)
      return
    }

    if (message.type === 'reset') {
      void clearConversation(message.conversationId)
      return
    }

    if (message.type === 'resume') {
      const conversationId = message.conversationId
      void (async () => {
        const [history, state] = await Promise.all([
          loadConversation(conversationId),
          getTurnState(conversationId),
        ])
        // Replay every visible turn: user text, assistant text (including the
        // empty-content tool-call turns, which carry no text), and tool chips.
        // This is the full conversation the user saw, not a redacted summary,
        // so continuing a thread shows exactly where it left off.
        // Build a tool_call_id -> tool name map from the assistant turns, so a
        // replayed tool result can be labeled with its action instead of dumped
        // as raw JSON. The stored tool content is the raw result string; the
        // human-readable chip is regenerated here the same way live turns do.
        const toolNames = new Map<string, string>()
        for (const entry of history) {
          if (entry.role !== 'assistant' || !entry.tool_calls) continue
          for (const call of entry.tool_calls) {
            if (call.id && call.function?.name) toolNames.set(call.id, call.function.name)
          }
        }
        const messages: { role: 'user' | 'assistant' | 'tool'; text: string }[] = history
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
            }
          })

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
    // Surface this chat turn on the running-tasks board so it can be seen and
    // terminated from the Tasks tab. Reuse the turn's AbortController so the
    // board's cancel and the panel's cancel are the same signal.
    const trackedRun = startRun({
      label: message.text.slice(0, 40),
      source: 'chat',
      controller: turnController,
    })
    const sendWithTracking = (msg: AgentServerMessage): void => {
      send(msg)
      if (msg.type === 'tool.start') recordStep('tool', `→ ${msg.name}`, trackedRun.runId)
      else if (msg.type === 'tool.result') recordStep('result', `← ${msg.summary}`, trackedRun.runId)
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

        let text = message.text
        let grantedPageUrl: string | undefined
        if (message.includeSelection) {
          sendWithTracking({ type: 'phase', phase: 'reading-page' })
          try {
            const page = await readActiveSelection()
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

        history.push({ role: 'user', content: text })
        // Persist metadata so the conversation appears in the history list.
        await touchConversation(conversationId, message.text)

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
          const result = await executeWorkflow(wf, { source: 'chat' })
          if (result.outcome === 'ok') {
            sendWithTracking({ type: 'status', text: result.summary || `工作流「${wf.name}」执行完成。` })
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
          ...(message.skillId ? { skillId: message.skillId } : {}),
          ...(grantedPageUrl ? { grantedPageUrl } : {}),
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
        // an interrupted turn does not lose the conversation.
        if (history.length > 0) {
          await saveConversation(conversationId, history).catch(() => {})
        }
        await setTurnState({
          conversationId,
          running: false,
          at: Date.now(),
          ...(failure ? { error: failure } : {}),
        }).catch(() => {})
        activeTurns.delete(conversationId)
        finishRun(trackedRun.runId, {
          outcome: turnController.signal.aborted
            ? 'cancelled'
            : failure
              ? 'failed'
              : 'ok',
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
  })
})
