import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { sendCommand, type WindowChoice } from '../lib/messages'
import { LOCALE_LABELS, LOCALES, type LocaleSetting, type Messages } from '../lib/i18n'
import type { AgentStatus, ElementPickerFormat, UnattendedWindowPolicy } from '../lib/types'
import { RUN_WINDOW_LIMITS, normalizeRunWindowLimit } from '../lib/types'
import { TOOL_META, TOOL_SECTIONS } from '../lib/tool-catalog'
import { DEFAULT_SYSTEM_PROMPT } from '../lib/system-prompt'
import { BLOCK_BY_ID } from '../lib/workflow/blocks/palette'
import {
  ADVERTISABLE_OPERATOR_CATEGORIES,
  CORE_OPERATOR_BLOCK_IDS,
  OPERATOR_CATEGORY_ENTRIES,
  operatorCategoryLabel,
} from '../lib/workflow/operator-categories'
import { blockDisplayName, categoryDisplayName } from '../workflow-editor/block-i18n'
import {
  clearStorageDirectory,
  ensureFileAccess,
  getStorageDirectoryName,
  getStorageMode,
  pickStorageDirectory,
  STORAGE_DISCONNECTED_EVENT,
  StorageFolderPickRetryError,
  StorageFolderUnreachableError,
  type StorageMode,
} from '../lib/fs-store'
import { outboxCount } from '../lib/fs-outbox'
import { STORAGE_RECONNECTED_EVENT } from '../lib/fs-reconnect'
import { clearDownloadDir, getDownloadDir, setDownloadDir } from '../lib/download-dir'
import { ADAPTER_ASSET_PATH, ADAPTER_EXPORT_FILENAME, buildMcpSnippet } from '../lib/mcp-adapter'
import NumberInput from '../ui/NumberInput'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from '../ui/FormDialog'
import { Switch } from '../ui/Switch'
import UpdateSettingsCard from './update/UpdateSettingsCard'
import TeamSharingCard from './TeamSharingCard'
import FeedbackCard from './FeedbackCard'
import { useSettings } from './hooks/useSettings'
import { useI18n, useT } from './i18n'
import Banner from './components/Banner'

/**
 * Per-connection → window assignment surface, rendered independently in EVERY
 * window's panel. Bindings live in global settings, so all panels show the
 * same rows; an assignment made here is applied atomically by the worker
 * (`agent.bindings.set`) and fanned out to other panels via storage change
 * events.
 */
function AgentBindingsCard(props: {
  t: Messages
  agents: Array<{ id: string; name: string }>
  windows: WindowChoice[]
  bindings: Record<string, number>
  myWindowId: number | undefined
  onAssign: (agentId: string | undefined, agentName: string, windowId: number | null) => void
}): ReactElement {
  const { t, agents, windows, bindings, myWindowId, onAssign } = props
  // Only windows currently hosting the plugin can be assigned.
  const pluginWindows = windows.filter((window) => window.isPanel || window.isMinimized)

  // How many live connections share each name (duplicate names share one
  // binding and need a unique BROWSER_COPILOT_AGENT_NAME to be told apart).
  const nameCounts = new Map<string, number>()
  for (const agent of agents) {
    nameCounts.set(agent.name, (nameCounts.get(agent.name) ?? 0) + 1)
  }

  // Bindings whose connection is no longer connected — orphaned by an agent
  // restart under a different name; surfaced for one-click cleanup.
  const staleNames = Object.keys(bindings).filter(
    (name) => !agents.some((agent) => agent.name === name),
  )

  const windowLabel = (window: WindowChoice): string => {
    const title = window.title.trim()
    const here =
      window.windowId === myWindowId ? `（${t.settingsLocalAgentBindingThisWindow}）` : ''
    return `${title || `#${window.windowId}`} · #${window.windowId}${here}`
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border bg-panel-2 p-3">
      <div className="text-[12.5px] font-medium text-ink">{t.settingsLocalAgentBindingsTitle}</div>
      <p className="m-0 text-[11.5px] leading-relaxed text-muted">
        {t.settingsLocalAgentBindingsHint}
      </p>

      {agents.map((agent) => {
        const bound = bindings[agent.name]
        const closed =
          typeof bound === 'number' && !pluginWindows.some((window) => window.windowId === bound)
        return (
          <div key={agent.id} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[12.5px] text-ink" title={agent.id}>
                  {agent.name}
                </span>
                {bound === myWindowId && (
                  <span className="shrink-0 text-[11px] text-accent">
                    （{t.settingsLocalAgentBindingThisWindow}）
                  </span>
                )}
              </div>
              {(nameCounts.get(agent.name) ?? 0) > 1 && (
                <div className="mt-0.5 text-[11px] leading-snug text-err">
                  {t.settingsLocalAgentBindingDuplicate}
                </div>
              )}
            </div>
            <select
              className="h-7 max-w-[52%] shrink-0 rounded-md border border-border bg-panel px-2 text-[12px] text-ink"
              value={typeof bound === 'number' ? String(bound) : ''}
              onChange={(event) =>
                onAssign(
                  agent.id,
                  agent.name,
                  event.target.value === '' ? null : Number(event.target.value),
                )
              }
            >
              <option value="">{t.settingsLocalAgentBindingUnassigned}</option>
              {closed && (
                <option disabled value={String(bound)}>
                  {t.settingsLocalAgentBindingClosed({ id: bound as number })}
                </option>
              )}
              {pluginWindows.map((window) => (
                <option key={window.windowId} value={window.windowId}>
                  {windowLabel(window)}
                </option>
              ))}
            </select>
          </div>
        )
      })}

      {staleNames.length > 0 && (
        <div className="space-y-1 border-t border-border pt-2">
          <div className="text-[11.5px] text-muted">{t.settingsLocalAgentBindingStale}</div>
          {staleNames.map((name) => (
            <div key={name} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={name}>
                {name} · #{bindings[name]}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11.5px] text-muted hover:text-err"
                onClick={() => onAssign(undefined, name, null)}
              >
                {t.settingsLocalAgentBindingRemove}
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="m-0 text-[11px] text-muted">
        {t.settingsLocalAgentAgentsConnected({ count: agents.length })}
      </p>
    </div>
  )
}

/**
 * Polls the downloads API until one download reaches a terminal state. Only
 * `DownloadItem.filename` carries the ABSOLUTE on-disk path, which is what the
 * MCP snippets substitute in. Module-level/chrome-global is fine: this only
 * runs from the export button click in the extension page.
 */
function waitForDownloadItem(
  downloadId: number,
  timeoutMs = 30_000,
): Promise<chrome.downloads.DownloadItem> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = window.setInterval(() => {
      void chrome.downloads
        .search({ id: downloadId })
        .then((items) => {
          const item = items[0]
          if (item && (item.state === 'complete' || item.state === 'interrupted')) {
            window.clearInterval(timer)
            resolve(item)
          } else if (Date.now() - started > timeoutMs) {
            window.clearInterval(timer)
            reject(new Error('download timeout'))
          }
        })
        .catch(() => {
          /* transient search error: keep polling until the timeout */
        })
    }, 400)
  })
}

interface McpSnippetProps {
  text: string
  copied: boolean
  copyLabel: string
  copiedLabel: string
  onCopy: () => void
}

/** A copyable `<pre>` block whose active tab names it; flips to "已复制" briefly. */
function McpSnippet({ text, copied, copyLabel, copiedLabel, onCopy }: McpSnippetProps) {
  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 8,
          marginBottom: 4,
        }}
      >
        <button onClick={onCopy} type="button">
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre
        style={{
          margin: '4px 0',
          padding: 8,
          background: 'var(--sunken)',
          borderRadius: 6,
          overflowX: 'auto',
          fontSize: 11,
          lineHeight: 1.5,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        }}
      >
        {text}
      </pre>
    </div>
  )
}

interface Props {
  /**
   * Lifts a language change to `App` so every tab re-renders at once, rather than
   * waiting for the storage round trip this component also performs.
   */
  onLocaleChange: (locale: LocaleSetting) => void
}

export default function SettingsTab({ onLocaleChange }: Props) {
  const t = useT()
  const { locale } = useI18n()
  // Block/category names come from the workflow editor's own dictionary, which
  // keys off 'zh' rather than the panel's 'zh-CN'.
  const editorLocale: 'en' | 'zh' = locale === 'zh-CN' ? 'zh' : 'en'
  // Settings are shared with the Model settings tab through one store, so both
  // surfaces apply each other's writes instead of keeping stale copies.
  const { settings, error, clearError, applySettings, mutate } = useSettings()
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  // Local text for the system-prompt editor. Empty string is a valid value (the
  // agent falls back to its default when blank); `null` means "not yet loaded".
  const [promptDraft, setPromptDraft] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  // The prompt and tools blocks are collapsed by default to keep the card short;
  // the user expands whichever they want to inspect or change.
  const [promptOpen, setPromptOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [operatorToolsOpen, setOperatorToolsOpen] = useState(false)
  // Local drafts for the local-agent URL and token so typing does not write to
  // storage on every keystroke; both are committed on blur.
  const [agentUrlDraft, setAgentUrlDraft] = useState('')
  const [agentTokenDraft, setAgentTokenDraft] = useState('')
  // Live connection status of the local-agent WebSocket, refreshed by polling.
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null)
  // Normal windows with plugin state, backing the per-connection assignment
  // selectors; polled alongside the connection status below.
  const [pluginWindows, setPluginWindows] = useState<WindowChoice[]>([])
  // Which MCP snippet's copy button currently shows "已复制".
  const [copiedKey, setCopiedKey] = useState<null | 'claude' | 'codex' | 'trae'>(null)
  // Which MCP snippet tab is active (Claude Code by default).
  const [mcpTab, setMcpTab] = useState<'claude' | 'codex' | 'trae'>('claude')
  // One-click adapter export (bundled mcp-server.mjs → Downloads/browser-copilot/).
  const [adapterExporting, setAdapterExporting] = useState(false)
  const [adapterExportError, setAdapterExportError] = useState<string | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  /** Which dialog is open; the local-agent connection is the only one left here. */
  const [openDialog, setOpenDialog] = useState<null | 'agent'>(null)
  /** Failure of the last local-agent connection save, rendered inside its dialog. */
  const [agentNotice, setAgentNotice] = useState<string | null>(null)

  // --- Unattended window policy -----------------------------------------------
  // Ordinary windows for the "fixed" selector; refreshed on mount (and cheap
  // enough to re-fetch whenever the user switches policy to fixed).
  const [normalWindows, setNormalWindows] = useState<{ windowId: number; title: string }[]>([])

  const refreshNormalWindows = useCallback((): void => {
    if (!chrome.windows?.getAll) return
    void chrome.windows
      .getAll({ windowTypes: ['normal'], populate: true })
      .then((windows) =>
        setNormalWindows(
          windows
            .filter((win) => typeof win.id === 'number')
            .map((win) => {
              const active = win.tabs?.find((tab) => tab.active) ?? win.tabs?.[0]
              return { windowId: win.id as number, title: active?.title ?? `#${win.id}` }
            }),
        ),
      )
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshNormalWindows()
  }, [refreshNormalWindows])

  // This panel's own window id. Used to mark "this window" in the per-agent
  // window-assignment selectors below (see `localAgentBindings` in Settings
  // and resolveBridgeTarget in window-policy).
  const [myWindowId, setMyWindowId] = useState<number | undefined>(undefined)
  useEffect(() => {
    void chrome.windows
      ?.getCurrent()
      .then((win) => {
        if (typeof win?.id === 'number') setMyWindowId(win.id)
      })
      .catch(() => undefined)
  }, [])

  // --- Storage location ------------------------------------------------------
  const [storageMode, setStorageMode] = useState<StorageMode>('browser')
  const [storageDirName, setStorageDirName] = useState<string | null>(null)
  /** Writes parked in the outbox because the folder was unreachable. */
  const [pendingWrites, setPendingWrites] = useState(0)
  const [storageBusy, setStorageBusy] = useState(false)
  const [storageNotice, setStorageNotice] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)

  const refreshStorage = useCallback(async (): Promise<void> => {
    const [mode, name, pending] = await Promise.all([
      getStorageMode(),
      getStorageDirectoryName(),
      outboxCount().catch(() => 0),
    ])
    setStorageMode(mode)
    setStorageDirName(name)
    setPendingWrites(pending)
  }, [])

  useEffect(() => {
    void refreshStorage()
  }, [refreshStorage])

  // The auto-reconnect (lib/fs-reconnect) flips the folder back to connected
  // on the panel's first interaction after an update. Since every tab stays
  // mounted, this row would otherwise keep showing "needs reconnect" until it
  // was reopened — listen and refresh in place.
  useEffect(() => {
    const handler = (): void => {
      void refreshStorage()
    }
    // A write that had to park in the outbox is the moment the folder really
    // went away; the row must show the pending badge and the reconnect hint
    // right then, not only after the next remount.
    window.addEventListener(STORAGE_RECONNECTED_EVENT, handler)
    window.addEventListener(STORAGE_DISCONNECTED_EVENT, handler)
    return () => {
      window.removeEventListener(STORAGE_RECONNECTED_EVENT, handler)
      window.removeEventListener(STORAGE_DISCONNECTED_EVENT, handler)
    }
  }, [refreshStorage])

  const chooseFolder = async (): Promise<void> => {
    setStorageBusy(true)
    setStorageNotice(null)
    try {
      // Picking a folder carries the departing folder's data over (see
      // `pickStorageDirectory`) and ends where a reconnect ends, so it
      // announces the same event: every mounted tab re-reads, from the new
      // folder this time.
      await pickStorageDirectory()
      const name = (await getStorageDirectoryName()) ?? ''
      setStorageMode('file')
      setStorageDirName(name)
      setStorageNotice({ kind: 'ok', text: t.settingsStorageSynced({ name }) })
      window.dispatchEvent(new Event(STORAGE_RECONNECTED_EVENT))
    } catch (error) {
      // A folder switch is refused while the departing folder is unreachable
      // (its data could not be carried). Guide the user instead of showing the
      // sentinel's developer message; after the reconnect the next click can
      // go straight to the picker.
      if (error instanceof StorageFolderUnreachableError) {
        setStorageNotice({ kind: 'error', text: t.settingsStorageReconnectFirst })
      } else if (error instanceof StorageFolderPickRetryError) {
        setStorageNotice({ kind: 'ok', text: t.settingsStoragePickAgain })
      } else {
        setStorageNotice({ kind: 'error', text: (error as Error).message })
      }
    } finally {
      setStorageBusy(false)
      // A carry that failed after the switch still moved the app onto the new
      // folder — re-read so the row shows where storage actually is.
      void refreshStorage()
    }
  }

  const reconnectFolder = async (): Promise<void> => {
    setStorageBusy(true)
    setStorageNotice(null)
    try {
      const mode = await ensureFileAccess()
      setStorageMode(mode)
      if (mode === 'file') {
        const name = (await getStorageDirectoryName()) ?? ''
        setStorageNotice({ kind: 'ok', text: t.settingsStorageSynced({ name }) })
        // The manual path ends in the same state as the automatic one, so it
        // announces it the same way: every mounted tab reloads its data from
        // the reconnected folder through this one event.
        window.dispatchEvent(new Event(STORAGE_RECONNECTED_EVENT))
      }
    } catch (error) {
      setStorageNotice({ kind: 'error', text: (error as Error).message })
    } finally {
      setStorageBusy(false)
      // The reconnect flushes the outbox; refresh the pending badge with it.
      void refreshStorage()
    }
  }

  const removeFolder = async (): Promise<void> => {
    setStorageBusy(true)
    setStorageNotice(null)
    try {
      // Copies the folder back into browser storage first, so switching back
      // cannot look like the data disappeared.
      await clearStorageDirectory()
      setStorageMode('browser')
      setStorageDirName(null)
    } catch (error) {
      // The handle is still in place, so the folder remains the source of truth.
      setStorageNotice({ kind: 'error', text: (error as Error).message })
    } finally {
      setStorageBusy(false)
    }
  }

  // --- Download directory ----------------------------------------------------
  const [downloadDirName, setDownloadDirName] = useState<string | null>(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [downloadNotice, setDownloadNotice] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)

  useEffect(() => {
    void getDownloadDir().then((handle) => setDownloadDirName(handle ? handle.name : null))
  }, [])

  const chooseDownloadDir = async (): Promise<void> => {
    // Firefox has no File System Access API: say so plainly instead of letting
    // the missing function surface as a generic TypeError → "could not set".
    if (typeof window.showDirectoryPicker !== 'function') {
      setDownloadNotice({ kind: 'error', text: t.settingsDownloadDirUnsupported })
      return
    }
    setDownloadBusy(true)
    setDownloadNotice(null)
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      await setDownloadDir(handle)
      setDownloadDirName(handle.name)
      setDownloadNotice({ kind: 'ok', text: t.settingsDownloadDirDone({ name: handle.name }) })
    } catch (error) {
      if ((error as DOMException).name === 'AbortError') return
      setDownloadNotice({ kind: 'error', text: t.settingsDownloadDirFailed })
    } finally {
      setDownloadBusy(false)
    }
  }

  const removeDownloadDir = async (): Promise<void> => {
    setDownloadBusy(true)
    try {
      await clearDownloadDir()
      setDownloadDirName(null)
      await mutate({ type: 'settings.set', patch: { downloadAutoSave: false } })
      setDownloadNotice(null)
    } finally {
      setDownloadBusy(false)
    }
  }

  // Keep the editor in sync when settings arrive (or change elsewhere), without
  // clobbering text the user is actively typing.
  useEffect(() => {
    if (!settings) return
    setPromptDraft((current) => (current === null ? settings.systemPromptOverride : current))
  }, [settings])

  // The local-agent dialog edits drafts; mirror whatever is stored, first load
  // included, so the fields show the saved URL/token instead of opening empty.
  useEffect(() => {
    if (!settings) return
    setAgentUrlDraft(settings.localAgentUrl)
    setAgentTokenDraft(settings.localAgentToken)
  }, [settings])

  // Poll the local-agent connection status and the window list while the card
  // is mounted; the worker owns the socket, so the panel reads both back every
  // couple of seconds.
  useEffect(() => {
    const poll = (): void => {
      void sendCommand({ type: 'agent.status.get' })
        .then((result) => {
          if (result.type === 'agent.status') setAgentStatus(result.status)
        })
        .catch(() => {
          // Worker may be momentarily unavailable; the next tick retries.
        })
      void sendCommand({ type: 'agent.windows.list' })
        .then((result) => {
          if (result.type === 'agent.windows') setPluginWindows(result.windows)
        })
        .catch(() => {
          // Same best-effort cadence as the status poll.
        })
    }
    poll()
    const interval = setInterval(poll, 2000)
    return () => clearInterval(interval)
  }, [])

  // An assignment made in ANOTHER window's panel lands in storage behind our
  // back; the shared settings hook re-reads on that notification.

  // Reset the MCP copy-button label after a brief pause, and clear the timer on
  // unmount so it never fires after the panel is gone.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  const copySnippet = (key: 'claude' | 'codex' | 'trae', text: string): void => {
    void navigator.clipboard.writeText(text)
    setCopiedKey(key)
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedKey(null)
      copyTimerRef.current = null
    }, 1500)
  }

  /**
   * Exports the bundled adapter (public/mcp-server.mjs → extension root at
   * build time) into the browser download folder via a Blob download, then
   * persists the returned absolute path so the MCP snippets can be auto-filled.
   * Blob (instead of downloading the chrome-extension:// URL directly) avoids
   * any dependency on web_accessible_resources. Release-zip users never touch
   * the source repository.
   */
  const exportAdapter = async (): Promise<void> => {
    if (adapterExporting) return
    setAdapterExportError(null)
    setAdapterExporting(true)
    let objectUrl: string | null = null
    try {
      if (typeof chrome?.runtime?.getURL !== 'function' || !chrome.downloads?.download) {
        throw new Error(t.settingsLocalAgentExportFailed + ' downloads API unavailable')
      }
      const response = await fetch(chrome.runtime.getURL(ADAPTER_ASSET_PATH))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      objectUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
      const downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename: ADAPTER_EXPORT_FILENAME,
        conflictAction: 'uniquify',
        saveAs: false,
      })
      const item = await waitForDownloadItem(downloadId)
      if (item.state === 'interrupted' || !item.filename) {
        throw new Error(item.error ?? 'interrupted')
      }
      const result = await sendCommand({
        type: 'settings.set',
        patch: { localAgentAdapterPath: item.filename },
      })
      if (result.type === 'settings') applySettings(result.settings)
    } catch (error) {
      setAdapterExportError(
        `${t.settingsLocalAgentExportFailed} ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setAdapterExporting(false)
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }

  /**
   * Commits the local-agent connection fields from the dialog. Unlike the old
   * onBlur auto-commit, both fields go out in ONE explicit save so "what did
   * the dialog change?" has a single answer, and a failure is reported inside
   * the dialog instead of behind it.
   */
  const saveAgentConnection = async (): Promise<void> => {
    setAgentNotice(null)
    try {
      const result = await sendCommand({
        type: 'settings.set',
        patch: {
          localAgentUrl: agentUrlDraft.trim() || t.settingsLocalAgentUrlPlaceholder,
          localAgentToken: agentTokenDraft.trim(),
        },
      })
      if (result.type === 'settings') applySettings(result.settings)
      setOpenDialog(null)
    } catch (error) {
      setAgentNotice((error as Error).message)
    }
  }

  const checkPage = async (): Promise<void> => {
    try {
      const result = await sendCommand({ type: 'page.check' })
      if (result.type !== 'page.check') return
      setBanner(
        result.readable
          ? {
              kind: 'ok',
              text: t.settingsPageReadable({
                title: result.tabTitle || result.tabUrl || '',
              }),
            }
          : {
              kind: 'error',
              text: t.settingsPageBlocked({ reason: result.reason ?? '' }),
            },
      )
    } catch (error) {
      setBanner({ kind: 'error', text: (error as Error).message })
    }
  }

  const savePrompt = useCallback((value: string) => {
    void mutate({ type: 'settings.set', patch: { systemPromptOverride: value } })
  }, [])

  const resetPrompt = useCallback(() => {
    setPromptDraft('')
    void mutate({ type: 'settings.set', patch: { systemPromptOverride: '' } })
  }, [])

  if (!settings) return <div className="pane empty">{t.loading}</div>

  // Absolute path of an exported adapter; undefined until export so snippets
  // keep their placeholder.
  const adapterPath = settings.localAgentAdapterPath.trim() || undefined
  const snippetClaude = buildMcpSnippet('claude', adapterPath)
  const snippetCodex = buildMcpSnippet('codex', adapterPath)
  const snippetTrae = buildMcpSnippet('trae', adapterPath)

  return (
    <div className="pane">
      {error && (
        <Banner kind="error" onDismiss={clearError}>
          {error}
        </Banner>
      )}
      {banner && (
        <Banner kind={banner.kind} onDismiss={() => setBanner(null)}>
          {banner.text}
        </Banner>
      )}

      {/* --- Download directory --- */}
      <div className="card">
        <div className="card-title">{t.settingsDownloadDir}</div>
        <p className="hint">{t.settingsDownloadDirIntro}</p>
        <p className="hint">
          {downloadDirName
            ? t.settingsDownloadDirFolder({ name: downloadDirName })
            : t.settingsDownloadDirNone}
        </p>
        {downloadNotice && (
          <p className={downloadNotice.kind === 'ok' ? 'hint ok' : 'hint error'}>
            {downloadNotice.text}
          </p>
        )}
        <div className="actions">
          {downloadDirName ? (
            <>
              <button
                disabled={downloadBusy}
                onClick={() => void chooseDownloadDir()}
                type="button"
              >
                {t.settingsChangeFolder}
              </button>
              <button
                disabled={downloadBusy}
                onClick={() => void removeDownloadDir()}
                type="button"
              >
                {t.settingsDownloadDirDisconnect}
              </button>
            </>
          ) : (
            <button disabled={downloadBusy} onClick={() => void chooseDownloadDir()} type="button">
              {t.settingsChooseFolder}
            </button>
          )}
        </div>
        <label className="checkbox">
          <input
            checked={settings.downloadAutoSave}
            disabled={!downloadDirName}
            onChange={(event) =>
              void mutate({
                type: 'settings.set',
                patch: { downloadAutoSave: event.target.checked },
              })
            }
            type="checkbox"
          />
          {t.settingsDownloadAutoSave}
        </label>
      </div>

      {/* --- Local agent (WebSocket + MCP adapter) --- */}
      <div className="card">
        <div className="card-title">{t.settingsLocalAgent}</div>
        <p className="hint">{t.settingsLocalAgentIntro}</p>
        <Switch
          checked={settings.localAgentEnabled}
          label={t.settingsLocalAgentEnable}
          onChange={(localAgentEnabled) =>
            void mutate({
              type: 'settings.set',
              patch: { localAgentEnabled },
            })
          }
        />
        {settings.localAgentEnabled && (
          <>
            {/* Compact status badge; errors surface as a red dot + short hint. */}
            {agentStatus && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 10px' }}>
                <span
                  className={`status-badge ${
                    agentStatus.state === 'connected'
                      ? 'ok'
                      : agentStatus.state === 'connecting'
                        ? 'skip'
                        : agentStatus.error
                          ? 'err'
                          : 'skip'
                  }`}
                >
                  {agentStatus.state === 'connected'
                    ? t.settingsLocalAgentStatusConnected
                    : agentStatus.state === 'connecting'
                      ? t.settingsLocalAgentStatusConnecting
                      : t.settingsLocalAgentStatusDisconnected}
                </span>
                {agentStatus.error && (
                  <span
                    className="hint error"
                    style={{
                      margin: 0,
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={
                      /ERR_CONNECTION_REFUSED|ECONNREFUSED|CONNECTION_REFUSED/i.test(
                        agentStatus.error,
                      )
                        ? t.settingsLocalAgentErrorRefused
                        : t.settingsLocalAgentStatusError({ error: agentStatus.error })
                    }
                  >
                    {'● '}
                    {/ERR_CONNECTION_REFUSED|ECONNREFUSED|CONNECTION_REFUSED/i.test(
                      agentStatus.error,
                    )
                      ? t.settingsLocalAgentErrorRefused
                      : t.settingsLocalAgentStatusError({ error: agentStatus.error })}
                  </span>
                )}
              </div>
            )}

            {/* Per-connection window assignment: each connected agent can be
                bound to one window, so several agents drive SEPARATE windows
                concurrently. Usable independently in every window's panel;
                assignments are global settings synced via storage events. */}
            {(agentStatus?.agents ?? []).length >= 1 && (
              <AgentBindingsCard
                t={t}
                agents={agentStatus!.agents}
                windows={pluginWindows}
                bindings={settings.localAgentBindings ?? {}}
                myWindowId={myWindowId}
                onAssign={(agentId, agentName, windowId) =>
                  void mutate({ type: 'agent.bindings.set', agentId, agentName, windowId })
                }
              />
            )}

            {/* Connection editing moved into the dialog (button below); this
                card stays a status surface: enable switch, live state, and —
                for a multi-agent setup — per-window connection assignment. */}
            <div className="actions">
              <button
                onClick={() => {
                  setAgentNotice(null)
                  setOpenDialog('agent')
                }}
                type="button"
              >
                {t.settingsLocalAgentConfigure}
              </button>
            </div>
          </>
        )}
      </div>

      <TeamSharingCard />

      {/* --- Element picker --- */}
      <div className="card">
        <div className="card-title">{t.settingsElementPicker}</div>
        <p className="hint">{t.settingsElementPickerIntro}</p>
        <Switch
          checked={settings.elementPickerEnabled}
          label={t.settingsElementPickerEnable}
          onChange={(elementPickerEnabled) =>
            void mutate({ type: 'settings.set', patch: { elementPickerEnabled } })
          }
        />
        <div className="mt-2.5">
          <Switch
            checked={settings.elementPickerSelectOnly}
            label={t.settingsElementPickerSelectOnly}
            onChange={(elementPickerSelectOnly) =>
              void mutate({ type: 'settings.set', patch: { elementPickerSelectOnly } })
            }
          />
        </div>
        {!settings.elementPickerSelectOnly && (
          <div className="field mt-2.5">
            <label htmlFor="element-picker-format">{t.settingsElementPickerFormat}</label>
            <select
              id="element-picker-format"
              value={settings.elementPickerFormat}
              onChange={(event) => {
                const elementPickerFormat = event.target.value as ElementPickerFormat
                void mutate({ type: 'settings.set', patch: { elementPickerFormat } })
              }}
            >
              <option value="selector">{t.settingsElementPickerFormatSelector}</option>
              <option value="text">{t.settingsElementPickerFormatText}</option>
              <option value="html">{t.settingsElementPickerFormatHtml}</option>
            </select>
          </div>
        )}
      </div>

      {/* --- Unattended window policy --- */}
      <div className="card">
        <div className="card-title">{t.settingsWindowPolicyLabel}</div>
        <p className="hint">{t.settingsWindowPolicyHelp}</p>

        <div className="field">
          <label htmlFor="unattended-policy">{t.settingsWindowPolicyLabel}</label>
          <select
            id="unattended-policy"
            value={settings?.unattendedWindowPolicy ?? 'latest'}
            onChange={(event) => {
              const policy = event.target.value as UnattendedWindowPolicy
              refreshNormalWindows()
              void mutate({ type: 'settings.set', patch: { unattendedWindowPolicy: policy } })
            }}
          >
            <option value="latest">{t.settingsWindowPolicyLatest}</option>
            <option value="ask">{t.settingsWindowPolicyAsk}</option>
            <option value="fixed">{t.settingsWindowPolicyFixed}</option>
          </select>
        </div>

        {settings?.unattendedWindowPolicy === 'fixed' && (
          <div className="field">
            <label htmlFor="unattended-window">{t.settingsWindowPolicyFixedWindow}</label>
            <select
              id="unattended-window"
              value={settings.unattendedWindowId ?? ''}
              onChange={(event) => {
                const raw = event.target.value
                void mutate({
                  type: 'settings.set',
                  patch: { unattendedWindowId: raw === '' ? undefined : Number(raw) },
                })
              }}
            >
              <option value="">—</option>
              {normalWindows.map((win) => (
                <option key={win.windowId} value={win.windowId}>
                  {win.title}（#{win.windowId}）
                </option>
              ))}
            </select>
          </div>
        )}

        <label className="field">
          <span>{t.settingsMaxRunWindows}</span>
          <NumberInput
            fallback={RUN_WINDOW_LIMITS.default}
            max={RUN_WINDOW_LIMITS.max}
            min={RUN_WINDOW_LIMITS.min}
            onChange={(value) => {
              void mutate({
                type: 'settings.set',
                patch: { maxConcurrentRunWindows: normalizeRunWindowLimit(value) },
              })
            }}
            style={{ maxWidth: 96 }}
            value={settings?.maxConcurrentRunWindows ?? RUN_WINDOW_LIMITS.default}
          />
        </label>
        <p className="hint">{t.settingsMaxRunWindowsHelp}</p>
      </div>

      {/* --- Agent behaviour --- */}
      <div className="card">
        <div className="card-title">{t.settingsContextTitle}</div>
        <p className="hint">{t.settingsContextIntro}</p>

        {/* System prompt — collapsed by default */}
        <button
          aria-expanded={promptOpen}
          className="disclosure"
          onClick={() => setPromptOpen((open) => !open)}
          type="button"
        >
          <span className="disclosure-caret" aria-hidden="true">
            {promptOpen ? '▾' : '▸'}
          </span>
          <b>{t.settingsSystemPrompt}</b>
          {!promptDraft || promptDraft.trim().length === 0 ? (
            <span className="disclosure-state">{t.settingsStateDefault}</span>
          ) : (
            <span className="disclosure-state disclosure-state-custom">
              {t.settingsStateCustom}
            </span>
          )}
        </button>
        {promptOpen && (
          <div className="disclosure-body">
            <div className="context-prompt-head">
              <button
                className="link-btn"
                disabled={promptDraft === null || promptDraft === settings.systemPromptOverride}
                onClick={() => {
                  if (promptDraft !== null) savePrompt(promptDraft)
                }}
                type="button"
              >
                {t.settingsPromptSave}
              </button>
              <button className="link-btn" onClick={resetPrompt} type="button">
                {t.settingsPromptReset}
              </button>
            </div>
            <p className="hint">{t.settingsSystemPromptHint}</p>
            <textarea
              className="prompt-editor"
              onBlur={(event) => savePrompt(event.target.value)}
              onChange={(event) => setPromptDraft(event.target.value)}
              placeholder={DEFAULT_SYSTEM_PROMPT}
              ref={promptRef}
              rows={12}
              spellCheck={false}
              value={promptDraft ?? ''}
            />
            <p className="hint prompt-foot">
              {promptDraft && promptDraft.trim().length > 0
                ? t.settingsPromptCustom
                : t.settingsPromptDefault}
            </p>
          </div>
        )}

        {/* Tools — collapsed by default */}
        <button
          aria-expanded={toolsOpen}
          className="disclosure"
          onClick={() => setToolsOpen((open) => !open)}
          type="button"
        >
          <span className="disclosure-caret" aria-hidden="true">
            {toolsOpen ? '▾' : '▸'}
          </span>
          <b>{t.settingsTools}</b>
          <span className="disclosure-state">
            {TOOL_META.length - settings.disabledTools.length}/{TOOL_META.length}{' '}
            {t.settingsToolsEnabled}
          </span>
        </button>
        {toolsOpen && (
          <div className="disclosure-body">
            <div className="context-tools-head">
              <div className="tool-bulk">
                <button
                  className="link-btn"
                  disabled={settings.disabledTools.length === 0}
                  onClick={() =>
                    void mutate({ type: 'settings.set', patch: { disabledTools: [] } })
                  }
                  type="button"
                >
                  {t.settingsToolsEnableAll}
                </button>
                <button
                  className="link-btn"
                  disabled={settings.disabledTools.length >= TOOL_META.length}
                  onClick={() =>
                    void mutate({
                      type: 'settings.set',
                      patch: { disabledTools: TOOL_META.map((m) => m.name) },
                    })
                  }
                  type="button"
                >
                  {t.settingsToolsDisableAll}
                </button>
              </div>
            </div>
            <p className="hint">{t.settingsToolsHint}</p>
            <div className="tool-toggle-list">
              {TOOL_SECTIONS.map((section) => (
                <section className="flex flex-col gap-2" key={section.id}>
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="context-subhead">{t[section.labelKey]}</div>
                    <span className="tool-warn">
                      {t.settingsToolGroupCount({ count: section.tools.length })}
                    </span>
                  </div>
                  {section.tools.map((meta) => {
                    const disabled = settings.disabledTools.includes(meta.name)
                    return (
                      <div className="flex items-start gap-2" key={meta.name}>
                        <Switch
                          checked={!disabled}
                          label={
                            <span className="flex flex-col gap-0.5">
                              <b>{t[meta.labelKey]}</b>
                              <code className="tool-name">{meta.name}</code>
                              <span className="tool-warn">{t[meta.warningKey]}</span>
                            </span>
                          }
                          onChange={() => {
                            const next = disabled
                              ? settings.disabledTools.filter((n) => n !== meta.name)
                              : [...settings.disabledTools, meta.name]
                            void mutate({
                              type: 'settings.set',
                              patch: { disabledTools: next },
                            })
                          }}
                        />
                      </div>
                    )
                  })}
                </section>
              ))}
            </div>
          </div>
        )}

        {/* Workflow operator tools — a read-only reference. These are dispatched
            by category in workflow-generation mode, so they are not part of
            `disabledTools`; showing them here answers "what can it actually
            do?" without implying they can be switched off. */}
        <button
          aria-expanded={operatorToolsOpen}
          className="disclosure"
          onClick={() => setOperatorToolsOpen((open) => !open)}
          type="button"
        >
          <span className="disclosure-caret" aria-hidden="true">
            {operatorToolsOpen ? '▾' : '▸'}
          </span>
          <b>{t.settingsOperatorTools}</b>
          <span className="disclosure-state">
            {ADVERTISABLE_OPERATOR_CATEGORIES.reduce(
              (sum, category) => sum + OPERATOR_CATEGORY_ENTRIES[category].length,
              0,
            )}{' '}
            {t.settingsToolsEnabled}
          </span>
        </button>
        {operatorToolsOpen && (
          <div className="disclosure-body">
            <p className="hint">{t.settingsOperatorToolsHint}</p>
            <div className="tool-toggle-list">
              <div className="tool-toggle">
                <span>
                  <b>{t.settingsOperatorToolsCore}</b>
                  <code className="tool-name">
                    {CORE_OPERATOR_BLOCK_IDS.map((id) =>
                      blockDisplayName(id, BLOCK_BY_ID.get(id)?.name ?? id, editorLocale),
                    ).join(' · ')}
                  </code>
                </span>
              </div>
              {ADVERTISABLE_OPERATOR_CATEGORIES.map((category) => (
                <div className="tool-toggle" key={category}>
                  <span>
                    <b>
                      {categoryDisplayName(category, operatorCategoryLabel(category), editorLocale)}{' '}
                      <span className="tool-warn">
                        {t.settingsOperatorToolsCount({
                          count: OPERATOR_CATEGORY_ENTRIES[category].length,
                        })}
                      </span>
                    </b>
                    <code className="tool-name">
                      {OPERATOR_CATEGORY_ENTRIES[category]
                        .map((entry) => blockDisplayName(entry.id, entry.name, editorLocale))
                        .join(' · ')}
                    </code>
                  </span>
                </div>
              ))}
            </div>
            <p className="hint" style={{ marginTop: '8px' }}>
              {t.settingsOperatorToolsReadOnly}
            </p>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">{t.settingsMaxToolRounds}</div>
        <p className="hint">{t.settingsMaxToolRoundsHint}</p>
        <div className="field">
          <NumberInput
            max={100}
            min={1}
            onChange={(value) => {
              void mutate({ type: 'settings.set', patch: { maxToolRounds: value } })
            }}
            style={{ maxWidth: 96 }}
            value={settings.maxToolRounds}
          />
        </div>
      </div>

      {/* --- Language --- */}
      <div className="card">
        <div className="card-title">{t.settingsLanguage}</div>
        <label className="field">
          <select
            onChange={(event) => {
              const next = event.target.value as LocaleSetting
              // Lift the change immediately so the whole panel re-renders without
              // waiting for the round trip to storage.
              onLocaleChange(next)
              void mutate({ type: 'settings.set', patch: { locale: next } })
            }}
            value={settings.locale}
          >
            <option value="auto">{t.settingsLanguageAuto}</option>
            {LOCALES.map((code) => (
              <option key={code} value={code}>
                {LOCALE_LABELS[code]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* --- Page access --- */}
      <div className="card">
        <div className="card-title">{t.settingsPageAccess}</div>
        <p className="hint">{t.settingsPageAccessIntro}</p>
        <div className="actions">
          <button onClick={() => void checkPage()} type="button">
            {t.settingsCheckTab}
          </button>
        </div>
      </div>

      {/* --- Storage location --- */}
      <div className="card">
        <div className="card-title">{t.settingsStorage}</div>
        <p className="hint">{t.settingsStorageIntro}</p>
        <p className="hint">
          {storageDirName
            ? storageMode === 'file'
              ? t.settingsStorageFolder({ name: storageDirName })
              : t.settingsStorageNeedReconnect({ name: storageDirName })
            : t.settingsStorageBrowser}
        </p>
        {storageNotice && (
          <p className={storageNotice.kind === 'ok' ? 'hint ok' : 'hint error'}>
            {storageNotice.text}
          </p>
        )}
        {pendingWrites > 0 && (
          <p className="hint">{t.settingsStoragePendingWrites({ count: pendingWrites })}</p>
        )}
        <div className="actions">
          {storageDirName ? (
            <>
              <button disabled={storageBusy} onClick={() => void reconnectFolder()} type="button">
                {t.settingsReconnectFolder}
              </button>
              <button disabled={storageBusy} onClick={() => void chooseFolder()} type="button">
                {t.settingsChangeFolder}
              </button>
              <button disabled={storageBusy} onClick={() => void removeFolder()} type="button">
                {t.settingsUseBrowserStorage}
              </button>
            </>
          ) : (
            <button disabled={storageBusy} onClick={() => void chooseFolder()} type="button">
              {t.settingsChooseFolder}
            </button>
          )}
        </div>
      </div>

      <UpdateSettingsCard />

      <FeedbackCard />

      {openDialog === 'agent' && (
        <FormDialog
          footer={
            <>
              <FormDialogCancelButton
                label={t.cancel}
                onClick={() => {
                  setAgentNotice(null)
                  setAdapterExportError(null)
                  setOpenDialog(null)
                }}
              />
              <FormDialogPrimaryButton label={t.save} onClick={() => void saveAgentConnection()} />
            </>
          }
          onClose={() => {
            setAgentNotice(null)
            setAdapterExportError(null)
            setOpenDialog(null)
          }}
          title={t.settingsLocalAgentConfigure}
        >
          {agentNotice && (
            <div
              className="mb-3 rounded-lg border border-err bg-err-surface px-3 py-2 text-[12.5px] leading-relaxed break-words text-err"
              role="alert"
            >
              {agentNotice}
            </div>
          )}

          <label className="field">
            <input
              onChange={(event) => setAgentUrlDraft(event.target.value)}
              placeholder={t.settingsLocalAgentUrlPlaceholder}
              type="text"
              value={agentUrlDraft}
            />
            <span>{t.settingsLocalAgentUrl}</span>
          </label>
          <label className="field">
            <input
              onChange={(event) => setAgentTokenDraft(event.target.value)}
              placeholder={t.settingsLocalAgentTokenPlaceholder}
              type="text"
              value={agentTokenDraft}
            />
            <span>{t.settingsLocalAgentToken}</span>
          </label>
          <p className="hint error">{t.settingsLocalAgentWarning}</p>

          <Switch
            checked={settings.localAgentAllowReload}
            label={t.settingsLocalAgentAllowReload}
            onChange={(localAgentAllowReload) =>
              void mutate({
                type: 'settings.set',
                patch: { localAgentAllowReload },
              })
            }
          />
          <p className="hint">{t.settingsLocalAgentAllowReloadHint}</p>

          <div className="mt-3 rounded-lg border border-border bg-panel-2 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-ink">
                  {t.settingsLocalAgentExportTitle}
                </div>
                <div
                  className="mt-1 truncate text-[11px] leading-relaxed text-muted"
                  title={adapterPath ?? undefined}
                >
                  {adapterPath
                    ? t.settingsLocalAgentExportedTo({ path: adapterPath })
                    : t.settingsLocalAgentExportIntro}
                </div>
              </div>
              <button
                className="shrink-0 rounded-md border border-accent bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent hover:text-on-accent disabled:cursor-default disabled:opacity-60"
                disabled={adapterExporting}
                onClick={() => void exportAdapter()}
                type="button"
              >
                {adapterExporting
                  ? t.settingsLocalAgentExporting
                  : adapterPath
                    ? t.settingsLocalAgentReexport
                    : t.settingsLocalAgentExport}
              </button>
            </div>
            {adapterExportError && (
              <p className="mb-0 mt-2 break-words text-[11px] leading-relaxed text-err">
                {adapterExportError}
              </p>
            )}
          </div>

          <p className="hint" style={{ marginTop: 12, marginBottom: 4 }}>
            {t.settingsLocalAgentMcpTitle}
          </p>
          <p className="hint">{t.settingsLocalAgentMcpHint}</p>
          <div role="tablist" style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {(
              [
                ['claude', t.settingsLocalAgentMcpTabClaude],
                ['codex', t.settingsLocalAgentMcpTabCodex],
                ['trae', t.settingsLocalAgentMcpTabTrae],
              ] as const
            ).map(([key, label]) => {
              const active = mcpTab === key
              return (
                <button
                  aria-selected={active}
                  key={key}
                  onClick={() => setMcpTab(key)}
                  role="tab"
                  style={{
                    flex: 1,
                    padding: '4px 8px',
                    fontSize: 12,
                    fontWeight: 600,
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: active ? 'var(--accent)' : 'var(--panel-2)',
                    color: active ? 'var(--on-accent)' : 'var(--muted)',
                    cursor: 'pointer',
                  }}
                  type="button"
                >
                  {label}
                </button>
              )
            })}
          </div>
          {mcpTab === 'claude' && (
            <McpSnippet
              copied={copiedKey === 'claude'}
              copyLabel={t.settingsLocalAgentCopy}
              copiedLabel={t.settingsLocalAgentCopied}
              onCopy={() => copySnippet('claude', snippetClaude)}
              text={snippetClaude}
            />
          )}
          {mcpTab === 'codex' && (
            <McpSnippet
              copied={copiedKey === 'codex'}
              copyLabel={t.settingsLocalAgentCopy}
              copiedLabel={t.settingsLocalAgentCopied}
              onCopy={() => copySnippet('codex', snippetCodex)}
              text={snippetCodex}
            />
          )}
          {mcpTab === 'trae' && (
            <McpSnippet
              copied={copiedKey === 'trae'}
              copyLabel={t.settingsLocalAgentCopy}
              copiedLabel={t.settingsLocalAgentCopied}
              onCopy={() => copySnippet('trae', snippetTrae)}
              text={snippetTrae}
            />
          )}
          <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
            {adapterPath
              ? t.settingsLocalAgentMcpExportedHint
              : t.settingsLocalAgentMcpPlaceholderHint}
          </p>
        </FormDialog>
      )}
    </div>
  )
}
