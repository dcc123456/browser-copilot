/**
 * Model settings: the three model-facing surfaces that used to live inside the
 * Settings tab — chat providers, the image-recognition model, and the
 * AI-takeover model (plus its two run switches).
 *
 * Kept as its own tab because these cards are configured far more often than
 * the storage/agent/language settings around them, and they answer a different
 * question ("which model does what?") than the rest of Settings.
 *
 * @module sidepanel/ModelsTab
 */
import { useState } from 'react'
import { sendCommand } from '../lib/messages'
import type { Messages } from '../lib/i18n'
import {
  PROVIDER_PRESETS,
  findPreset,
  isLocalEndpoint,
  normalizeBaseUrl,
  profileFromPreset,
  validateProfile,
  type ProviderProfile,
} from '../lib/providers'
import {
  THINKING_LEVELS,
  normalizeThinkingLevel,
  thinkingLevelsFor,
  thinkingModelSupport,
  thinkingParamSummary,
  thinkingShapeVerified,
  type ThinkingLevel,
} from '../lib/thinking'
import { OCR_SUPPORTED } from '../lib/ocr-support'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from '../ui/FormDialog'
import { Switch } from '../ui/Switch'
import { useSettings } from './hooks/useSettings'
import { useT } from './i18n'

/** Editable form state; numbers stay strings so partial input is allowed. */
interface Draft extends Omit<
  ProviderProfile,
  'temperature' | 'maxTokens' | 'headers' | 'thinkingEffort'
> {
  temperature: string
  maxTokens: string
  headersJson: string
  /** Empty string = the provider's own default applies. */
  thinkingEffort: string
  /** The model names added to this provider; `model` is the one in use. */
  models: string[]
  /** The add-model field. Always empty between adds, so the fetched-model
   *  suggestions are never filtered down to a prefilled value. */
  modelInput: string
}

/** The models a provider holds; a profile written before providers held
 *  several models names exactly one. */
function providerModels(profile: ProviderProfile): string[] {
  return profile.models?.length ? profile.models : profile.model ? [profile.model] : []
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
    thinkingEffort: profile.thinkingEffort ?? '',
    models: providerModels(profile),
    modelInput: '',
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
  const models = draft.models.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  const profile: ProviderProfile = {
    id: draft.id,
    label: draft.label.trim(),
    presetId: draft.presetId,
    baseUrl: normalizeBaseUrl(draft.baseUrl),
    apiKey: draft.apiKey.trim(),
    // The model in use must name one of the added models; fall back to the
    // first added one so a half-finished list still saves.
    model: models.includes(draft.model.trim()) ? draft.model.trim() : (models[0] ?? ''),
    models,
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
  const thinking = normalizeThinkingLevel(draft.thinkingEffort)
  if (thinking) profile.thinkingEffort = thinking
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
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    )
  }
  return profile
}

const newLocalId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** A model selection stored on settings (image recognition / AI takeover). */
interface ModelChoice {
  providerId: string
  model: string
}

const EMPTY_CHOICE: ModelChoice = { providerId: '', model: '' }

export default function ModelsTab() {
  const t = useT()
  const { settings, error, clearError, applySettings, mutate } = useSettings()

  // --- Providers -------------------------------------------------------------
  const [draft, setDraft] = useState<Draft | null>(null)
  const [models, setModels] = useState<string[] | null>(null)
  const [pending, setPending] = useState<'test' | 'models' | null>(null)
  const [revealKey, setRevealKey] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  /** Outcome line of the last provider-dialog action (test ok / save error). */
  const [providerNotice, setProviderNotice] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)
  /** Page-level success line (e.g. "Saved …"). Failures use the hook's `error`. */
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // --- Image recognition / AI takeover --------------------------------------
  const [imgDraft, setImgDraft] = useState<ModelChoice>(EMPTY_CHOICE)
  const [imgModels, setImgModels] = useState<string[] | null>(null)
  const [imgBusy, setImgBusy] = useState<null | 'models' | 'save'>(null)
  const [imgBanner, setImgBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [takeoverDraft, setTakeoverDraft] = useState<ModelChoice>(EMPTY_CHOICE)
  const [takeoverModels, setTakeoverModels] = useState<string[] | null>(null)
  const [takeoverBusy, setTakeoverBusy] = useState<null | 'models' | 'save'>(null)
  const [takeoverBanner, setTakeoverBanner] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)

  const [openDialog, setOpenDialog] = useState<null | 'provider' | 'image' | 'takeover'>(null)

  if (!settings) return <div className="pane empty">{t.loading}</div>

  const preset = draft ? findPreset(draft.presetId) : undefined
  const localEndpoint = draft ? isLocalEndpoint(draft.baseUrl) : false
  const presetEndpoints = preset?.endpoints ?? []
  // The endpoint picker is controlled and reflects whichever preset endpoint
  // the current base URL matches. A hand-edited URL matches none → the
  // placeholder is shown.
  const selectedEndpoint = presetEndpoints.find((option) => option.baseUrl === draft?.baseUrl)

  // What the current draft's endpoint and model can actually express. The
  // levels a vendor cannot express are shown but not selectable, so a saved
  // value stays visible instead of silently disappearing.
  const thinkingLevels = draft ? thinkingLevelsFor(draft.baseUrl, draft.model) : []
  const thinkingSupport = draft ? thinkingModelSupport(draft.baseUrl, draft.model) : 'unknown'
  const thinkingVerified = draft ? thinkingShapeVerified(draft.baseUrl, draft.model) : false
  const draftThinking = draft ? normalizeThinkingLevel(draft.thinkingEffort) : undefined
  const thinkingLabel = (level: ThinkingLevel): string => {
    switch (level) {
      case 'off':
        return t.settingsThinkingLevelOff
      case 'low':
        return t.settingsThinkingLevelLow
      case 'medium':
        return t.settingsThinkingLevelMedium
      case 'high':
        return t.settingsThinkingLevelHigh
    }
  }

  const startNew = (presetId: string): void => {
    const found = findPreset(presetId)
    if (!found) return
    setDraft(toDraft(profileFromPreset(found, newLocalId())))
    setModels(null)
    setShowAdvanced(false)
    setProviderNotice(null)
    setOpenDialog('provider')
  }

  /** Adds the typed model to the provider's list; the first one becomes the
   *  model in use. */
  const addModel = (): void => {
    if (!draft) return
    const name = draft.modelInput.trim()
    if (!name || draft.models.includes(name)) return
    setDraft({
      ...draft,
      models: [...draft.models, name],
      model: draft.model || name,
      modelInput: '',
    })
  }

  /** Removes a model; when it was the one in use, the next one takes over. */
  const removeModel = (name: string): void => {
    if (!draft) return
    const models = draft.models.filter((entry) => entry !== name)
    setDraft({
      ...draft,
      models,
      model: draft.model === name ? (models[0] ?? '') : draft.model,
    })
  }

  /** Multi-select toggle for the fetched list: checking adds the model,
   *  unchecking removes it. */
  const toggleFetchedModel = (name: string): void => {
    if (!draft) return
    if (draft.models.includes(name)) {
      removeModel(name)
      return
    }
    setDraft({
      ...draft,
      models: [...draft.models, name],
      model: draft.model || name,
    })
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    setProviderNotice(null)
    try {
      const profile = fromDraft(draft, t)
      const problems = validateProfile(profile, t)
      if (problems.length > 0) throw new Error(problems.map((p) => p.message).join(' '))

      const result = await sendCommand({ type: 'provider.save', profile })
      if (result.type === 'settings') applySettings(result.settings)
      setDraft(null)
      setModels(null)
      setOpenDialog(null)
      setNotice({ kind: 'ok', text: t.settingsSaved({ name: profile.label }) })
    } catch (saveError) {
      // Rendered INSIDE the dialog: the failure must sit next to the form it
      // belongs to, not vanish behind the overlay.
      setProviderNotice({ kind: 'error', text: (saveError as Error).message })
    }
  }

  const runTest = async (): Promise<void> => {
    if (!draft) return
    setPending('test')
    setProviderNotice(null)
    try {
      const profile = fromDraft(draft, t)
      const problems = validateProfile(profile, t)
      if (problems.length > 0) throw new Error(problems.map((p) => p.message).join(' '))
      await sendCommand({ type: 'provider.test', profile })
      setProviderNotice({ kind: 'ok', text: t.settingsTestOk({ name: profile.label }) })
    } catch (testError) {
      setProviderNotice({ kind: 'error', text: (testError as Error).message })
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
    } catch (fetchError) {
      setProviderNotice({
        kind: 'error',
        text: t.settingsModelsFailed({ message: (fetchError as Error).message }),
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
  const fetchImageModels = async (): Promise<void> => {
    setImgBanner(null)
    // Resolve the provider being edited from the saved list (credentials live
    // there, so we never add an API-key field to this card).
    const target = settings.providers.find((profile) => profile.id === imgDraft.providerId)
    if (!target || !target.baseUrl || !target.apiKey) {
      setImgBanner({ kind: 'error', text: t.settingsImageModelFetchNoProvider })
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
    } catch (fetchError) {
      setImgBanner({
        kind: 'error',
        text: t.settingsModelsFailed({ message: (fetchError as Error).message }),
      })
    } finally {
      setImgBusy(null)
    }
  }

  const saveImageModel = async (): Promise<void> => {
    setImgBanner(null)
    // The model override may be blank (use the provider's default), but the
    // selected provider — when non-empty — must actually exist.
    if (
      imgDraft.providerId &&
      !settings.providers.some((profile) => profile.id === imgDraft.providerId)
    ) {
      setImgBanner({ kind: 'error', text: t.settingsImageModelProviderMissing })
      return
    }
    const model = imgDraft.model.trim()
    setImgBusy('save')
    const saved = await mutate({
      type: 'settings.set',
      patch: { imageModel: { providerId: imgDraft.providerId, model } },
    })
    setImgBusy(null)
    if (!saved) return
    setImgModels(null)
    // Close on success: the status card now reflects the saved selection.
    setOpenDialog(null)
  }

  /** Closes the image-model dialog, dropping any uncommitted selection. */
  const closeImageDialog = (): void => {
    setImgBanner(null)
    setImgModels(null)
    setOpenDialog(null)
  }

  // --- AI-takeover debug model (mirrors the image-model flow) ----------------
  const fetchTakeoverModels = async (): Promise<void> => {
    setTakeoverBanner(null)
    // Resolve the provider being edited from the saved list (credentials live
    // there, so we never add an API-key field to this card).
    const target = settings.providers.find((profile) => profile.id === takeoverDraft.providerId)
    if (!target || !target.baseUrl || !target.apiKey) {
      setTakeoverBanner({ kind: 'error', text: t.settingsImageModelFetchNoProvider })
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
    } catch (fetchError) {
      setTakeoverBanner({
        kind: 'error',
        text: t.settingsModelsFailed({ message: (fetchError as Error).message }),
      })
    } finally {
      setTakeoverBusy(null)
    }
  }

  const saveTakeoverModel = async (): Promise<void> => {
    setTakeoverBanner(null)
    if (
      takeoverDraft.providerId &&
      !settings.providers.some((profile) => profile.id === takeoverDraft.providerId)
    ) {
      setTakeoverBanner({ kind: 'error', text: t.settingsImageModelProviderMissing })
      return
    }
    const model = takeoverDraft.model.trim()
    setTakeoverBusy('save')
    const saved = await mutate({
      type: 'settings.set',
      patch: { takeoverModel: { providerId: takeoverDraft.providerId, model } },
    })
    setTakeoverBusy(null)
    if (!saved) return
    setTakeoverModels(null)
    // Close on success: the status card now reflects the saved selection.
    setOpenDialog(null)
  }

  /** Closes the takeover-model dialog, dropping any uncommitted selection. */
  const closeTakeoverDialog = (): void => {
    setTakeoverBanner(null)
    setTakeoverModels(null)
    setOpenDialog(null)
  }

  /** Status-card wording for a stored model choice. */
  const choiceLabel = (choice: ModelChoice): string => {
    const target = settings.providers.find((profile) => profile.id === choice.providerId)
    if (!target) return t.settingsImageModelAuto
    return choice.model ? `${target.label} · ${choice.model}` : target.label
  }

  const openImageDialog = (): void => {
    setImgDraft({ ...settings.imageModel })
    setImgModels(null)
    setImgBanner(null)
    setOpenDialog('image')
  }

  const openTakeoverDialog = (): void => {
    setTakeoverDraft({ ...settings.takeoverModel })
    setTakeoverModels(null)
    setTakeoverBanner(null)
    setOpenDialog('takeover')
  }

  return (
    <div className="pane">
      {error && (
        <div className="banner" data-kind="error" onClick={clearError}>
          {error}
        </div>
      )}
      {notice && (
        <div className="banner" data-kind={notice.kind} onClick={() => setNotice(null)}>
          {notice.text}
        </div>
      )}

      {/* --- Providers: status cards only; editing opens the dialog below --- */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">{t.settingsProviders}</span>
        </div>
        <p className="hint">{t.settingsProvidersIntro}</p>

        {settings.providers.length === 0 && <div className="empty">{t.settingsNoProvider}</div>}

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
                  <span>
                    {providerModels(profile).length === 0
                      ? t.settingsModelEmpty
                      : providerModels(profile).map((name, index) => (
                          <span key={name}>
                            {index > 0 && ' · '}
                            <span className={name === profile.model ? 'text-accent' : undefined}>
                              {name}
                            </span>
                          </span>
                        ))}
                  </span>
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
                {profile.thinkingEffort && (
                  <div className="meta">
                    <span className="meta-label">{t.settingsThinkingEffort}</span>
                    <span>{thinkingLabel(profile.thinkingEffort)}</span>
                  </div>
                )}
              </div>
              <div className="actions">
                <button
                  onClick={() => {
                    setDraft(toDraft(profile))
                    setModels(null)
                    setShowAdvanced(
                      profile.temperature !== undefined ||
                        profile.maxTokens !== undefined ||
                        profile.thinkingEffort !== undefined ||
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
            <div className="flex items-center gap-2">
              <input
                className="min-w-0 flex-1"
                id="p-model"
                list="model-options"
                onChange={(event) => setDraft({ ...draft, modelInput: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addModel()
                  }
                }}
                placeholder={t.settingsModelAddPlaceholder({
                  model: preset?.suggestedModel || 'doubao-seed-code / ep-…',
                })}
                value={draft.modelInput}
              />
              <button
                className="shrink-0"
                disabled={!draft.modelInput.trim()}
                onClick={addModel}
                type="button"
              >
                {t.settingsModelAdd}
              </button>
            </div>
            {models && (
              <datalist id="model-options">
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            )}
            {models && models.length > 0 && (
              // Fetched models are a multi-select: checking one adds it to the
              // provider, unchecking removes it — no one-at-a-time round trip
              // through the input field.
              <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-border p-2">
                <p className="hint" style={{ marginBottom: 4 }}>
                  {t.settingsModelsAvailableToAdd({ count: models.length })}
                </p>
                <ul className="flex flex-col gap-1">
                  {models.map((name) => (
                    <li key={name}>
                      <label className="checkbox min-w-0">
                        <input
                          checked={draft.models.includes(name)}
                          onChange={() => toggleFetchedModel(name)}
                          type="checkbox"
                        />
                        <span className="min-w-0 truncate">{name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {draft.models.length === 0 ? (
              <p className="hint" style={{ marginBottom: 0 }}>
                {t.settingsModelEmpty}
              </p>
            ) : (
              <>
                <p className="hint" style={{ marginBottom: 4 }}>
                  {t.settingsModelsAdded({ count: draft.models.length })}
                </p>
                <ul className="flex flex-col gap-1">
                  {draft.models.map((name) => (
                    <li
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1"
                      key={name}
                    >
                      <label className="checkbox min-w-0 flex-1">
                        <input
                          checked={draft.model === name}
                          name="p-model-in-use"
                          onChange={() => setDraft({ ...draft, model: name })}
                          type="radio"
                        />
                        <span className="min-w-0 truncate">{name}</span>
                        {draft.model === name && (
                          <span className="shrink-0 text-faint">{t.settingsModelActive}</span>
                        )}
                      </label>
                      <button className="shrink-0" onClick={() => removeModel(name)} type="button">
                        {t.settingsModelRemove}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="hint" style={{ marginBottom: 0 }}>
              {t.settingsModelActiveHint}
            </p>
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
                <label htmlFor="p-thinking">{t.settingsThinkingEffort}</label>
                <select
                  id="p-thinking"
                  onChange={(event) => setDraft({ ...draft, thinkingEffort: event.target.value })}
                  value={draft.thinkingEffort}
                >
                  <option value="">{t.settingsThinkingEffortDefault}</option>
                  {THINKING_LEVELS.map((level) => (
                    <option disabled={!thinkingLevels.includes(level)} key={level} value={level}>
                      {thinkingLabel(level)}
                    </option>
                  ))}
                </select>
                {draftThinking && (
                  <p className="hint" style={{ marginBottom: 0 }}>
                    {t.settingsThinkingParamNote({
                      param: thinkingParamSummary(draft.baseUrl, draft.model, draftThinking),
                    })}
                  </p>
                )}
              </div>
              {thinkingSupport === 'unsupported' && (
                <div className="mb-3 rounded-lg border border-err bg-err-surface px-3 py-2 text-[12.5px] text-err">
                  {t.settingsThinkingModelUnsupported({ model: draft.model })}
                </div>
              )}
              {!thinkingVerified && (
                <div className="mb-3 rounded-lg border border-warn/30 bg-warn-surface px-3 py-2 text-[12.5px] text-warn">
                  {t.settingsThinkingUnverified}
                </div>
              )}
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
          {t.settingsImageModelCurrentValue({ value: choiceLabel(settings.imageModel) })}
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
          <button onClick={openImageDialog} type="button">
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
              {(imgModels ?? []).map((model) => (
                <option key={model} value={model}>
                  {model}
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
          {t.settingsImageModelCurrentValue({ value: choiceLabel(settings.takeoverModel) })}
        </p>

        <Switch
          checked={settings.takeoverOnRun}
          label={t.settingsTakeoverOnRun}
          onChange={(takeoverOnRun) =>
            void mutate({
              type: 'settings.set',
              patch: { takeoverOnRun },
            })
          }
        />
        <p className="hint">{t.settingsTakeoverOnRunIntro}</p>

        <Switch
          checked={settings.autoRepairOnRun}
          label={t.settingsAutoRepairOnRun}
          onChange={(autoRepairOnRun) =>
            void mutate({
              type: 'settings.set',
              patch: { autoRepairOnRun },
            })
          }
        />
        <p className="hint">{t.settingsAutoRepairOnRunIntro}</p>

        <div className="actions">
          <button onClick={openTakeoverDialog} type="button">
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
              onChange={(event) =>
                setTakeoverDraft({ ...takeoverDraft, model: event.target.value })
              }
              value={takeoverDraft.model}
            >
              <option value="">{t.settingsProviderDefault}</option>
              {takeoverDraft.model && !(takeoverModels ?? []).includes(takeoverDraft.model) && (
                <option value={takeoverDraft.model}>{takeoverDraft.model}</option>
              )}
              {(takeoverModels ?? []).map((model) => (
                <option key={model} value={model}>
                  {model}
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
    </div>
  )
}
