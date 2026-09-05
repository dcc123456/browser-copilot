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
import NumberInput from '../ui/NumberInput'
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
 * Copyable stdio MCP config snippets for the local-agent card. The adapter path
 * is a placeholder (`__插件目录__`) because the panel cannot know the extension's
 * on-disk location; the user replaces it with their own install path.
 *
 * The Claude snippet is written into `claude.json` by `claude mcp add`, so it
 * is shown as a readable multi-line JSON block (matching what the command
 * produces) rather than a flattened one-liner.
 */
const MCP_SNIPPET_CLAUDE = {
  text:
    '{\n' +
    '  "mcpServers": {\n' +
    '    "browser-copilot": {\n' +
    '      "command": "node",\n' +
    '      "args": ["__插件目录__/examples/local-agent/mcp-server.mjs"],\n' +
    '      "env": { "BROWSER_COPILOT_TOKEN": "" }\n' +
    '    }\n' +
    '  }\n' +
    '}',
}

const MCP_SNIPPET_CODEX = {
  text:
    '[mcp_servers.browser-copilot]\n' +
    'command = "node"\n' +
    'args = ["__插件目录__/examples/local-agent/mcp-server.mjs"]',
}

const MCP_SNIPPET_TRAE = {
  text:
    'MCP 设置面板 → 添加 stdio MCP 服务：\n' +
    '  command: node\n' +
    '  args: ["__插件目录__/examples/local-agent/mcp-server.mjs"]',
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

  const startNew = (presetId: string): void => {
    const preset = findPreset(presetId)
    if (!preset) return
    setDraft(toDraft(profileFromPreset(preset, newLocalId())))
    setModels(null)
    setShowAdvanced(false)
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
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    try {
      const profile = fromDraft(draft, t)
      const problems = validateProfile(profile)
      if (problems.length > 0) throw new Error(problems.map((p) => p.message).join(' '))

      const result = await sendCommand({ type: 'provider.save', profile })
      if (result.type === 'settings') applySettings(result.settings)
      setDraft(null)
      setModels(null)
      setBanner({ kind: 'ok', text: t.settingsSaved({ name: profile.label }) })
    } catch (error) {
      setBanner({ kind: 'error', text: (error as Error).message })
    }
  }

  const runTest = async (): Promise<void> => {
    if (!draft) return
    setPending('test')
    setBanner(null)
    try {
      const profile = fromDraft(draft, t)
      const problems = validateProfile(profile)
      if (problems.length > 0) throw new Error(problems.map((p) => p.message).join(' '))
      await sendCommand({ type: 'provider.test', profile })
      setBanner({ kind: 'ok', text: t.settingsTestOk({ name: profile.label }) })
    } catch (error) {
      setBanner({ kind: 'error', text: (error as Error).message })
    } finally {
      setPending(null)
    }
  }

  const fetchModels = async (): Promise<void> => {
    if (!draft) return
    setPending('models')
    setBanner(null)
    try {
      const result = await sendCommand({ type: 'provider.models', profile: fromDraft(draft, t) })
      if (result.type === 'provider.models') {
        setModels(result.models)
        if (result.models.length === 0) {
          setBanner({ kind: 'error', text: t.settingsModelsEmpty })
        }
      }
    } catch (error) {
      setBanner({
        kind: 'error',
        text: t.settingsModelsFailed({ message: (error as Error).message }),
      })
    } finally {
      setPending(null)
    }
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
      setImgBanner({ kind: 'ok', text: t.settingsImageModelSaved })
    } finally {
      setImgBusy(null)
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

  const preset = draft ? findPreset(draft.presetId) : undefined
  const localEndpoint = draft ? isLocalEndpoint(draft.baseUrl) : false
  const presetEndpoints = preset?.endpoints ?? []

  return (
    <div className="pane">
      {banner && (
        <div className="banner" data-kind={banner.kind} onClick={() => setBanner(null)}>
          {banner.text}
        </div>
      )}

      {/* --- Providers --- */}
      {!draft && (
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
      )}

      {/* --- Provider editor --- */}
      {draft && (
        <div className="card">
          <div className="card-title">
            {settings.providers.some((profile) => profile.id === draft.id)
              ? t.settingsEditProvider
              : t.settingsNewProvider}
          </div>

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
                defaultValue=""
                id="p-endpoint"
                onChange={(event) => {
                  const endpoint = presetEndpoints.find(
                    (option) => option.id === event.target.value,
                  )
                  if (endpoint) setDraft({ ...draft, baseUrl: endpoint.baseUrl })
                  event.target.value = ''
                }}
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

          <div className="actions">
            <button className="primary" onClick={() => void saveDraft()} type="button">
              {t.save}
            </button>
            <button disabled={pending !== null} onClick={() => void runTest()} type="button">
              {pending === 'test' ? t.settingsTesting : t.settingsTest}
            </button>
            <button disabled={pending !== null} onClick={() => void fetchModels()} type="button">
              {pending === 'models' ? t.settingsFetchingModels : t.settingsFetchModels}
            </button>
            <button
              onClick={() => {
                setDraft(null)
                setModels(null)
              }}
              type="button"
            >
              {t.cancel}
            </button>
          </div>

          <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
            {t.settingsKeyStorageNote}
          </p>
        </div>
      )}

      {/* --- Image recognition model --- */}
      <div className="card">
        <div className="card-title">{t.settingsImageModel}</div>
        <p className="hint">{t.settingsImageModelIntro}</p>

        {imgBanner && (
          <p className={imgBanner.kind === 'ok' ? 'hint ok' : 'hint error'}>{imgBanner.text}</p>
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

        <div className="actions">
          <button
            className="primary"
            disabled={imgBusy === 'save'}
            onClick={() => void saveImageModel()}
            type="button"
          >
            {imgBusy === 'save' ? t.settingsSaving : t.save}
          </button>
          <button
            disabled={imgBusy === 'models' || !imgDraft.providerId}
            onClick={() => void fetchImageModels()}
            type="button"
          >
            {imgBusy === 'models' ? t.settingsFetchingModels : t.settingsFetchModels}
          </button>
        </div>
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

            <details className="collapsible">
              <summary>
                <span className="collapsible-title">{t.settingsLocalAgentConfigure}</span>
              </summary>
              <div style={{ padding: '0 12px 12px' }}>
                <label className="field">
                  <input
                    onChange={(event) => setAgentUrlDraft(event.target.value)}
                    onBlur={() =>
                      void mutate({
                        type: 'settings.set',
                        patch: {
                          localAgentUrl:
                            agentUrlDraft.trim() || t.settingsLocalAgentUrlPlaceholder,
                        },
                      })
                    }
                    placeholder={t.settingsLocalAgentUrlPlaceholder}
                    type="text"
                    value={agentUrlDraft}
                  />
                  <span>{t.settingsLocalAgentUrl}</span>
                </label>
                <label className="field">
                  <input
                    onChange={(event) => setAgentTokenDraft(event.target.value)}
                    onBlur={() =>
                      void mutate({
                        type: 'settings.set',
                        patch: { localAgentToken: agentTokenDraft.trim() },
                      })
                    }
                    placeholder={t.settingsLocalAgentTokenPlaceholder}
                    type="text"
                    value={agentTokenDraft}
                  />
                  <span>{t.settingsLocalAgentToken}</span>
                </label>
                {(agentStatus?.agents ?? []).length > 1 && (
                  <div className="field">
                    <label htmlFor="agent-serve">{t.settingsLocalAgentActiveAgent}</label>
                    <select
                      id="agent-serve"
                      onChange={(event) =>
                        void mutate({
                          type: 'settings.set',
                          patch: { localAgentActiveAgent: event.target.value },
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
                <p className="hint error">{t.settingsLocalAgentWarning}</p>
              </div>
            </details>
          </>
        )}

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
            onCopy={() => copySnippet('claude', MCP_SNIPPET_CLAUDE.text)}
            text={MCP_SNIPPET_CLAUDE.text}
          />
        )}
        {mcpTab === 'codex' && (
          <McpSnippet
            copied={copiedKey === 'codex'}
            copyLabel={t.settingsLocalAgentCopy}
            copiedLabel={t.settingsLocalAgentCopied}
            onCopy={() => copySnippet('codex', MCP_SNIPPET_CODEX.text)}
            text={MCP_SNIPPET_CODEX.text}
          />
        )}
        {mcpTab === 'trae' && (
          <McpSnippet
            copied={copiedKey === 'trae'}
            copyLabel={t.settingsLocalAgentCopy}
            copiedLabel={t.settingsLocalAgentCopied}
            onCopy={() => copySnippet('trae', MCP_SNIPPET_TRAE.text)}
            text={MCP_SNIPPET_TRAE.text}
          />
        )}
        <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
          {t.settingsLocalAgentMcpPlaceholderHint}
        </p>
      </div>
    </div>
  )
}
