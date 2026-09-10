import { useCallback, useEffect, useRef, useState } from 'react'
import { sendCommand } from '../lib/messages'
import { LOCALE_LABELS, LOCALES, type LocaleSetting, type Messages } from '../lib/i18n'
import {
  PROVIDER_PRESETS,
  findPreset,
  isLocalEndpoint,
  normalizeBaseUrl,
  normalizeSettingsPayload,
  profileFromPreset,
  validateProfile,
  type ProviderProfile,
} from '../lib/providers'
import type { AgentStatus, Settings, UnattendedWindowPolicy } from '../lib/types'
import { TOOL_META } from '../lib/tool-catalog'
import { DEFAULT_SYSTEM_PROMPT } from '../lib/system-prompt'
import {
  clearStorageDirectory,
  ensureFileAccess,
  getStorageDirectoryName,
  getStorageMode,
  pickStorageDirectory,
  type StorageMode,
} from '../lib/fs-store'
import { clearDownloadDir, getDownloadDir, setDownloadDir } from '../lib/download-dir'
import {
  ADAPTER_ASSET_PATH,
  ADAPTER_EXPORT_FILENAME,
  buildMcpSnippet,
} from '../lib/mcp-adapter'
import { OCR_SUPPORTED } from '../lib/ocr-support'
import NumberInput from '../ui/NumberInput'
import FormDialog, {
  FormDialogCancelButton,
  FormDialogPrimaryButton,
} from '../ui/FormDialog'
import { useT } from './i18n'

/** Editable form state; numbers stay strings so partial input is allowed. */
interface Draft extends Omit<ProviderProfile, 'temperature' | 'maxTokens' | 'headers'> {
  temperature: string
  maxTokens: string
  headersJson: string
}

function toDraft(profile: ProviderProfile): Draft {
  return {
    ...profile,
    temperature: profile.temperature === undefined ? '' : String(profile.temperature),
    maxTokens: profile.maxTokens === undefined ? '' : String(profile.maxTokens),
    headersJson:
      profile.headers && Object.keys(profile.headers).length > 0
        ? JSON.stringify(profile.headers, null, 2)
        : '',
  }
}

/**
 * Converts the form back into a profile.
 *
 * Takes `t` as a parameter because this is module-level and so cannot call the
 * `useT` hook itself.
 *
 * @throws {Error} when advanced JSON or numeric fields are malformed, so bad
 *   input is rejected here rather than becoming a confusing API error later.
 */
function fromDraft(draft: Draft, t: Messages): ProviderProfile {
  const profile: ProviderProfile = {
    id: draft.id,
    label: draft.label.trim(),
    presetId: draft.presetId,
    baseUrl: normalizeBaseUrl(draft.baseUrl),
    apiKey: draft.apiKey.trim(),
    model: draft.model.trim(),
  }

  if (draft.temperature.trim()) {
    const value = Number(draft.temperature)
    if (!Number.isFinite(value)) throw new Error(t.errorTemperatureNumber)
    profile.temperature = value
  }
  if (draft.maxTokens.trim()) {
    const value = Number(draft.maxTokens)
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(t.errorMaxTokensInteger)
    }
    profile.maxTokens = value
  }
  if (draft.headersJson.trim()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(draft.headersJson)
    } catch {
      throw new Error(t.errorHeadersJson)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(t.errorHeadersObject)
    }
    profile.headers = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
        key,
        String(value),
      ]),
    )
  }
  return profile
}

const newLocalId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/**
 * Coerces a settings payload into a shape this component can render.
 *
 * See {@link normalizeSettingsPayload}: the panel and worker are separate bundles
 * that Chrome may load at different versions, so a field can legitimately be
 * missing and must not crash the panel.
 */
function normalizeSettings(raw: Settings | undefined): Settings {
  return normalizeSettingsPayload(raw)
}

/**
 * Polls the downloads API until one download reaches a terminal state. Only
 * `DownloadItem.filename` carries the ABSOLUTE on-disk path, which is what the
 * MCP snippets substitute in. Module-level/chrome-global is fine: this only
 * runs from the export button click in the extension page.
 */
function waitForDownloadItem(downloadId: number, timeoutMs = 30_000): Promise<chrome.downloads.DownloadItem> {
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
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [revealKey, setRevealKey] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [models, setModels] = useState<string[] | null>(null)
  const [pending, setPending] = useState<'test' | 'models' | null>(null)
  // Local text for the system-prompt editor. Empty string is a valid value (the
  // agent falls back to its default when blank); `null` means "not yet loaded".
  const [promptDraft, setPromptDraft] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  // The prompt and tools blocks are collapsed by default to keep the card short;
  // the user expands whichever they want to inspect or change.
  const [promptOpen, setPromptOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  // Local drafts for the local-agent URL and token so typing does not write to
  // storage on every keystroke; both are committed on blur.
  const [agentUrlDraft, setAgentUrlDraft] = useState('')
  const [agentTokenDraft, setAgentTokenDraft] = useState('')
  // Live connection status of the local-agent WebSocket, refreshed by polling.
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null)
  // Which MCP snippet's copy button currently shows "已复制".
  const [copiedKey, setCopiedKey] = useState<null | 'claude' | 'codex' | 'trae'>(null)
  // Which MCP snippet tab is active (Claude Code by default).
  const [mcpTab, setMcpTab] = useState<'claude' | 'codex' | 'trae'>('claude')
  // One-click adapter export (bundled mcp-server.mjs → Downloads/browser-copilot/).
  const [adapterExporting, setAdapterExporting] = useState(false)
  const [adapterExportError, setAdapterExportError] = useState<string | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  // Local draft for the image-recognition model selection. Kept separate from
  // settings so nothing is persisted until the user clicks 保存; the model list
  // is fetched for the currently selected provider and only refreshed on demand.
  const [imgDraft, setImgDraft] = useState<{ providerId: string; model: string }>({
    providerId: '',
    model: '',
  })
  const [imgModels, setImgModels] = useState<string[] | null>(null)
  const [imgBusy, setImgBusy] = useState<null | 'models' | 'save'>(null)
  const [imgBanner, setImgBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  // AI-takeover debug model (see the takeover card below): same save-then-sync
  // pattern as the image model — nothing persists until 保存 is clicked.
  const [takeoverDraft, setTakeoverDraft] = useState<{ providerId: string; model: string }>({
    providerId: '',
    model: '',
  })
  const [takeoverModels, setTakeoverModels] = useState<string[] | null>(null)
  const [takeoverBusy, setTakeoverBusy] = useState<null | 'models' | 'save'>(null)
  const [takeoverBanner, setTakeoverBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(
    null,
  )
  /**
   * Which editing dialog is open. Every edit surface (provider form, image
   * model, takeover model, local-agent connection) opens as a dialog; the
   * page itself only shows status cards with an "Edit…" entry button.
   */
  const [openDialog, setOpenDialog] = useState<null | 'provider' | 'image' | 'takeover' | 'agent'>(
    null,
  )
  /** Outcome line of the last provider-dialog action (test ok / save error). */
  const [providerNotice, setProviderNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(
    null,
  )
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

  // This panel's own window id. Recorded alongside the "serve connection"
  // selection: picking which agent controls ALSO pins the local-agent bridge
  // to THIS window, so the chosen agent only ever acts here (see
  // `localAgentWindowId` in Settings and resolveBridgeScope in window-policy).
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
  const [storageBusy, setStorageBusy] = useState(false)
  const [storageNotice, setStorageNotice] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)

  const refreshStorage = useCallback(async (): Promise<void> => {
    const [mode, name] = await Promise.all([getStorageMode(), getStorageDirectoryName()])
    setStorageMode(mode)
    setStorageDirName(name)
  }, [])

  useEffect(() => {
    void refreshStorage()
  }, [refreshStorage])

  const chooseFolder = async (): Promise<void> => {
    setStorageBusy(true)
    setStorageNotice(null)
    try {
      await pickStorageDirectory()
      const name = (await getStorageDirectoryName()) ?? ''
      setStorageMode('file')
      setStorageDirName(name)
      setStorageNotice({ kind: 'ok', text: t.settingsStorageSynced({ name }) })
    } catch (error) {
      setStorageNotice({ kind: 'error', text: (error as Error).message })
    } finally {
      setStorageBusy(false)
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
      }
    } catch (error) {
      setStorageNotice({ kind: 'error', text: (error as Error).message })
    } finally {
      setStorageBusy(false)
    }
  }

  const removeFolder = async (): Promise<void> => {
    setStorageBusy(true)
    setStorageNotice(null)
    try {
      await clearStorageDirectory()
      setStorageMode('browser')
      setStorageDirName(null)
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
    setPromptDraft((current) =>
      current === null ? settings.systemPromptOverride : current,
    )
  }, [settings])

  const load = useCallback(async () => {
    try {
      const settingsResult = await sendCommand({ type: 'settings.get' })
      if (settingsResult.type === 'settings') {
        setSettings(normalizeSettings(settingsResult.settings))
      }
    } catch (error) {
      setBanner({ kind: 'error', text: (error as Error).message })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Poll the local-agent connection status while the card is mounted; the worker
  // owns the socket, so the panel just reads it back every couple of seconds.
  useEffect(() => {
    const poll = (): void => {
      void sendCommand({ type: 'agent.status.get' })
        .then((result) => {
          if (result.type === 'agent.status') setAgentStatus(result.status)
        })
        .catch(() => {
          // Worker may be momentarily unavailable; the next tick retries.
        })
    }
    poll()
    const interval = setInterval(poll, 2000)
    return () => clearInterval(interval)
  }, [])

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

  const startNew = (presetId: string): void => {
    const preset = findPreset(presetId)
    if (!preset) return
    setDraft(toDraft(profileFromPreset(preset, newLocalId())))
    setModels(null)
    setShowAdvanced(false)
    setProviderNotice(null)
    setOpenDialog('provider')
  }

  const applySettings = (next: Settings): void => {
    const normalized = normalizeSettings(next)
    setSettings(normalized)
    // Keep the token/URL drafts in sync with whatever is actually stored, so a
    // previously saved value re-appears and a committed save clears the "typing"
    // state.
    setAgentUrlDraft(normalized.localAgentUrl)
    setAgentTokenDraft(normalized.localAgentToken)
    // Reflect the stored image-model selection; on first load this becomes the
    // starting point for the local image draft.
    setImgDraft((prev) => {
      const stored = normalized.imageModel
      if (prev.providerId === stored.providerId && prev.model === stored.model) return prev
      return { providerId: stored.providerId, model: stored.model }
    })
    setTakeoverDraft((prev) => {
      const stored = normalized.takeoverModel
      if (prev.providerId === stored.providerId && prev.model === stored.model) return prev
      return { providerId: stored.providerId, model: stored.model }
    })
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    setProviderNotice(null)
    try {
      const profile = fromDraft(draft, t)
      const problems = validateProfile(profile)
      if (problems.length > 0) throw new Error(problems.map((p) => p.message).join(' '))

      const result = await sendCommand({ type: 'provider.save', profile })
      if (result.type === 'settings') applySettings(result.settings)
      setDraft(null)
      setModels(null)
      setOpenDialog(null)
      setBanner({ kind: 'ok', text: t.settingsSaved({ name: profile.label }) })
    } catch (error) {
      // Rendered INSIDE the dialog: the failure must sit next to the form it
      // belongs to, not vanish behind the overlay.
      setProviderNotice({ kind: 'error', text: (error as Error).message })
    }
  }

  const runTest = async (): Promise<void> => {
    if (!draft) return
    setPending('test')
    setProviderNotice(null)
    try {
      const profile = fromDraft(draft, t)
      const problems = validateProfile(profile)
      if (problems.length > 0) throw new Error(problems.map((p) => p.message).join(' '))
      await sendCommand({ type: 'provider.test', profile })
      setProviderNotice({ kind: 'ok', text: t.settingsTestOk({ name: profile.label }) })
    } catch (error) {
      setProviderNotice({ kind: 'error', text: (error as Error).message })
    } finally {
      setPending(null)
    }
  }

  const fetchModels = async (): Promise<void> => {
    if (!draft) return
    setPending('models')
    setProviderNotice(null)
    try {
      const result = await sendCommand({ type: 'provider.models', profile: fromDraft(draft, t) })
      if (result.type === 'provider.models') {
        setModels(result.models)
        if (result.models.length === 0) {
          setProviderNotice({ kind: 'error', text: t.settingsModelsEmpty })
        }
      }
    } catch (error) {
      setProviderNotice({
        kind: 'error',
        text: t.settingsModelsFailed({ message: (error as Error).message }),
      })
    } finally {
      setPending(null)
    }
  }

  /** Closes the provider dialog, dropping any in-progress edits. */
  const closeProviderDialog = (): void => {
    setDraft(null)
    setModels(null)
    setProviderNotice(null)
    setOpenDialog(null)
  }

  // --- Image-recognition model -----------------------------------------------
  const imgProvider = (providerId: string, fallback: Settings['providers'] = settings?.providers ?? []): ProviderProfile | undefined =>
    fallback.find((p) => p.id === providerId)

  const fetchImageModels = async (): Promise<void> => {
    const providers = settings?.providers ?? []
    setImgBanner(null)
    // Resolve the provider being edited from the saved list (credentials live
    // there, so we never add an API-key field to this card).
    const target = imgProvider(imgDraft.providerId, providers)
    if (!target || !target.baseUrl || !target.apiKey) {
      setImgBanner({
        kind: 'error',
        text: settings ? t.settingsImageModelFetchNoProvider : t.loading,
      })
      return
    }
    setImgBusy('models')
    try {
      const result = await sendCommand({ type: 'provider.models', profile: target })
      if (result.type === 'provider.models') {
        setImgModels(result.models)
        if (result.models.length === 0) {
          setImgBanner({ kind: 'error', text: t.settingsModelsEmpty })
        }
      }
    } catch (error) {
      setImgBanner({
        kind: 'error',
        text: t.settingsModelsFailed({ message: (error as Error).message }),
      })
    } finally {
      setImgBusy(null)
    }
  }

  const saveImageModel = async (): Promise<void> => {
    if (!settings) return
    setImgBanner(null)
    // The model override may be blank (use the provider's default), but the
    // selected provider — when non-empty — must actually exist.
    if (imgDraft.providerId && !imgProvider(imgDraft.providerId)) {
      setImgBanner({
        kind: 'error',
        text: t.settingsImageModelProviderMissing,
      })
      return
    }
    const model = imgDraft.model.trim()
    setImgBusy('save')
    try {
      await mutate({
        type: 'settings.set',
        patch: { imageModel: { providerId: imgDraft.providerId, model } },
      })
      setImgModels(null)
      // Close on success: the status card now reflects the saved selection.
      setOpenDialog(null)
    } finally {
      setImgBusy(null)
    }
  }

  /** Closes the image-model dialog, dropping any uncommitted selection. */
  const closeImageDialog = (): void => {
    setImgBanner(null)
    setImgModels(null)
    setOpenDialog(null)
  }

  // --- AI-takeover debug model (mirrors the image-model flow) ----------------
  const fetchTakeoverModels = async (): Promise<void> => {
    const providers = settings?.providers ?? []
    setTakeoverBanner(null)
    // Resolve the provider being edited from the saved list (credentials live
    // there, so we never add an API-key field to this card).
    const target = providers.find((p) => p.id === takeoverDraft.providerId)
    if (!target || !target.baseUrl || !target.apiKey) {
      setTakeoverBanner({
        kind: 'error',
        text: settings ? t.settingsImageModelFetchNoProvider : t.loading,
      })
      return
    }
    setTakeoverBusy('models')
    try {
      const result = await sendCommand({ type: 'provider.models', profile: target })
      if (result.type === 'provider.models') {
        setTakeoverModels(result.models)
        if (result.models.length === 0) {
          setTakeoverBanner({ kind: 'error', text: t.settingsModelsEmpty })
        }
      }
    } catch (error) {
      setTakeoverBanner({
        kind: 'error',
        text: t.settingsModelsFailed({ message: (error as Error).message }),
      })
    } finally {
      setTakeoverBusy(null)
    }
  }

  const saveTakeoverModel = async (): Promise<void> => {
    if (!settings) return
    setTakeoverBanner(null)
    if (takeoverDraft.providerId && !settings.providers.some((p) => p.id === takeoverDraft.providerId)) {
      setTakeoverBanner({
        kind: 'error',
        text: t.settingsImageModelProviderMissing,
      })
      return
    }
    const model = takeoverDraft.model.trim()
    setTakeoverBusy('save')
    try {
      await mutate({
        type: 'settings.set',
        patch: { takeoverModel: { providerId: takeoverDraft.providerId, model } },
      })
      setTakeoverModels(null)
      // Close on success: the status card now reflects the saved selection.
      setOpenDialog(null)
    } finally {
      setTakeoverBusy(null)
    }
  }

  /** Closes the takeover-model dialog, dropping any uncommitted selection. */
  const closeTakeoverDialog = (): void => {
    setTakeoverBanner(null)
    setTakeoverModels(null)
    setOpenDialog(null)
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

  const mutate = async (command: Parameters<typeof sendCommand>[0]): Promise<void> => {
    try {
      const result = await sendCommand(command)
      if (result.type === 'settings') applySettings(result.settings)
    } catch (error) {
      setBanner({ kind: 'error', text: (error as Error).message })
    }
  }

  const savePrompt = useCallback(
    (value: string) => {
      void mutate({ type: 'settings.set', patch: { systemPromptOverride: value } })
    },
    [],
  )

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

  const preset = draft ? findPreset(draft.presetId) : undefined
  const localEndpoint = draft ? isLocalEndpoint(draft.baseUrl) : false
  const presetEndpoints = preset?.endpoints ?? []
  // The endpoint picker is controlled and reflects whichever preset endpoint
  // the current base URL matches. A hand-edited URL matches none → the
  // placeholder is shown. The old action-menu pattern reset the picker to the
  // placeholder immediately after choosing, which looked like the selection
  // never took effect.
  const selectedEndpoint = presetEndpoints.find(
    (option) => option.baseUrl === draft?.baseUrl,
  )

  return (
    <div className="pane">
      {banner && (
        <div className="banner" data-kind={banner.kind} onClick={() => setBanner(null)}>
          {banner.text}
        </div>
      )}

      {/* --- Providers: status cards only; editing opens the dialog below --- */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">{t.settingsProviders}</span>
        </div>
        <p className="hint">{t.settingsProvidersIntro}</p>

        {settings.providers.length === 0 && (
          <div className="empty">{t.settingsNoProvider}</div>
        )}

        {settings.providers.map((profile) => {
          const isActive = profile.id === settings.activeProviderId
          return (
            <div className="card provider-card" key={profile.id} style={{ marginBottom: 8 }}>
              <div className="card-head">
                <span className="card-title">{profile.label}</span>
                {isActive ? (
                  <span className="status-ok">{t.settingsActive}</span>
                ) : (
                  <button
                    onClick={() => void mutate({ type: 'provider.activate', id: profile.id })}
                    type="button"
                  >
                    {t.settingsUseThis}
                  </button>
                )}
              </div>
              <div className="provider-meta">
                <div className="meta">
                  <span className="meta-label">{t.settingsModel}</span>
                  <span>{profile.model}</span>
                </div>
                <div className="meta">
                  <span className="meta-label">{t.settingsBaseUrl}</span>
                  <span>{profile.baseUrl}</span>
                </div>
                <div className="meta">
                  <span className="meta-label">{t.settingsApiKey}</span>
                  <span>
                    {profile.apiKey ? (
                      <span className="status-ok">{t.settingsKeyConfigured}</span>
                    ) : (
                      t.settingsNoKey
                    )}
                  </span>
                </div>
              </div>
              <div className="actions">
                <button
                  onClick={() => {
                    setDraft(toDraft(profile))
                    setModels(null)
                    setShowAdvanced(
                      profile.temperature !== undefined ||
                        profile.maxTokens !== undefined ||
                        !!profile.headers,
                    )
                    setProviderNotice(null)
                    setOpenDialog('provider')
                  }}
                  type="button"
                >
                  {t.edit}
                </button>
                <button
                  className="danger"
                  onClick={() => void mutate({ type: 'provider.delete', id: profile.id })}
                  type="button"
                >
                  {t.delete}
                </button>
              </div>
            </div>
          )
        })}

        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="add-preset">{t.settingsAddProvider}</label>
          <select
            defaultValue=""
            id="add-preset"
            onChange={(event) => {
              if (event.target.value) startNew(event.target.value)
              event.target.value = ''
            }}
          >
            <option disabled value="">
              {t.settingsChoosePreset}
            </option>
            {PROVIDER_PRESETS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* --- Provider editor dialog --- */}
      {draft && openDialog === 'provider' && (
        <FormDialog
          footer={
            <>
              <FormDialogCancelButton label={t.cancel} onClick={closeProviderDialog} />
              <FormDialogPrimaryButton
                disabled={pending !== null}
                label={pending === 'test' ? t.settingsTesting : t.settingsTest}
                onClick={() => void runTest()}
              />
              <FormDialogPrimaryButton
                disabled={pending !== null}
                label={pending === 'models' ? t.settingsFetchingModels : t.settingsFetchModels}
                onClick={() => void fetchModels()}
              />
              <FormDialogPrimaryButton
                disabled={pending !== null}
                label={t.save}
                onClick={() => void saveDraft()}
              />
            </>
          }
          onClose={closeProviderDialog}
          title={
            settings.providers.some((profile) => profile.id === draft.id)
              ? t.settingsEditProvider
              : t.settingsNewProvider
          }
          width="lg"
        >
          {providerNotice && (
            <div
              className={[
                'mb-3 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed break-words',
                providerNotice.kind === 'ok'
                  ? 'border border-ok/30 bg-ok-surface text-ok'
                  : 'border border-err bg-err-surface text-err',
              ].join(' ')}
              role={providerNotice.kind === 'error' ? 'alert' : 'status'}
            >
              {providerNotice.text}
            </div>
          )}

          {preset?.hint && <p className="hint">{preset.hint}</p>}

          <div className="field">
            <label htmlFor="p-label">{t.settingsName}</label>
            <input
              id="p-label"
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              value={draft.label}
            />
          </div>

          <div className="field">
            <label htmlFor="p-base">{t.settingsBaseUrl}</label>
            <input
              id="p-base"
              onChange={(event) =>
                setDraft({ ...draft, baseUrl: event.target.value, presetId: 'custom' })
              }
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
              value={draft.baseUrl}
            />
            <p className="hint" style={{ marginBottom: 0 }}>
              {t.settingsBaseUrlHint}
            </p>
          </div>

          {presetEndpoints.length > 0 && (
            <div className="field">
              <label htmlFor="p-endpoint">{t.settingsEndpointPresets}</label>
              <select
                id="p-endpoint"
                onChange={(event) => {
                  const endpoint = presetEndpoints.find(
                    (option) => option.id === event.target.value,
                  )
                  if (endpoint) setDraft({ ...draft, baseUrl: endpoint.baseUrl })
                }}
                value={selectedEndpoint?.id ?? ''}
              >
                <option disabled value="">
                  {t.settingsChooseEndpoint}
                </option>
                {presetEndpoints.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label htmlFor="p-key">{t.settingsApiKey}</label>
            <input
              autoComplete="off"
              id="p-key"
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              placeholder={localEndpoint ? t.settingsKeyPlaceholderLocal : 'sk-…'}
              type={revealKey ? 'text' : 'password'}
              value={draft.apiKey}
            />
          </div>
          <label className="inline-check">
            <input
              checked={revealKey}
              onChange={(event) => setRevealKey(event.target.checked)}
              type="checkbox"
            />
            {t.settingsShowKey}
          </label>

          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="p-model">{t.settingsModel}</label>
            <input
              id="p-model"
              list="model-options"
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              placeholder="doubao-seed-code, deepseek-chat, ep-…"
              value={draft.model}
            />
            {models && (
              <datalist id="model-options">
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            )}
            {models && (
              <p className="hint" style={{ marginBottom: 0 }}>
                {t.settingsModelsAvailable({ count: models.length })}
              </p>
            )}
          </div>

          <button onClick={() => setShowAdvanced(!showAdvanced)} type="button">
            {showAdvanced ? t.settingsHideAdvanced : t.settingsShowAdvanced}
          </button>

          {showAdvanced && (
            <div style={{ marginTop: 10 }}>
              <div className="row">
                <div className="field">
                  <label htmlFor="p-temp">{t.settingsTemperature}</label>
                  <input
                    id="p-temp"
                    onChange={(event) => setDraft({ ...draft, temperature: event.target.value })}
                    placeholder={t.settingsProviderDefault}
                    value={draft.temperature}
                  />
                </div>
                <div className="field">
                  <label htmlFor="p-max">{t.settingsMaxTokens}</label>
                  <input
                    id="p-max"
                    onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value })}
                    placeholder={t.settingsProviderDefault}
                    value={draft.maxTokens}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="p-headers">{t.settingsExtraHeaders}</label>
                <textarea
                  id="p-headers"
                  onChange={(event) => setDraft({ ...draft, headersJson: event.target.value })}
                  placeholder={'{ "HTTP-Referer": "https://example.com" }'}
                  rows={3}
                  value={draft.headersJson}
                />
              </div>
            </div>
          )}

          <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
            {t.settingsKeyStorageNote}
          </p>
        </FormDialog>
      )}

      {/* --- Image recognition model: status card + edit dialog --- */}
      <div className="card">
        <div className="card-title">{t.settingsImageModel}</div>
        <p className="hint">{t.settingsImageModelIntro}</p>

        <p className="hint">
          {t.settingsImageModelCurrentValue({
            value: (() => {
              const target = settings.providers.find((p) => p.id === imgDraft.providerId)
              if (!target) return t.settingsImageModelAuto
              return imgDraft.model ? `${target.label} · ${imgDraft.model}` : target.label
            })(),
          })}
        </p>

        {OCR_SUPPORTED && (
          <div className="field">
            <label htmlFor="img-ocr-lang">{t.settingsOcrLanguage}</label>
            <select
              id="img-ocr-lang"
              value={settings.ocrLanguage}
              onChange={(event) => {
                void mutate({ type: 'settings.set', patch: { ocrLanguage: event.target.value } })
              }}
            >
              <option value="eng">English (eng)</option>
              <option value="chi_sim">简体中文 (chi_sim)</option>
              <option value="chi_sim+eng">中文 + English (chi_sim+eng)</option>
            </select>
            <p className="hint" style={{ marginBottom: 0 }}>
              {t.settingsOcrLanguageIntro}
            </p>
          </div>
        )}

        <div className="actions">
          <button onClick={() => setOpenDialog('image')} type="button">
            {t.settingsModify}
          </button>
        </div>
      </div>

      {openDialog === 'image' && (
        <FormDialog
          footer={
            <>
              <FormDialogCancelButton label={t.cancel} onClick={closeImageDialog} />
              <FormDialogPrimaryButton
                disabled={imgBusy === 'save'}
                label={imgBusy === 'save' ? t.settingsSaving : t.save}
                onClick={() => void saveImageModel()}
              />
            </>
          }
          onClose={closeImageDialog}
          title={t.settingsImageModel}
        >
          {imgBanner && (
            <div
              className="mb-3 rounded-lg border border-err bg-err-surface px-3 py-2 text-[12.5px] leading-relaxed break-words text-err"
              role="alert"
            >
              {imgBanner.text}
            </div>
          )}

          <div className="field">
            <label htmlFor="img-provider">{t.settingsImageModelProvider}</label>
            <select
              id="img-provider"
              onChange={(event) => {
                setImgDraft({ ...imgDraft, providerId: event.target.value })
                setImgModels(null)
              }}
              value={imgDraft.providerId}
            >
              <option value="">{t.settingsImageModelAuto}</option>
              {settings.providers.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                  {profile.model ? ` · ${profile.model}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="img-model">{t.settingsModel}</label>
            <select
              id="img-model"
              onChange={(event) => setImgDraft({ ...imgDraft, model: event.target.value })}
              value={imgDraft.model}
            >
              <option value="">{t.settingsProviderDefault}</option>
              {imgDraft.model && !(imgModels ?? []).includes(imgDraft.model) && (
                <option value={imgDraft.model}>{imgDraft.model}</option>
              )}
              {(imgModels ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <p className="hint" style={{ marginBottom: 0 }}>
              {imgModels
                ? t.settingsModelsAvailable({ count: imgModels.length })
                : t.settingsImageModelSelectHint}
            </p>
          </div>

          <div className="actions" style={{ marginTop: 8 }}>
            <button
              disabled={imgBusy === 'models' || !imgDraft.providerId}
              onClick={() => void fetchImageModels()}
              type="button"
            >
              {imgBusy === 'models' ? t.settingsFetchingModels : t.settingsFetchModels}
            </button>
          </div>
        </FormDialog>
      )}

      {/* --- AI-takeover debug model: status card + edit dialog --- */}
      <div className="card">
        <div className="card-title">{t.settingsTakeoverModel}</div>
        <p className="hint">{t.settingsTakeoverModelIntro}</p>

        <p className="hint">
          {t.settingsImageModelCurrentValue({
            value: (() => {
              const target = settings.providers.find((p) => p.id === takeoverDraft.providerId)
              if (!target) return t.settingsImageModelAuto
              return takeoverDraft.model ? `${target.label} · ${takeoverDraft.model}` : target.label
            })(),
          })}
        </p>

        <label className="checkbox">
          <input
            checked={settings.takeoverOnRun}
            onChange={(event) =>
              void mutate({
                type: 'settings.set',
                patch: { takeoverOnRun: event.target.checked },
              })
            }
            type="checkbox"
          />
          {t.settingsTakeoverOnRun}
        </label>
        <p className="hint">{t.settingsTakeoverOnRunIntro}</p>

        <div className="actions">
          <button onClick={() => setOpenDialog('takeover')} type="button">
            {t.settingsModify}
          </button>
        </div>
      </div>

      {openDialog === 'takeover' && (
        <FormDialog
          footer={
            <>
              <FormDialogCancelButton label={t.cancel} onClick={closeTakeoverDialog} />
              <FormDialogPrimaryButton
                disabled={takeoverBusy === 'save'}
                label={takeoverBusy === 'save' ? t.settingsSaving : t.save}
                onClick={() => void saveTakeoverModel()}
              />
            </>
          }
          onClose={closeTakeoverDialog}
          title={t.settingsTakeoverModel}
        >
          {takeoverBanner && (
            <div
              className="mb-3 rounded-lg border border-err bg-err-surface px-3 py-2 text-[12.5px] leading-relaxed break-words text-err"
              role="alert"
            >
              {takeoverBanner.text}
            </div>
          )}

          <div className="field">
            <label htmlFor="takeover-provider">{t.settingsTakeoverModelProvider}</label>
            <select
              id="takeover-provider"
              onChange={(event) => {
                setTakeoverDraft({ ...takeoverDraft, providerId: event.target.value })
                setTakeoverModels(null)
              }}
              value={takeoverDraft.providerId}
            >
              <option value="">{t.settingsImageModelAuto}</option>
              {settings.providers.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                  {profile.model ? ` · ${profile.model}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="takeover-model">{t.settingsModel}</label>
            <select
              id="takeover-model"
              onChange={(event) => setTakeoverDraft({ ...takeoverDraft, model: event.target.value })}
              value={takeoverDraft.model}
            >
              <option value="">{t.settingsProviderDefault}</option>
              {takeoverDraft.model && !(takeoverModels ?? []).includes(takeoverDraft.model) && (
                <option value={takeoverDraft.model}>{takeoverDraft.model}</option>
              )}
              {(takeoverModels ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <p className="hint" style={{ marginBottom: 0 }}>
              {takeoverModels
                ? t.settingsModelsAvailable({ count: takeoverModels.length })
                : t.settingsTakeoverModelSelectHint}
            </p>
          </div>

          <div className="actions" style={{ marginTop: 8 }}>
            <button
              disabled={takeoverBusy === 'models' || !takeoverDraft.providerId}
              onClick={() => void fetchTakeoverModels()}
              type="button"
            >
              {takeoverBusy === 'models' ? t.settingsFetchingModels : t.settingsFetchModels}
            </button>
          </div>
        </FormDialog>
      )}

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
                disabled={
                  promptDraft === null || promptDraft === settings.systemPromptOverride
                }
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
              {TOOL_META.map((meta) => {
                const disabled = settings.disabledTools.includes(meta.name)
                return (
                  <label className="checkbox tool-toggle" key={meta.name}>
                    <input
                      checked={!disabled}
                      onChange={() => {
                        const next = disabled
                          ? settings.disabledTools.filter((n) => n !== meta.name)
                          : [...settings.disabledTools, meta.name]
                        void mutate({
                          type: 'settings.set',
                          patch: { disabledTools: next },
                        })
                      }}
                      type="checkbox"
                    />
                    <span>
                      <b>{t[meta.labelKey]}</b>
                      <code className="tool-name">{meta.name}</code>
                      <span className="tool-warn">{t[meta.warningKey]}</span>
                    </span>
                  </label>
                )
              })}
            </div>
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
        <div className="actions">
          {storageDirName ? (
            <>
              <button
                disabled={storageBusy}
                onClick={() => void reconnectFolder()}
                type="button"
              >
                {t.settingsReconnectFolder}
              </button>
              <button
                disabled={storageBusy}
                onClick={() => void chooseFolder()}
                type="button"
              >
                {t.settingsChangeFolder}
              </button>
              <button
                disabled={storageBusy}
                onClick={() => void removeFolder()}
                type="button"
              >
                {t.settingsUseBrowserStorage}
              </button>
            </>
          ) : (
            <button
              disabled={storageBusy}
              onClick={() => void chooseFolder()}
              type="button"
            >
              {t.settingsChooseFolder}
            </button>
          )}
        </div>
      </div>

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
            <button
              disabled={downloadBusy}
              onClick={() => void chooseDownloadDir()}
              type="button"
            >
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
        <label className="checkbox">
          <input
            checked={settings.localAgentEnabled}
            onChange={(event) =>
              void mutate({
                type: 'settings.set',
                patch: { localAgentEnabled: event.target.checked },
              })
            }
            type="checkbox"
          />
          {t.settingsLocalAgentEnable}
        </label>
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

            {/* Which connected agent may control the browser. Surfaced ON the
                card (not inside 配置接入) so a multi-agent setup can switch
                control without expanding anything. Picking one also pins the
                bridge to THIS window (`localAgentWindowId`): the chosen agent
                then only ever acts in the window where the selection was made. */}
            {(agentStatus?.agents ?? []).length > 1 && (
              <div className="field">
                <label htmlFor="agent-serve">{t.settingsLocalAgentActiveAgent}</label>
                <select
                  id="agent-serve"
                  onChange={(event) =>
                    void mutate({
                      type: 'settings.set',
                      patch: {
                        localAgentActiveAgent: event.target.value,
                        ...(myWindowId !== undefined ? { localAgentWindowId: myWindowId } : {}),
                      },
                    })
                  }
                  value={settings.localAgentActiveAgent}
                >
                  <option value="">{t.settingsLocalAgentActiveAgentAll}</option>
                  {/* A previously selected connection may have dropped; keep it
                      listed so the value never renders as a blank select. */}
                  {settings.localAgentActiveAgent &&
                    !(agentStatus?.agents ?? []).some(
                      (agent) => agent.id === settings.localAgentActiveAgent,
                    ) && (
                      <option disabled value={settings.localAgentActiveAgent}>
                        {settings.localAgentActiveAgent} · {t.settingsLocalAgentStatusDisconnected}
                      </option>
                    )}
                  {(agentStatus?.agents ?? []).map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <p className="hint" style={{ marginBottom: 0 }}>
                  {t.settingsLocalAgentActiveAgentHint}
                  {` ${t.settingsLocalAgentAgentsConnected({
                    count: (agentStatus?.agents ?? []).length,
                  })}`}
                </p>
              </div>
            )}

            {/* Connection editing moved into the dialog (button below); this
                card stays a status surface: enable switch, live state, and —
                for a multi-agent setup — which connection to serve. */}
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
              <FormDialogPrimaryButton
                label={t.save}
                onClick={() => void saveAgentConnection()}
              />
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
