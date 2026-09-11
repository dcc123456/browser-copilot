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
import { Circle, Download, Plus, Square, Trash2, Upload } from 'lucide-react'
import { sendCommand } from '../lib/messages'
import type { TaskRunLog } from '../lib/scheduler-types'
import type { Workflow } from '../lib/workflow/types'
import type { WorkflowDebugResult } from '../lib/workflow/auto-debug-patch'
import { debugRunLabel } from '../lib/workflow/ai-takeover'
import type { TakeoverReasonKind } from '../lib/workflow/ai-takeover'
import type { TakeoverStatsSummary } from '../lib/workflow/takeover-stats'
import type { PendingTakeoverInfo } from '../lib/workflow/takeover-pending'
import type { RunStep } from '../background/running-tasks'
import { newId } from '../lib/storage'
import { useT } from './i18n'
import { confirmDialog } from '../ui/confirm'

/**
 * Localized label for a classified takeover failure reason (stats line).
 * Falls back to the raw reason for unknown values.
 */
function reasonLabelOf(
  reason: TakeoverReasonKind | 'unclassified',
  t: ReturnType<typeof useT>,
): string {
  switch (reason) {
    case 'auth':
      return t.workflowsDebugReasonAuth
    case 'captcha':
      return t.workflowsDebugReasonCaptcha
    case 'notfound':
      return t.workflowsDebugReasonNotfound
    case 'timeout':
      return t.workflowsDebugReasonTimeout
    case 'network':
      return t.workflowsDebugReasonNetwork
    case 'other':
      return t.workflowsDebugReasonOther
    default:
      return t.workflowsDebugReasonUnclassified
  }
}

/**
 * Effective launch type for the list chip: the trigger BLOCK inside the graph
 * is the source of truth edited in the visual editor; the top-level
 * `wf.trigger` is a denormalized mirror (older records may only have that).
 * Mirrors background `effectiveTriggerKind` without importing worker modules.
 */
function effectiveTriggerType(wf: Workflow): string {
  const node = wf.drawflow.nodes.find(
    (n) => (n.data?.['blockId'] as string) === 'trigger' || n.label === 'trigger',
  )
  const fromBlock = node?.data?.['type']
  return (typeof fromBlock === 'string' && fromBlock) || wf.trigger?.type || 'manual'
}

/**
 * The primary "new" action with its sibling Import entry folded into a hover
 * bubble. Hover/focus opens it for mouse/keyboard users; tapping the button
 * toggles it so touch screens can reach both entries. The transparent padding
 * bridge between button and card keeps the pointer inside the wrapper while
 * moving down, so the bubble never closes mid-way.
 *
 * `!` utilities are REQUIRED on the menu items: sidepanel/styles.css styles
 * bare `button` elements with UNLAYERED rules that beat Tailwind's layered
 * utilities in the cascade (same note as ChatTab's ToolbarIconButton).
 */
function NewWorkflowMenu({
  disabled,
  t,
  onNew,
  onImport,
}: {
  disabled: boolean
  t: ReturnType<typeof useT>
  onNew: () => void
  onImport: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close on outside pointer-down / Escape (deferred listeners, same trick as
  // the chat download menu, so the opening click doesn't immediately close).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointerDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const itemClass =
    'flex w-full cursor-pointer items-center gap-2 rounded-md! border-0! bg-transparent! px-2.5! py-1.5! ' +
    'text-left text-[12.5px] text-ink! hover:bg-hover!'

  return (
    <div
      ref={wrapRef}
      className="relative flex"
      onBlur={(event) => {
        if (!wrapRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
      onFocus={() => setOpen(true)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t.workflowsNew}
        className="primary section-action wf-icon-action"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title={t.workflowsNew}
        type="button"
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-50 min-w-[128px] pt-1.5"
          role="menu"
        >
          <div className="flex flex-col rounded-lg border border-border bg-panel p-1 shadow-[var(--bc-shadow)]">
            <button
              className={itemClass}
              onClick={() => {
                setOpen(false)
                onNew()
              }}
              role="menuitem"
              type="button"
            >
              <Plus size={13} className="shrink-0 text-muted" aria-hidden="true" />
              {t.workflowsNew}
            </button>
            <button
              className={itemClass}
              onClick={() => {
                setOpen(false)
                onImport()
              }}
              role="menuitem"
              type="button"
            >
              <Upload size={13} className="shrink-0 text-muted" aria-hidden="true" />
              {t.workflowsImport}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

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
  // Workflows with pending AI-takeover fixes (apply / discard chip).
  const [pending, setPending] = useState<PendingTakeoverInfo[]>([])

  const load = useCallback(async () => {
    try {
      const [workflowResult, runsResult, pendingResult] = await Promise.all([
        sendCommand({ type: 'workflows.list' }),
        sendCommand({ type: 'tasks.runs' }),
        sendCommand({ type: 'workflows.takeoverPending' }),
      ])
      if (workflowResult.type === 'workflows.list') setWorkflows(workflowResult.workflows)
      if (runsResult.type === 'tasks.runs') setRuns(runsResult.runs)
      if (pendingResult.type === 'workflows.takeoverPending') setPending(pendingResult.items)
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
  // Lifetime takeover stats (fetched once per settled debug session) for the
  // success-rate line at the bottom of the debug log modal.
  const [takeoverStats, setTakeoverStats] = useState<TakeoverStatsSummary | null>(null)
  const debuggingNameRef = useRef('')
  const debugStartedAtRef = useRef(0)
  const logOpenRef = useRef(false)
  const logBodyRef = useRef<HTMLDivElement | null>(null)

  const openLog = (): void => {
    logOpenRef.current = true
    setLogOpen(true)
    setTakeoverStats(null)
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

  /**
   * Multi-line list of the pending AI-takeover fixes, shown in the confirm
   * dialog: one bullet per node with WHAT the AI changed.
   */
  const formatPendingFixes = (r: WorkflowDebugResult): string => {
    return r.pendingChanges.map((fix) => `· ${fix.note}`).join('\n')
  }

  /**
   * AI takeover debug (AI 调试): run the workflow once. When a node fails the
   * AI takes over that node — it looks at the live page and completes the
   * step's purpose — then the remaining nodes keep running (up to 3 takeover
   * attempts per node). The workflow itself is only changed AFTER the user
   * confirms the AI's proposed node fixes.
   * The session streams into the live log modal as it works.
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
        const completedTakeovers = r.takeovers.filter((t) => t.completed).length
        if (r.ok && r.rewrite) {
          // The replay+audit path rebuilt the whole graph and the rebuild
          // passed its own takeover-free verify run.
          setBanner({
            kind: 'ok',
            text: t.workflowsDebugRewriteVerified({ count: r.rewrite.changes.length }),
          })
        } else if (r.ok && r.verified && completedTakeovers === 0) {
          setBanner({ kind: 'ok', text: r.summary || t.workflowsDebugOkNoChanges })
        } else if (r.ok && r.verified) {
          // The verify run (no AI) passed: the fixes genuinely work on their own.
          setBanner({
            kind: 'ok',
            text: t.workflowsDebugVerified({ count: r.pendingChanges.length }),
          })
        } else if (r.ok) {
          // Passed via AI but the fixes failed (or skipped) verification.
          setBanner({ kind: 'ok', text: t.workflowsDebugNotVerified })
        } else if (r.cancelled) {
          setBanner({ kind: 'error', text: t.taskOutcomeCancelled })
        } else {
          // Failed debug banner keeps the deep-link into the session's
          // history entry; when the audit ran, the summary IS the diagnosis.
          setBanner({
            kind: 'error',
            text: r.summary || t.workflowsDebugFailed,
            ...(r.lastRunId ? { runId: r.lastRunId } : {}),
          })
        }
        // The audit rebuilt the workflow: ask the user to apply the new
        // version (a whole-graph swap on confirm). Nothing was written yet.
        if (r.ok && r.rewrite) {
          const confirmed = await confirmDialog({
            title: t.workflowsDebugRewriteConfirmTitle,
            message: `${t.workflowsDebugRewriteConfirmMessage({ diagnosis: r.rewrite.diagnosis })}\n\n${r.rewrite.changes.map((change) => `· ${change}`).join('\n')}`,
            confirmText: t.workflowsDebugRewriteApply,
            cancelText: t.workflowsDebugTakeoverDiscard,
          })
          if (confirmed) {
            try {
              const applyResult = await sendCommand({ type: 'workflows.takeoverApply', id })
              if (applyResult.type === 'workflows.takeoverApply') {
                setBanner({
                  kind: 'ok',
                  text:
                    applyResult.appliedCount > 0
                      ? t.workflowsDebugRewriteApplied
                      : t.workflowsDebugTakeoverNothing,
                })
              }
            } catch (error) {
              setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
            }
          } else {
            await sendCommand({ type: 'workflows.takeoverDiscard', id }).catch(() => undefined)
            setBanner({ kind: 'ok', text: t.workflowsDebugTakeoverDiscarded })
          }
        } else if (r.pendingChanges.length > 0) {
          // The AI completed steps AND proposed node fixes: ask the user to
          // apply them. Nothing was written to the workflow before this point.
          const confirmed = await confirmDialog({
            title: t.workflowsDebugTakeoverConfirmTitle,
            message: `${t.workflowsDebugTakeoverConfirmMessage}\n\n${formatPendingFixes(r)}`,
            confirmText: t.workflowsDebugTakeoverApply,
            cancelText: t.workflowsDebugTakeoverDiscard,
          })
          if (confirmed) {
            try {
              const applyResult = await sendCommand({ type: 'workflows.takeoverApply', id })
              if (applyResult.type === 'workflows.takeoverApply') {
                setBanner({
                  kind: 'ok',
                  text:
                    applyResult.appliedCount > 0
                      ? t.workflowsDebugTakeoverApplied
                      : t.workflowsDebugTakeoverNothing,
                })
              }
            } catch (error) {
              setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
            }
          } else {
            await sendCommand({ type: 'workflows.takeoverDiscard', id }).catch(() => undefined)
            setBanner({ kind: 'ok', text: t.workflowsDebugTakeoverDiscarded })
          }
        }
      }
      await load()
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      // One last poll so a still-open modal shows the session's final steps.
      await pollDebugRun()
      // Refresh the lifetime takeover stats for the modal's success-rate line.
      try {
        const stats = await sendCommand({ type: 'workflows.takeoverStats' })
        if (stats.type === 'workflows.takeoverStats') setTakeoverStats(stats.summary)
      } catch {
        /* stats line is best-effort */
      }
      setBusy(false)
      setDebuggingId(null)
    }
  }

  /**
   * Pending chip actions: apply the AI's proposed fixes (or the audit's
   * whole-graph rewrite — the takeover session may have settled while the
   * panel was closed) or discard them.
   */
  const applyPendingFixes = async (id: string): Promise<void> => {
    const info = pending.find((entry) => entry.workflowId === id)
    const detail = info?.rewrite
      ? info.rewrite.changes.map((change) => `· ${change}`).join('\n')
      : (info?.fixes.map((fix) => `· ${fix.note}`).join('\n') ?? '')
    const message = info
      ? `${info.rewrite ? t.workflowsDebugRewriteConfirmMessage({ diagnosis: info.rewrite.diagnosis }) : t.workflowsDebugTakeoverConfirmMessage}\n\n${detail}`
      : t.workflowsDebugTakeoverConfirmMessage
    const confirmed = await confirmDialog({
      title: info?.rewrite
        ? t.workflowsDebugRewriteConfirmTitle
        : t.workflowsDebugTakeoverConfirmTitle,
      message,
      confirmText: info?.rewrite ? t.workflowsDebugRewriteApply : t.workflowsDebugTakeoverApply,
      cancelText: t.workflowsDebugTakeoverDiscard,
    })
    if (!confirmed) return
    setBusy(true)
    try {
      const result = await sendCommand({ type: 'workflows.takeoverApply', id })
      if (result.type === 'workflows.takeoverApply') {
        setBanner({
          kind: 'ok',
          text: info?.rewrite ? t.workflowsDebugRewriteApplied : t.workflowsDebugTakeoverApplied,
        })
      }
      await load()
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const discardPendingFixes = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await sendCommand({ type: 'workflows.takeoverDiscard', id })
      setBanner({ kind: 'ok', text: t.workflowsDebugTakeoverDiscarded })
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
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      await load()
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  // --- Batch delete -----------------------------------------------------------
  // Checked workflow ids. The set may briefly hold ids that no longer exist
  // (deleted elsewhere); every consumer intersects it with the live list, so
  // stale ids never render or get re-deleted.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const toggleSelected = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = workflows.length > 0 && workflows.every((wf) => selectedIds.has(wf.id))

  const toggleSelectAll = (on: boolean): void => {
    setSelectedIds(on ? new Set(workflows.map((wf) => wf.id)) : new Set())
  }

  /** Ids that are BOTH checked and still listed — the effective selection. */
  const effectiveSelection = workflows.filter((wf) => selectedIds.has(wf.id)).map((wf) => wf.id)

  const removeSelected = async (): Promise<void> => {
    const ids = effectiveSelection
    if (ids.length === 0) return
    const ok = await confirmDialog({
      title: t.dialogDeleteTitle,
      message: t.workflowsBatchDeleteConfirm({ count: ids.length }),
      confirmText: t.delete,
      cancelText: t.cancel,
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    let deleted = 0
    try {
      // Sequential on purpose: each delete also reschedules triggers in the
      // worker; a failed one aborts the loop and surfaces its error.
      for (const id of ids) {
        await sendCommand({ type: 'workflows.delete', id })
        deleted += 1
      }
      setBanner({ kind: 'ok', text: t.workflowsBatchDeleteDone({ count: deleted }) })
    } catch (error) {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSelectedIds(new Set())
      await load()
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

  const triggerLabel = (triggerType: string | undefined): string => {
    switch (triggerType) {
      case 'manual':
        return t.workflowsTriggerManual
      case 'scheduled':
        return t.workflowsTriggerScheduled
      case 'interval':
        return t.workflowsTriggerInterval
      case 'date':
        return t.workflowsTriggerDate
      case 'specific-day':
        return t.workflowsTriggerSpecificDay
      case 'on-startup':
        return t.workflowsTriggerStartup
      case 'keyboard-shortcut':
        return t.workflowsTriggerShortcut
      case 'element-change':
        return t.workflowsTriggerElementChange
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
            <label className="wf-select-all" title={t.workflowsSelectAll}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(event) => toggleSelectAll(event.target.checked)}
              />
              {t.workflowsSelectAll}
            </label>
          )}
          {effectiveSelection.length > 0 && (
            <button
              className="section-action danger wf-icon-action"
              disabled={busy}
              onClick={() => void removeSelected()}
              type="button"
              title={t.workflowsBatchDelete}
              aria-label={t.workflowsBatchDelete}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          )}
          {workflows.length > 0 && (
            <button
              className="section-action wf-icon-action"
              disabled={busy}
              onClick={exportAll}
              type="button"
              title={t.workflowsExport}
              aria-label={t.workflowsExport}
            >
              <Download size={14} aria-hidden="true" />
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            style={{ display: 'none' }}
            onChange={(event) => {
              // Reset after import so selecting the same file again still
              // fires onChange (e.g. re-import after fixing the JSON).
              void importFiles(event.target.files).finally(() => {
                event.target.value = ''
              })
            }}
          />
          <button
            className={`section-action wf-icon-action${recording ? ' record-active' : ''}`}
            disabled={busy}
            onClick={() => void toggleRecording()}
            type="button"
            title={recording ? '停止录制并生成工作流' : '录制页面操作'}
            aria-label={recording ? '停止录制并生成工作流' : '录制页面操作'}
          >
            {recording ? (
              <Square size={14} aria-hidden="true" />
            ) : (
              <Circle size={14} aria-hidden="true" />
            )}
          </button>
          <NewWorkflowMenu
            disabled={busy}
            onImport={() => fileInputRef.current?.click()}
            onNew={() => openEditor()}
            t={t}
          />
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
                  {/* Checkbox + name in one LEFT group: .task-item-head is
                      space-between, so a bare third child would push the name
                      to the middle. The status chip stays on the right. */}
                  <div className="task-item-lead">
                    <label className="wf-item-check" title={t.workflowsSelectAll}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(wf.id)}
                        onChange={() => toggleSelected(wf.id)}
                      />
                    </label>
                    <strong className="task-item-name">{wf.name}</strong>
                  </div>
                  <span className={`task-status task-status-${!last ? 'none' : last.skipped ? 'skipped' : last.ok ? 'ok' : 'failed'}`}>
                    {lastRunLabel(wf)}
                  </span>
                </div>
                <div className="task-meta">
                  <span className="task-chip">{triggerLabel(effectiveTriggerType(wf))}</span>
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
                  const pendingInfo = pending.find((entry) => entry.workflowId === wf.id)
                  if (!pendingInfo) return null
                  return (
                    <div className="ai-debug-backup">
                      <span>
                        {t.workflowsDebugTakeoverPendingHint({
                          time: new Date(pendingInfo.createdAt).toLocaleString(navigator.language),
                          changes: pendingInfo.fixes.length,
                        })}
                      </span>
                      <button disabled={busy} onClick={() => void applyPendingFixes(wf.id)} type="button">
                        {t.workflowsDebugTakeoverApply}
                      </button>
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() => void discardPendingFixes(wf.id)}
                        type="button"
                      >
                        {t.workflowsDebugTakeoverDiscard}
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
            {debugSettled && takeoverStats && (
              <p className="mb-0 mt-3 flex-none text-[11.5px] leading-relaxed text-muted">
                {t.workflowsDebugStats({
                  rate: Math.round(takeoverStats.successRate * 100),
                  total: takeoverStats.total,
                })}
                {takeoverStats.byReason.length > 0 &&
                  ` · ${takeoverStats.byReason
                    .slice(0, 2)
                    .map((entry) => `${reasonLabelOf(entry.reason, t)} ×${entry.count}`)
                    .join(' · ')}`}
              </p>
            )}
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
