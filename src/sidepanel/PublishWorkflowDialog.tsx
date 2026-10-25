/**
 * Publish a workflow to the shared marketplace as a pull request.
 *
 * The dialog owns the editable draft and the GitHub connection; the actual
 * work is delegated to `lib/marketplace/publish` so the committed bytes never
 * depend on form state. Warnings from the sanitizer are shown before the first
 * request leaves the machine and must be acknowledged once.
 *
 * @module sidepanel/PublishWorkflowDialog
 */

import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from '../ui/FormDialog'
import { useT } from './i18n'
import type { Messages } from '../lib/i18n'
import { GitHubClient } from '../lib/marketplace/github-client'
import { compressImage } from '../lib/marketplace/image'
import { categoryLabel, isBuiltinCategory } from '../lib/marketplace/categories'
import { parseTagInput, validatePublishForm, type PublishFormError } from '../lib/marketplace/form'
import {
  preparePublish,
  pushPublish,
  type PreparedPublish,
  type PublishResult,
} from '../lib/marketplace/publish'
import { fetchPublishedAsset, fetchPublishedMeta } from '../lib/marketplace/raw'
import { isClassicToken, setAuth, clearAuth, getAuth } from '../lib/marketplace/token'
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_REPO_FULL,
  MAX_CATEGORY_CHARS,
  MAX_PUBLISH_IMAGES,
  MarketplaceError,
  type MarketplaceAuth,
} from '../lib/marketplace/types'
import { marketplaceErrorMessage } from './marketplace-errors'
import type { Workflow } from '../lib/workflow/types'

const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=public_repo&description=Browser%20Copilot'

/** Select value that reveals the free-form category input. */
const CUSTOM_CATEGORY = '__custom__'

const FORM_ERROR_KEY: Record<PublishFormError, keyof Messages> = {
  'title-required': 'marketplaceFormTitleRequired',
  'title-too-long': 'marketplaceFormTitleTooLong',
  'category-required': 'marketplaceFormCategoryRequired',
  'description-too-long': 'marketplaceFormDescriptionTooLong',
  'video-invalid': 'marketplaceFormVideoInvalid',
  'too-many-images': 'marketplaceFormTooManyImages',
  'image-too-large': 'marketplaceFormImageTooLarge',
  'image-type': 'marketplaceFormImageType',
}

/**
 * Translated reason plus the client's own detail.
 *
 * "The token was rejected" alone hides whether GitHub answered 403 or the
 * request never left the machine, which is exactly the difference a user
 * needs to fix it.
 */
export function connectFailureText(t: Messages, error: unknown): string {
  const label = marketplaceErrorMessage(t, error)
  return error instanceof MarketplaceError && error.message ? `${label} (${error.message})` : label
}

interface SelectedImage {
  blob: Blob
  url: string
}

interface Props {
  workflow: Workflow
  onClose: () => void
  onPublished?: (result: PublishResult) => void
  /** Test/preview seam: skip reading `chrome.storage.local`. */
  initialAuth?: MarketplaceAuth | null
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] leading-snug text-muted">{hint}</span>}
    </label>
  )
}

export default function PublishWorkflowDialog({
  workflow,
  onClose,
  onPublished,
  initialAuth,
}: Props): React.ReactElement {
  const t = useT()
  const [auth, setAuthState] = useState<MarketplaceAuth | null | undefined>(initialAuth)
  const [tokenInput, setTokenInput] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  const [title, setTitle] = useState(workflow.name)
  const [description, setDescription] = useState(workflow.description ?? '')
  // Select value; `CUSTOM_CATEGORY` means the publisher is naming their own.
  const [category, setCategory] = useState<string>('other')
  const [customCategory, setCustomCategory] = useState('')
  const effectiveCategory = category === CUSTOM_CATEGORY ? customCategory : category
  const [tagInput, setTagInput] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [images, setImages] = useState<SelectedImage[]>([])
  const [imageBusy, setImageBusy] = useState(false)

  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<PublishFormError | null>(null)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<PreparedPublish | null>(null)
  const [result, setResult] = useState<PublishResult | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  // Object URLs must outlive individual renders; revoke them on unmount only.
  const imagesRef = useRef<SelectedImage[]>([])
  imagesRef.current = images
  useEffect(() => {
    return () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.url)
    }
  }, [])

  useEffect(() => {
    if (initialAuth !== undefined) return
    void getAuth().then(setAuthState)
  }, [initialAuth])

  /**
   * Any edit invalidates the prepared bytes; a stale preview would publish the
   * old title/screenshots without the user noticing. The first edit also marks
   * the draft as author-owned so the async prefill cannot overwrite it.
   */
  const editedRef = useRef(false)
  const edit = (): void => {
    editedRef.current = true
    setPrepared(null)
    setPublishError(null)
  }

  const publishedSlug = workflow.marketplace?.slug
  useEffect(() => {
    if (!publishedSlug) return
    let cancelled = false
    void (async () => {
      const meta = await fetchPublishedMeta(publishedSlug).catch(() => null)
      if (!meta || cancelled || editedRef.current) return
      setTitle(meta.title)
      setDescription(meta.description)
      setCategory(isBuiltinCategory(meta.category) ? meta.category : CUSTOM_CATEGORY)
      setCustomCategory(isBuiltinCategory(meta.category) ? '' : meta.category)
      setTagInput(meta.tags.join(', '))
      setVideoUrl(meta.videoUrl ?? '')
      const blobs = await Promise.all(
        meta.images
          .slice(0, MAX_PUBLISH_IMAGES)
          .map((asset) => fetchPublishedAsset(publishedSlug, asset)),
      )
      if (cancelled || editedRef.current) return
      const restored = blobs
        .filter((blob): blob is Blob => blob !== null)
        .map((blob) => ({ blob, url: URL.createObjectURL(blob) }))
      if (restored.length > 0) setImages(restored)
    })()
    return () => {
      cancelled = true
    }
  }, [publishedSlug])

  const addImages = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return
    setFormError(null)
    setImageBusy(true)
    try {
      const next = [...images]
      for (const file of Array.from(files)) {
        if (next.length >= MAX_PUBLISH_IMAGES) {
          setFormError('too-many-images')
          break
        }
        if (!file.type.startsWith('image/')) {
          setFormError('image-type')
          continue
        }
        try {
          const blob = await compressImage(file)
          next.push({ blob, url: URL.createObjectURL(blob) })
        } catch {
          setFormError('image-too-large')
        }
      }
      setImages(next)
      edit()
    } finally {
      setImageBusy(false)
    }
  }

  const connect = async (): Promise<void> => {
    const token = tokenInput.trim()
    setConnectError(null)
    if (!isClassicToken(token)) {
      setConnectError(t.marketplaceConnectInvalid)
      return
    }
    setConnecting(true)
    try {
      const me = await new GitHubClient({ token }).getUser()
      await setAuth({ token, login: me.login })
      setAuthState({ token, login: me.login })
      setTokenInput('')
    } catch (caught) {
      console.warn('[marketplace] connect failed', caught)
      setConnectError(connectFailureText(t, caught))
    } finally {
      setConnecting(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    await clearAuth()
    setAuthState(null)
    setPrepared(null)
  }

  const publish = async (acknowledged: boolean): Promise<void> => {
    if (!auth || busy) return
    const validation = validatePublishForm({
      title,
      category: effectiveCategory,
      description,
      videoUrl,
      images: images.map((image) => image.blob),
    })
    if (validation) {
      setFormError(validation)
      return
    }
    setFormError(null)
    setPublishError(null)
    setBusy(true)
    try {
      let ready = prepared
      if (!ready) {
        ready = await preparePublish(
          {
            workflow,
            title,
            description,
            category: effectiveCategory,
            tags: parseTagInput(tagInput),
            images: images.map((image) => image.blob),
            ...(videoUrl.trim() ? { videoUrl: videoUrl.trim() } : {}),
          },
          {
            author: auth.login,
            findExistingMeta: (slug) => fetchPublishedMeta(slug),
          },
        )
        setPrepared(ready)
        if (ready.warnings.length > 0 && !acknowledged) return
      }
      const pushed = await pushPublish(ready, {
        client: new GitHubClient({ token: auth.token }),
        auth,
      })
      setResult(pushed)
      onPublished?.(pushed)
    } catch (error) {
      setPublishError(marketplaceErrorMessage(t, error))
    } finally {
      setBusy(false)
    }
  }

  const warningsPending = !!prepared && prepared.warnings.length > 0 && !result
  const primaryLabel = busy
    ? t.marketplacePublishPublishing
    : warningsPending
      ? t.marketplacePublishAnyway
      : t.marketplacePublishSubmit
  const disabled = busy || imageBusy || connecting || !auth

  return (
    <FormDialog
      footer={
        result ? (
          <>
            <FormDialogCancelButton label={t.marketplaceClose} onClick={onClose} />
            <a
              className="inline-flex h-8 items-center rounded-lg border border-accent bg-accent px-3.5 text-[13px] font-semibold text-on-accent transition-colors duration-150 hover:bg-accent-strong"
              href={result.prUrl}
              rel="noreferrer"
              target="_blank"
            >
              {t.marketplacePublishOpenPr}
            </a>
          </>
        ) : (
          <>
            <FormDialogCancelButton disabled={busy} label={t.cancel} onClick={onClose} />
            <FormDialogPrimaryButton
              disabled={disabled}
              label={primaryLabel}
              onClick={() => void publish(warningsPending)}
            />
          </>
        )
      }
      onClose={onClose}
      title={t.marketplacePublishTitle}
      width="lg"
    >
      <p className="mb-3 text-[12px] leading-snug text-muted">
        {t.marketplacePublishRepoHint({ repo: MARKETPLACE_REPO_FULL })}
      </p>

      {result ? (
        <div className="rounded-lg border border-border bg-panel-2 p-3">
          <p className="m-0 text-[13px] text-ink">
            {t.marketplacePublishSuccess({ slug: result.slug, version: result.version })}
          </p>
          <p className="mt-1 mb-0 text-[12px] text-muted">{result.prUrl}</p>
        </div>
      ) : auth === undefined ? (
        <p className="m-0 text-[12.5px] text-muted">{t.marketplaceConnectLoading}</p>
      ) : (
        <>
          <section className="mb-4 rounded-lg border border-border bg-panel-2 p-3">
            <h3 className="m-0 text-[12.5px] font-semibold text-ink">
              {t.marketplaceConnectTitle}
            </h3>
            {auth ? (
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[12.5px] text-ink">
                  {t.marketplaceConnectConnected({ login: auth.login })}
                </span>
                <button
                  className="border-0! bg-transparent! p-0! text-[12px]! text-accent!"
                  disabled={busy}
                  onClick={() => void disconnect()}
                  type="button"
                >
                  {t.marketplaceConnectDisconnect}
                </button>
              </div>
            ) : (
              <>
                <p className="mt-1 mb-2 text-[11.5px] leading-snug text-muted">
                  {t.marketplaceConnectHint}{' '}
                  <a className="text-accent" href={TOKEN_URL} rel="noreferrer" target="_blank">
                    {t.marketplaceConnectCreateToken}
                  </a>
                </p>
                <div className="flex items-center gap-2">
                  <input
                    autoComplete="off"
                    className="min-w-0 flex-1"
                    disabled={connecting}
                    onChange={(event) => {
                      setTokenInput(event.target.value)
                      setConnectError(null)
                    }}
                    placeholder={t.marketplaceConnectTokenPlaceholder}
                    type="password"
                    value={tokenInput}
                  />
                  <button
                    className="section-action"
                    disabled={connecting || !tokenInput.trim()}
                    onClick={() => void connect()}
                    type="button"
                  >
                    {t.marketplaceConnectButton}
                  </button>
                </div>
                <p className="mt-1 mb-0 text-[11px] leading-snug text-muted">
                  {t.marketplaceConnectScopeHint}
                </p>
                {connectError && (
                  <p className="mt-1 mb-0 text-[11.5px] text-err" role="alert">
                    {connectError}
                  </p>
                )}
              </>
            )}
          </section>

          {auth && (
            <>
              <Field label={t.marketplaceFieldTitle}>
                <input
                  disabled={busy}
                  onChange={(event) => {
                    setTitle(event.target.value)
                    edit()
                  }}
                  placeholder={t.marketplaceFieldTitlePlaceholder}
                  value={title}
                />
              </Field>
              <Field label={t.marketplaceFieldDescription}>
                <textarea
                  disabled={busy}
                  onChange={(event) => {
                    setDescription(event.target.value)
                    edit()
                  }}
                  placeholder={t.marketplaceFieldDescriptionPlaceholder}
                  rows={3}
                  value={description}
                />
              </Field>

              <div className="flex gap-3">
                <div className="min-w-0 flex-1">
                  <Field label={t.marketplaceFieldCategory}>
                    <select
                      disabled={busy}
                      onChange={(event) => {
                        setCategory(event.target.value)
                        edit()
                      }}
                      value={category}
                    >
                      {MARKETPLACE_CATEGORIES.map((item) => (
                        <option key={item} value={item}>
                          {categoryLabel(t, item)}
                        </option>
                      ))}
                      <option value={CUSTOM_CATEGORY}>{t.marketplaceCategoryCustom}</option>
                    </select>
                  </Field>
                  {/* A second labelable control inside one <label> breaks the
                      implicit association, so the custom name gets its own. */}
                  {category === CUSTOM_CATEGORY && (
                    <Field label={t.marketplaceFieldCustomCategory}>
                      <input
                        disabled={busy}
                        maxLength={MAX_CATEGORY_CHARS}
                        onChange={(event) => {
                          setCustomCategory(event.target.value)
                          edit()
                        }}
                        placeholder={t.marketplaceFieldCustomCategoryPlaceholder}
                        value={customCategory}
                      />
                    </Field>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <Field hint={t.marketplaceFieldTagsHint} label={t.marketplaceFieldTags}>
                    <input
                      disabled={busy}
                      onChange={(event) => {
                        setTagInput(event.target.value)
                        edit()
                      }}
                      placeholder={t.marketplaceFieldTagsPlaceholder}
                      value={tagInput}
                    />
                  </Field>
                </div>
              </div>

              <Field hint={t.marketplaceFieldVideoHint} label={t.marketplaceFieldVideo}>
                <input
                  disabled={busy}
                  onChange={(event) => {
                    setVideoUrl(event.target.value)
                    edit()
                  }}
                  placeholder="https://"
                  value={videoUrl}
                />
              </Field>

              <div className="mb-3">
                <span className="mb-1 block text-[12px] font-medium text-muted">
                  {t.marketplaceFieldImages}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  {images.map((image, index) => (
                    <span
                      className="relative block h-16 w-24 overflow-hidden rounded-md border border-border"
                      key={image.url}
                    >
                      <img alt="" className="h-full w-full object-cover" src={image.url} />
                      <button
                        aria-label={t.marketplaceImagesRemove}
                        className="absolute right-0.5 top-0.5 flex! h-5! w-5! items-center! justify-center! rounded! border-0! bg-panel! p-0! text-ink!"
                        disabled={busy}
                        onClick={() => {
                          URL.revokeObjectURL(image.url)
                          setImages((current) => current.filter((_, i) => i !== index))
                          edit()
                        }}
                        title={t.marketplaceImagesRemove}
                        type="button"
                      >
                        <Trash2 size={11} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                  {images.length < MAX_PUBLISH_IMAGES && (
                    <button
                      className="flex h-16 w-24 items-center justify-center rounded-md border border-dashed border-border text-muted hover:bg-hover"
                      disabled={busy || imageBusy}
                      onClick={() => fileInputRef.current?.click()}
                      type="button"
                    >
                      <ImagePlus size={16} aria-hidden="true" />
                    </button>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  accept="image/*"
                  multiple
                  onChange={(event) => {
                    void addImages(event.target.files).finally(() => {
                      event.target.value = ''
                    })
                  }}
                  style={{ display: 'none' }}
                  type="file"
                />
                <span className="mt-1 block text-[11.5px] leading-snug text-muted">
                  {imageBusy ? t.marketplaceImagesCompressing : t.marketplaceFieldImagesHint}
                </span>
              </div>

              {warningsPending && (
                <section className="mb-3 rounded-lg border border-border bg-accent-soft p-3">
                  <h3 className="m-0 text-[12.5px] font-semibold text-ink">
                    {t.marketplacePublishWarningsTitle}
                  </h3>
                  <ul className="mt-1 mb-0 list-disc pl-4 text-[11.5px] leading-snug text-ink">
                    {prepared.warnings.map((warning, index) => (
                      <li key={`${warning.nodeLabel}-${warning.param}-${index}`}>
                        {warning.kind === 'credential-literal'
                          ? t.marketplacePublishWarningCredential({
                              node: warning.nodeLabel,
                              param: warning.param,
                            })
                          : t.marketplacePublishWarningEmbeddedData({
                              node: warning.nodeLabel,
                              param: warning.param,
                            })}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 mb-0 text-[11px] leading-snug text-muted">
                    {t.marketplacePublishWarningsHint}
                  </p>
                </section>
              )}

              {formError && (
                <p className="m-0 text-[12px] text-err" role="alert">
                  {t[FORM_ERROR_KEY[formError]] as string}
                </p>
              )}
              {publishError && (
                <p className="m-0 text-[12px] text-err" role="alert">
                  {publishError}
                </p>
              )}
            </>
          )}
        </>
      )}
    </FormDialog>
  )
}
