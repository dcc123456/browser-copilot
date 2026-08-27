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
import { newId } from '../lib/storage'
import { useT } from './i18n'

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

  const load = useCallback(async () => {
    try {
      const [workflowResult, runsResult] = await Promise.all([
        sendCommand({ type: 'workflows.list' }),
        sendCommand({ type: 'tasks.runs' }),
      ])
      if (workflowResult.type === 'workflows.list') setWorkflows(workflowResult.workflows)
      if (runsResult.type === 'tasks.runs') setRuns(runsResult.runs)
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
    if (!confirm(t.workflowsDeleteConfirm)) return
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
   */
  const openEditor = (id?: string): void => {
    const url = editorUrl(id)
    void chrome.windows
      ?.create?.({ url, type: 'popup', width: 1280, height: 860 })
      ?.catch?.(() => chrome.tabs.create({ url }))
    // Fallback for environments where `chrome.windows` is unavailable.
    if (!chrome.windows?.create) void chrome.tabs.create({ url })
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
              </li>
            )
          })}
        </ul>
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
