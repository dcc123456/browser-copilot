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
import type { Settings } from '../lib/types'
import { TOOL_META } from '../lib/tool-catalog'
import { DEFAULT_SYSTEM_PROMPT } from '../lib/system-prompt'
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

  const startNew = (presetId: string): void => {
    const preset = findPreset(presetId)
    if (!preset) return
    setDraft(toDraft(profileFromPreset(preset, newLocalId())))
    setModels(null)
    setShowAdvanced(false)
  }

  const applySettings = (next: Settings): void => {
    setSettings(normalizeSettings(next))
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
          <input
            inputMode="numeric"
            max={100}
            min={1}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (!Number.isFinite(value)) return
              const clamped = Math.min(100, Math.max(1, Math.round(value)))
              void mutate({ type: 'settings.set', patch: { maxToolRounds: clamped } })
            }}
            style={{ maxWidth: 96 }}
            type="number"
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
    </div>
  )
}
