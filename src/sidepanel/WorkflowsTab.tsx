/**
 * Workflows tab: list/run/edit/delete workflows.
 *
 * Workflows are node-graph automations persisted in the worker. The visual
 * editor lives in its own page (`src/workflow-editor/index.html`) opened in a
 * new tab; this panel is the management surface — create, run, delete, and see
 * each workflow's last-run status. Live run progress and the full run history
 * now live in the History tab's activity board (see `RunningBoard.tsx`).
 *
 * @module sidepanel/WorkflowsTab
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { sendCommand } from '../lib/messages'
import type { TaskRunLog } from '../lib/scheduler-types'
import type { Workflow, WorkflowTrigger } from '../lib/workflow/types'
import type { DebugRound, DebugStrategy, WorkflowDebugResult } from '../lib/workflow/auto-debug-patch'
import type { DebugBackupInfo } from '../lib/workflow/debug-backup'
import type { RunStep } from '../background/running-tasks'
import { debugRunLabel } from '../background/workflow-engine/auto-debug'
import { newId } from '../lib/storage'
import { useT } from './i18n'
import { alertDialog, confirmDialog } from '../ui/confirm'

export default function WorkflowsTab() {
  const t = useT()
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [runs, setRuns] = useState<TaskRunLog[]>([])
  // A failed-run banner carries its run id so clicking it deep-links into the
  // History tab with that run's detail expanded. Plain info/error banners
  // (import results, failed deletes…) leave `runId` undefined and stay
  // dismiss-only.
  const [banner, setBanner] = useState<{
    kind: 'ok' | 'error'
    text: string
    runId?: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  // Workflows with a pending AI-debug snapshot (keep / revert review chip).
  const [backups, setBackups] = useState<DebugBackupInfo[]>([])

  const load = useCallback(async () => {
    try {
      const [workflowResult, runsResult, backupsResult] = await Promise.all([
        sendCommand({ type: 'workflows.list' }),
        sendCommand({ type: 'tasks.runs' }),
        sendCommand({ type: 'workflows.debugBackups' }),
      ])
      if (workflowResult.type === 'workflows.list') setWorkflows(workflowResult.workflows)
      if (runsResult.type === 'tasks.runs') setRuns(runsResult.runs)
      if (backupsResult.type === 'workflows.debugBackups') setBackups(backupsResult.backups)
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Auto-refresh when workflows are added/edited/deleted externally (e.g.
  // saved from ChatTab's "save as workflow" prompt or imported in bulk).
  useEffect(() => {
    const handler = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ): void => {
      if (area === 'local' && changes['workflows']) void load()
    }
    chrome.storage.onChanged.addListener(handler)
    return () => chrome.storage.onChanged.removeListener(handler)
  }, [load])

  // Lightweight refresh so a workflow run launched elsewhere updates the
  // last-run status chip without the user having to re-open the tab. Live
  // progress / cancellation still lives in the History tab's activity board;
  // here we only poll persisted state.
  const lastLoadRef = useRef(0)
  useEffect(() => {
    const timer = setInterval(() => {
      // Avoid stacking requests when the worker is slow.
      if (Date.now() - lastLoadRef.current > 4000) {
        lastLoadRef.current = Date.now()
        void load()
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [load])

  const runNow = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await sendCommand({ type: 'workflows.run', id })
      if (result.type === 'workflows.run') {
        if (result.outcome.ok) {
          setBanner({
            kind: 'ok',
            text: result.outcome.summary || t.taskOutcomeOk,
          })
        } else {
          // A failed run banner is clickable: it jumps to the History tab and
          // expands this exact run so the error details are one click away.
          setBanner({
            kind: 'error',
            text: `${result.outcome.summary || result.outcome.error || t.taskStatusFailed} · ${t.workflowsRunFailedHint}`,
            runId: result.outcome.runId,
          })
        }
      }
      await load()
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  /** Id of the workflow currently inside the AI debug loop (button shows it). */
  const [debuggingId, setDebuggingId] = useState<string | null>(null)
  // Live debug-log modal: polls the running-tasks board for the wrapped
  // "AI 调试: …" session run while a debug is in flight, so the user watches
  // the AI work instead of waiting silently.
  const [logOpen, setLogOpen] = useState(false)
  const [debugSteps, setDebugSteps] = useState<RunStep[]>([])
  const [debugSettled, setDebugSettled] = useState(false)
  const debuggingNameRef = useRef('')
  const debugStartedAtRef = useRef(0)
  const logOpenRef = useRef(false)
  const logBodyRef = useRef<HTMLDivElement | null>(null)

  const openLog = (): void => {
    logOpenRef.current = true
    setLogOpen(true)
  }
  const closeLog = (): void => {
    logOpenRef.current = false
    setLogOpen(false)
  }

  // Keep the log body pinned to the newest step while it is open.
  useEffect(() => {
    if (!logOpen) return
    const body = logBodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [debugSteps, logOpen])

  const pollDebugRun = useCallback(async (): Promise<void> => {
    try {
      const result = await sendCommand({ type: 'tasks.running' })
      if (result.type !== 'tasks.running') return
      const label = debugRunLabel(debuggingNameRef.current)
      const since = debugStartedAtRef.current - 1000
      const running = result.runs.find((r) => r.label === label && r.startedAt >= since)
      const finished = result.finished.find((r) => r.label === label && r.startedAt >= since)
      if (finished) {
        setDebugSteps(finished.steps)
        setDebugSettled(true)
      } else if (running) {
        setDebugSteps(running.steps)
        setDebugSettled(false)
      }
    } catch {
      /* polling is best-effort */
    }
  }, [])

  // Poll the board while a debug session is in flight.
  useEffect(() => {
    if (!debuggingId) return
    void pollDebugRun()
    const timer = setInterval(() => void pollDebugRun(), 1500)
    return () => clearInterval(timer)
  }, [debuggingId, pollDebugRun])

  const strategyLabel = (strategy: DebugStrategy): string => {
    switch (strategy) {
      case 'retry':
        return t.workflowsDebugStrategyRetry
      case 'repair-params':
        return t.workflowsDebugStrategyFix
      case 'insert-branch':
        return t.workflowsDebugStrategyBranch
      case 'insert-ai-agent':
        return t.workflowsDebugStrategyAgent
      case 'remove-redundant':
        return t.workflowsDebugStrategyRemove
      case 'unfixable':
        return t.workflowsDebugStrategyUnfixable
    }
  }

  const roundOutcomeLabel = (outcome: DebugRound['runOutcome']): string => {
    switch (outcome) {
      case 'ok':
        return t.taskOutcomeOk
      case 'cancelled':
        return t.taskOutcomeCancelled
      default:
        return t.taskOutcomeFailed
    }
  }

  /** Multi-line AI debug report shown after a debug session settles. */
  const formatDebugReport = (r: WorkflowDebugResult): string => {
    const lines: string[] = []
    r.rounds.forEach((round, index) => {
      lines.push(`${t.workflowsDebugRound({ n: index + 1 })} · ${strategyLabel(round.strategy)}`)
      lines.push(`${t.workflowsDebugDiagnosis}: ${round.diagnosis || '—'}`)
      if (round.changes.length > 0) {
        lines.push(`${t.workflowsDebugChanges}:`)
        for (const change of round.changes) lines.push(`· ${change}`)
      }
      lines.push(`${t.workflowsDebugOutcome}: ${roundOutcomeLabel(round.runOutcome)}`)
      lines.push('')
    })
    if (r.error) lines.push(r.error)
    return lines.join('\n').trim()
  }

  /**
   * AI auto-debug: run once; on failure the model diagnoses and repairs the
   * graph (retry policy / params / guards / AI steps / redundant-node removal)
   * and the repaired workflow is saved and re-run, at most two fix rounds.
   * Every attempt lands on the History activity board as its own tracked run,
   * and the live log modal streams the AI's steps while it works.
   */
  const debugNow = async (id: string, name: string): Promise<void> => {
    debuggingNameRef.current = name
    debugStartedAtRef.current = Date.now()
    setDebugSteps([])
    setDebugSettled(false)
    setDebuggingId(id)
    setBusy(true)
    openLog()
    try {
      const result = await sendCommand({ type: 'workflows.debug', id })
      if (result.type === 'workflows.debug') {
        const r = result.result
        const appliedRounds = r.rounds.filter((round) => round.strategy !== 'unfixable').length
        if (r.ok && !r.workflowModified) {
          setBanner({ kind: 'ok', text: r.summary || t.workflowsDebugOkNoChanges })
        } else if (r.ok) {
          setBanner({ kind: 'ok', text: t.workflowsDebugFixed({ rounds: appliedRounds }) })
        } else {
          // Failed debug banner keeps the deep-link into the last attempt's
          // history entry (same pattern as a plain failed run).
          setBanner({
            kind: 'error',
            text: r.summary || t.workflowsDebugFailed,
            ...(r.lastRunId ? { runId: r.lastRunId } : {}),
          })
        }
        // The live log modal already shows the whole session; only pop the
        // structured report when the user has closed (or never opened) it.
        if ((r.rounds.length > 0 || r.workflowModified) && !logOpenRef.current) {
          void alertDialog({
            title: t.workflowsDebugReportTitle,
            message: formatDebugReport(r),
            confirmText: t.dialogConfirm,
          })
        }
      }
      await load()
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      // One last poll so a still-open modal shows the session's final steps.
      await pollDebugRun()
      setBusy(false)
      setDebuggingId(null)
    }
  }

  /**
   * Review chip actions: keep the AI changes (drop the snapshot) or revert
   * the whole workflow to its pre-debug snapshot.
   */
  const keepAiChanges = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await sendCommand({ type: 'workflows.debugKeep', id })
      await load()
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const revertAiChanges = async (id: string): Promise<void> => {
    const confirmed = await confirmDialog({
      title: t.workflowsDebugBackupRevert,
      message: t.workflowsDebugRevertConfirm,
      confirmText: t.dialogConfirm,
      cancelText: t.cancel,
    })
    if (!confirmed) return
    setBusy(true)
    try {
      await sendCommand({ type: 'workflows.debugRevert', id })
      setBanner({ kind: 'ok', text: t.workflowsDebugReverted })
      await load()
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Clicking a failed-run banner deep-links to the History tab: App flips to
   * the tab on `bc:open-history`, and HistoryTab's own listener expands the
   * run card. Non-run banners (no runId) just dismiss.
   */
  const onBannerClick = (): void => {
    if (banner?.runId) {
      window.dispatchEvent(
        new CustomEvent('bc:open-history', { detail: { section: 'workflowRuns', runId: banner.runId } }),
      )
    }
    setBanner(null)
  }

  const removeWorkflow = async (id: string): Promise<void> => {
    const ok = await confirmDialog({
      title: t.dialogDeleteTitle,
      message: t.workflowsDeleteConfirm,
      confirmText: t.delete,
      cancelText: t.cancel,
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await sendCommand({ type: 'workflows.delete', id })
      await load()
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const editorUrl = (id?: string): string =>
    chrome.runtime.getURL(
      'src/workflow-editor/index.html' + (id ? `?edit=${encodeURIComponent(id)}` : ''),
    )

  /**
   * The workflow editor opens in a standalone popup window (no address bar /
   * browser chrome), matching Automa's separate editor window. A regular tab is
   * used as a fallback if popup creation is unavailable.
   *
   * The opener's window id is appended as `hostWindow=<id>`: the editor popup
   * itself can never be a valid automation scope (it is a popup-type
   * chrome-extension window), so it carries THIS panel's window and every
   * run/record/pick it performs is pinned to that window.
   */
  const openEditor = (id?: string): void => {
    void (async () => {
      const hostId = await chrome.windows
        .getCurrent()
        .then((win) => (typeof win?.id === 'number' ? win.id : undefined))
        .catch(() => undefined)
      const base = editorUrl(id)
      const url =
        hostId !== undefined
          ? `${base}${base.includes('?') ? '&' : '?'}hostWindow=${hostId}`
          : base
      void chrome.windows
        ?.create?.({ url, type: 'popup', width: 1280, height: 860 })
        ?.catch?.(() => chrome.tabs.create({ url }))
      // Fallback for environments where `chrome.windows` is unavailable.
      if (!chrome.windows?.create) void chrome.tabs.create({ url })
    })()
  }

  const [recording, setRecording] = useState(false)

  const refreshRecording = useCallback(async () => {
    try {
      const result = await sendCommand({ type: 'record.status' })
      if (result.type === 'record.status') setRecording(result.recording)
    } catch {
      /* recorder not available until background controller lands */ }
  }, [])

  useEffect(() => {
    void refreshRecording()
  }, [refreshRecording])

  const toggleRecording = async (): Promise<void> => {
    setBusy(true)
    try {
      if (recording) {
        const result = await sendCommand({ type: 'record.stop' })
        if (result.type === 'record.stop' && result.workflowId) {
          openEditor(result.workflowId)
        }
      } else {
        await sendCommand({ type: 'record.start' })
        setRecording(true)
      }
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
      void refreshRecording()
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null)

  const downloadJSON = (filename: string, data: unknown): void => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const exportWorkflow = (wf: Workflow): void => {
    downloadJSON(`${(wf.name || 'workflow').replace(/[\\/:*?"<>|]/g, '-')}.json`, wf)
  }

  const exportAll = (): void => {
    downloadJSON('workflows.json', workflows)
  }

  const importFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return
    setBusy(true)
    let imported = 0
    let invalid = false
    try {
      for (const file of Array.from(files)) {
        try {
          const text = await file.text()
          const parsed: unknown = JSON.parse(text)
          const batch: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
          for (const raw of batch) {
            const wf = coerceImportedWorkflow(raw)
            if (!wf) {
              invalid = true
              continue
            }
            await sendCommand({ type: 'workflows.save', workflow: wf })
            imported += 1
          }
        } catch {
          invalid = true
        }
      }
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
      setBusy(false)
      return
    }
    setBusy(false)
    if (invalid && imported === 0) {
      setBanner({ kind: 'error', text: t.workflowsImportInvalid })
    } else if (imported > 0) {
      const message = invalid
        ? `${t.workflowsImported({ count: imported })} ${t.workflowsImportInvalid}`
        : t.workflowsImported({ count: imported })
      setBanner({ kind: 'ok', text: message })
    }
    await load()
  }

  const triggerLabel = (triggerType: WorkflowTrigger['type'] | undefined): string => {
    switch (triggerType) {
      case 'manual':
        return t.workflowsTriggerManual
      case 'scheduled':
        return t.workflowsTriggerScheduled
      case 'context-menu':
        return t.workflowsTriggerContextMenu
      case 'visit-web':
        return t.workflowsTriggerVisitWeb
      case 'github':
        return t.workflowsTriggerGithub
      case 'feishu':
        return t.workflowsTriggerFeishu
      default:
        return t.workflowsTriggerNone
    }
  }

  /** Most recent persisted run for a workflow, or null when it never ran. */
  const lastRunFor = (wf: Workflow): { time: number; ok: boolean; skipped: boolean } | null => {
    let best: TaskRunLog | null = null
    for (const run of runs) {
      if (run.label !== wf.name) continue
      const at = run.finishedAt ?? run.at
      const bestAt = best ? (best.finishedAt ?? best.at) : -1
      if (at > bestAt) best = run
    }
    if (!best) return null
    return { time: best.finishedAt ?? best.at, ok: best.ok, skipped: best.skipped }
  }

  const lastRunLabel = (wf: Workflow): string => {
    const last = lastRunFor(wf)
    if (!last) return t.workflowsRunStatusNever
    if (last.skipped) return t.taskOutcomeSkipped
    return last.ok ? t.taskOutcomeOk : t.taskOutcomeFailed
  }

  return (
    <div className="pane workflows-tab">
      <h2>{t.tabWorkflows}</h2>

      {banner && (
        <div
          className={`banner banner-${banner.kind}${banner.runId ? ' banner-link' : ''}`}
          data-kind={banner.kind}
          role="status"
          onClick={onBannerClick}
          title={banner.runId ? t.workflowsRunFailedHint : undefined}
        >
          <span className="banner-text">{banner.text}</span>
          {banner.runId && <span className="banner-chevron" aria-hidden="true">›</span>}
        </div>
      )}

      <div className="section-head">
        <h3>{t.tabWorkflows}</h3>
        <div className="section-actions">
          {workflows.length > 0 && (
            <button className="section-action" disabled={busy} onClick={exportAll} type="button">
              {t.workflowsExport}
            </button>
          )}
          <button
            className="section-action"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            {t.workflowsImport}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            style={{ display: 'none' }}
            onChange={(event) => void importFiles(event.target.files)}
          />
          <button
            className={`section-action${recording ? ' record-active' : ''}`}
            disabled={busy}
            onClick={() => void toggleRecording()}
            type="button"
            title={recording ? '停止录制并生成工作流' : '录制页面操作'}
          >
            {recording ? '■ 停止录制' : '● 录制'}
          </button>
          <button
            className="primary section-action"
            disabled={busy}
            onClick={() => openEditor()}
            type="button"
          >
            + {t.workflowsNew}
          </button>
        </div>
      </div>

      {workflows.length === 0 ? (
        <div className="empty-state">
          <p>{t.workflowsEmpty}</p>
        </div>
      ) : (
        <ul className="task-list">
          {workflows.map((wf) => {
            const last = lastRunFor(wf)
            return (
              <li className="task-item" key={wf.id}>
                <div className="task-item-head">
                  <strong className="task-item-name">{wf.name}</strong>
                  <span className={`task-status task-status-${!last ? 'none' : last.skipped ? 'skipped' : last.ok ? 'ok' : 'failed'}`}>
                    {lastRunLabel(wf)}
                  </span>
                </div>
                <div className="task-meta">
                  <span className="task-chip">{triggerLabel(wf.trigger?.type)}</span>
                  {wf.description && <span className="task-lastrun">{wf.description}</span>}
                </div>
                {last && (
                  <div className="task-lastrun">
                    {t.workflowsLastRun}: {new Date(last.time).toLocaleString(navigator.language)}
                  </div>
                )}
                <div className="actions task-actions">
                  <button
                    className="task-action-run"
                    disabled={busy}
                    onClick={() => void runNow(wf.id)}
                    type="button"
                  >
                    {t.workflowsRunNow}
                  </button>
                  <button
                    className="task-action-debug"
                    disabled={busy && debuggingId !== wf.id}
                    title={debuggingId === wf.id ? t.workflowsDebugLogTitle : undefined}
                    onClick={() => {
                      // While this workflow is debugging the button reopens
                      // the live log; otherwise it starts a debug session.
                      if (debuggingId === wf.id) {
                        openLog()
                      } else {
                        void debugNow(wf.id, wf.name)
                      }
                    }}
                    type="button"
                  >
                    {debuggingId === wf.id ? t.workflowsDebugging : t.workflowsDebug}
                  </button>
                  <button disabled={busy} onClick={() => openEditor(wf.id)} type="button">
                    {t.workflowsEdit}
                  </button>
                  <button disabled={busy} onClick={() => exportWorkflow(wf)} type="button">
                    {t.workflowsExport}
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => void removeWorkflow(wf.id)}
                    type="button"
                  >
                    {t.delete}
                  </button>
                </div>
                {(() => {
                  const backup = backups.find((b) => b.workflowId === wf.id)
                  if (!backup) return null
                  return (
                    <div className="ai-debug-backup">
                      <span>
                        {t.workflowsDebugBackupHint({
                          time: new Date(backup.savedAt).toLocaleString(navigator.language),
                          changes: backup.changes.length,
                        })}
                      </span>
                      <button disabled={busy} onClick={() => void keepAiChanges(wf.id)} type="button">
                        {t.workflowsDebugBackupKeep}
                      </button>
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() => void revertAiChanges(wf.id)}
                        type="button"
                      >
                        {t.workflowsDebugBackupRevert}
                      </button>
                    </div>
                  )
                })()}
              </li>
            )
          })}
        </ul>
      )}

      {logOpen && (
        <div
          className="fixed inset-0 z-[1000] flex items-start justify-center p-4 pt-[6vh]"
          role="presentation"
        >
          <div
            className="absolute inset-0 bg-slate-950/55 backdrop-blur-[2px]"
            onClick={closeLog}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t.workflowsDebugLogTitle}
            className="relative flex max-h-[84vh] w-full max-w-[440px] flex-col rounded-xl border border-border bg-panel p-4 shadow-[var(--bc-shadow)]"
          >
            <div className="flex flex-none items-center justify-between gap-3">
              <h3 className="m-0 text-[14px] font-semibold leading-snug text-ink">
                {t.workflowsDebugLogTitle}
              </h3>
              <span
                className={`flex-none rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  debugSettled ? 'bg-panel-2 text-muted' : 'bg-accent-soft text-accent'
                }`}
              >
                {debugSettled ? t.workflowsDebugLogDone : t.workflowsDebugLogLive}
              </span>
            </div>
            {/* flex-1 + min-h-0: the only reliable flex scroll layout — the
                body shrinks to the panel's max height and scrolls alone. */}
            <div
              ref={logBodyRef}
              className="debug-log-scroll mt-3 flex min-h-[72px] flex-1 flex-col gap-1.5 overflow-y-auto pr-1"
            >
              {debugSteps.length === 0 && (
                <p className="m-0 text-[12.5px] text-muted">{t.workflowsDebugLogEmpty}</p>
              )}
              {debugSteps.map((step, index) => (
                <div
                  key={`${step.at}-${index}`}
                  className="flex gap-2 border-b border-border/60 pb-1.5 text-[12px] leading-relaxed"
                >
                  <span className="flex-none tabular-nums text-muted">
                    {new Date(step.at).toLocaleTimeString(navigator.language, { hour12: false })}
                  </span>
                  <span
                    className={
                      step.kind === 'error'
                        ? 'text-err'
                        : step.kind === 'result'
                          ? 'text-accent'
                          : 'text-ink'
                    }
                  >
                    {step.text}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-none justify-end">
              <button
                type="button"
                onClick={closeLog}
                className="h-8 cursor-pointer rounded-lg border border-accent bg-accent px-3.5 text-[13px] font-semibold text-on-accent transition-colors duration-150 hover:bg-accent-strong"
              >
                {t.workflowsDebugLogClose}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Validates an arbitrary imported value into a workflow record, assigning a
 * fresh id and timestamps so it never collides with an existing workflow.
 * Returns `null` when the record lacks the name + drawflow graph every workflow
 * needs.
 */
function coerceImportedWorkflow(raw: unknown): Workflow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Partial<Workflow>
  if (
    typeof w.name !== 'string' ||
    !w.drawflow ||
    typeof w.drawflow !== 'object' ||
    !Array.isArray(w.drawflow.nodes)
  ) {
    return null
  }
  const now = Date.now()
  return {
    ...(w as Workflow),
    id: newId(),
    name: w.name.trim() || 'Imported workflow',
    createdAt: now,
    updatedAt: now,
  }
}
