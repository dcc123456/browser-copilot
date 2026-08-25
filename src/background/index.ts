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
import { validateProfile } from '../lib/providers'
import { normalizeSkill, validateSkill } from '../lib/skills'
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
  touchConversation,
} from '../lib/storage'
import { runAgentTurn, summarizeToolResult } from './agent'
import { activeTab, readActivePage } from './page'
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
import { rescheduleAll, scheduleTask, triggerNow, onAlarm } from './scheduler'
import { FeishuBot, FEISHU_WATCHDOG_ALARM } from './feishu-bot'
import { isWebhookUrl, sendWebhookText } from '../lib/feishu'
import {
  addStep,
  cancelRun,
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
})

// A worker update/startup must also reconcile alarms: chrome.alarms persist across
// restarts, but code may have changed and a stale enabled flag needs correcting.
chrome.runtime.onStartup.addListener(() => {
  void rescheduleAll().catch((error: unknown) =>
    console.error('[Browser Copilot] could not reschedule tasks', error),
  )
  void feishuBot.reconcile()
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

// --- Command channel ---------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      const data = await handleCommand(message as Command)
      sendResponse({ ok: true, data } satisfies CommandResponse)
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies CommandResponse)
    }
  })()
  // Keeps the response channel open for the async work above.
  return true
})

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
    case 'tasks.running': {
      const mapFinished = (r: ReturnType<typeof listFinished>[number]) => ({
        runId: r.runId,
        taskId: r.taskId,
        label: r.label,
        source: r.source,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        outcome: r.outcome,
        summary: r.summary,
        steps: r.steps,
      })
      return {
        type: 'tasks.running',
        runs: listRunning().map((r) => ({
          runId: r.runId,
          taskId: r.taskId,
          label: r.label,
          source: r.source,
          startedAt: r.startedAt,
          steps: r.steps,
        })),
        finished: listFinished().map(mapFinished),
      }
    }
    case 'tasks.cancel':
      return { type: 'tasks.cancel', ok: cancelRun(command.runId) }

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
        history = await loadConversation(conversationId)

        let text = message.text
        let grantedPageUrl: string | undefined
        if (message.includePage) {
          sendWithTracking({ type: 'status', text: 'Reading the current page…' })
          try {
            const page = await readActivePage()
            grantedPageUrl = page.url
            text =
              `Context from the page I am viewing:\n` +
              `Title: ${page.title}\nURL: ${page.url}\n` +
              (page.selection ? `Selected text: ${page.selection}\n` : '') +
              `Body${page.truncated ? ' (truncated)' : ''}:\n${page.text}\n\n` +
              `My question: ${message.text}`
          } catch (error) {
            sendWithTracking({
              type: 'status',
              text: `Could not read the page: ${
                error instanceof Error ? error.message : String(error)
              }`,
            })
          }
        }

        history.push({ role: 'user', content: text })
        // Persist metadata so the conversation appears in the history list.
        await touchConversation(conversationId, message.text)

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
