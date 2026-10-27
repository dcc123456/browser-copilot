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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ImagePlus, Paperclip, Trash2 } from 'lucide-react'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from '../ui/FormDialog'
import { useT } from './i18n'
import type { Messages } from '../lib/i18n'
import { GitHubClient } from '../lib/marketplace/github-client'
import { compressImage } from '../lib/marketplace/image'
import { formatAttachmentSize } from '../lib/marketplace/attachments'
import { categoryLabel, isBuiltinCategory } from '../lib/marketplace/categories'
import { collectDependencies } from '../lib/marketplace/dependencies'
import { parseTagInput, validatePublishForm, type PublishFormError } from '../lib/marketplace/form'
import {
  applySecretOverrides,
  planPublishedSecrets,
  secretValueKey,
} from '../lib/marketplace/secrets'
import {
  preparePublish,
  pushPublish,
  type PreparedPublish,
  type PublishResult,
} from '../lib/marketplace/publish'
import type { PublishWarning } from '../lib/marketplace/sanitize'
import {
  fetchPublishedAsset,
  fetchPublishedMeta,
  fetchRepoAsset,
  fetchRepoMeta,
  type RepoReadAccess,
} from '../lib/marketplace/raw'
import { invalidateCatalogCache, TEAM_CATALOG_CACHE_KEY } from '../lib/marketplace/catalog'
import { PUBLIC_REPO, repoFullName, type RepoRef } from '../lib/marketplace/repo'
import { getTeamAuth, getTeamRepo, teamRepoRef, type TeamRepoConfig } from '../lib/marketplace/team'
import { sendCommand } from '../lib/messages'
import type { PasswordEntry } from '../lib/types'
import {
  blobToDraftFile,
  clearDraft,
  DRAFT_SCHEMA_VERSION,
  draftFileToBlob,
  loadDraft,
  saveDraft,
  type PublishDraft,
} from '../lib/marketplace/draft'
import { isClassicToken, setAuth, clearAuth, getAuth } from '../lib/marketplace/token'
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_REPO_FULL,
  MAX_BUNDLE_WORKFLOWS,
  MAX_CATEGORY_CHARS,
  MAX_PUBLISH_ATTACHMENT_BYTES,
  MAX_PUBLISH_ATTACHMENTS,
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

/** Which repository the listing goes to. */
type PublishTarget = 'public' | 'team'

const FORM_ERROR_KEY: Record<PublishFormError, keyof Messages> = {
  'title-required': 'marketplaceFormTitleRequired',
  'title-too-long': 'marketplaceFormTitleTooLong',
  'category-required': 'marketplaceFormCategoryRequired',
  'description-too-long': 'marketplaceFormDescriptionTooLong',
  'video-invalid': 'marketplaceFormVideoInvalid',
  'too-many-images': 'marketplaceFormTooManyImages',
  'image-too-large': 'marketplaceFormImageTooLarge',
  'image-type': 'marketplaceFormImageType',
  'too-many-attachments': 'marketplaceFormTooManyAttachments',
  'attachment-too-large': 'marketplaceFormAttachmentTooLarge',
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

/** A small file committed with the listing; the name is what the card shows. */
interface SelectedAttachment {
  name: string
  blob: Blob
  url: string
}

/** One warning line; a bundled workflow names itself so the node is findable. */
function warningText(t: Messages, warning: PublishWarning): string {
  if (warning.kind === 'secret-value') {
    return t.marketplacePublishWarningSecretValue({
      credential: warning.nodeLabel,
      field: warning.param,
    })
  }
  if (warning.kind === 'credential-literal') {
    return warning.workflow
      ? t.marketplacePublishWarningBundledCredential({
          workflow: warning.workflow,
          node: warning.nodeLabel,
          param: warning.param,
        })
      : t.marketplacePublishWarningCredential({
          node: warning.nodeLabel,
          param: warning.param,
        })
  }
  return warning.workflow
    ? t.marketplacePublishWarningBundledEmbeddedData({
        workflow: warning.workflow,
        node: warning.nodeLabel,
        param: warning.param,
      })
    : t.marketplacePublishWarningEmbeddedData({
        node: warning.nodeLabel,
        param: warning.param,
      })
}

interface Props {
  workflow: Workflow
  /** The whole local library, so called workflows can be bundled. */
  library: readonly Workflow[]
  onClose: () => void
  onPublished?: (result: PublishResult) => void
  /** Test/preview seam: skip reading `chrome.storage.local`. */
  initialAuth?: MarketplaceAuth | null
  /** Test/preview seam: the stored team connection; `null` means none. */
  initialTeam?: { config: TeamRepoConfig; auth: MarketplaceAuth } | null
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
  library,
  onClose,
  onPublished,
  initialAuth,
  initialTeam,
}: Props): React.ReactElement {
  const t = useT()
  /**
   * The same scan `preparePublish` will run, shown before anything is sent so
   * the publisher knows which other workflows become public with this one.
   */
  const bundle = useMemo(() => collectDependencies(workflow, library), [workflow, library])
  const missingRefs = bundle.missing.map((call) => call.workflowId || call.nodeLabel)
  const tooMany = bundle.dependencies.length > MAX_BUNDLE_WORKFLOWS
  /**
   * The credentials the published graphs reference, defaulted from the local
   * vault. Password fields arrive empty, everything else carries the local
   * value; `secretValues` holds only what the publisher typed over.
   */
  const [vault, setVault] = useState<PasswordEntry[] | null>(null)
  const [secretValues, setSecretValues] = useState<Record<string, string>>({})
  const secretPlan = useMemo(
    () =>
      planPublishedSecrets(
        [workflow, ...bundle.dependencies.map((item) => item.workflow)],
        vault ?? [],
      ),
    [workflow, bundle, vault],
  )
  const secrets = useMemo(
    () => applySecretOverrides(secretPlan.secrets, secretValues),
    [secretPlan, secretValues],
  )
  // Until the listing arrives every reference looks missing; say nothing yet.
  const missingCredentials = vault === null ? [] : secretPlan.missing
  const [auth, setAuthState] = useState<MarketplaceAuth | null | undefined>(initialAuth)
  const [tokenInput, setTokenInput] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  // Re-editing a workflow published to the team repo starts on that target.
  const [target, setTarget] = useState<PublishTarget>(
    workflow.marketplace?.repo && workflow.marketplace.repo !== MARKETPLACE_REPO_FULL
      ? 'team'
      : 'public',
  )
  /** Undefined while loading; null when no team repository is connected. */
  const [teamConfig, setTeamConfig] = useState<TeamRepoConfig | null | undefined>(
    initialTeam === undefined ? undefined : (initialTeam?.config ?? null),
  )
  const [teamAuth, setTeamAuth] = useState<MarketplaceAuth | null>(initialTeam?.auth ?? null)

  useEffect(() => {
    if (initialTeam !== undefined) return
    void Promise.all([getTeamRepo(), getTeamAuth()]).then(([config, token]) => {
      setTeamConfig(config)
      setTeamAuth(token)
    })
  }, [initialTeam])

  const teamRef = useMemo(() => (teamConfig ? teamRepoRef(teamConfig) : null), [teamConfig])
  const targetRepo: RepoRef = target === 'team' && teamRef ? teamRef : PUBLIC_REPO
  const targetRepoName = repoFullName(targetRepo)
  const targetAuth = target === 'team' ? teamAuth : auth
  const teamUnavailable = target === 'team' && (!teamRef || !teamAuth)
  const teamReadOnly = target === 'team' && teamConfig?.canPush === false
  const targetReady = target === 'team' ? !teamUnavailable && !teamReadOnly : !!auth
  /**
   * Credential overrides typed for one repository must never be restored into
   * the other's form, so a draft belongs to one target (and one team repo).
   */
  const draftKey =
    target === 'team' ? `${workflow.id}@${teamRef ? repoFullName(teamRef) : 'team'}` : workflow.id
  const draftKeyRef = useRef(draftKey)
  draftKeyRef.current = draftKey

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
  const [attachments, setAttachments] = useState<SelectedAttachment[]>([])
  /** The form was filled from a saved draft rather than the published copy. */
  const [restoredDraft, setRestoredDraft] = useState(false)

  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<PublishFormError | null>(null)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<PreparedPublish | null>(null)
  const [result, setResult] = useState<PublishResult | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  // Object URLs must outlive individual renders; revoke them on unmount only.
  const imagesRef = useRef<SelectedImage[]>([])
  imagesRef.current = images
  const attachmentsRef = useRef<SelectedAttachment[]>([])
  attachmentsRef.current = attachments
  // Unmount cleanup reads the latest form without re-subscribing every render.
  const formRef = useRef({
    title,
    description,
    category,
    customCategory,
    tagInput,
    videoUrl,
    images,
    attachments,
    secretValues,
  })
  formRef.current = {
    title,
    description,
    category,
    customCategory,
    tagInput,
    videoUrl,
    images,
    attachments,
    secretValues,
  }
  const resultRef = useRef<PublishResult | null>(null)
  resultRef.current = result
  useEffect(() => {
    return () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.url)
      for (const file of attachmentsRef.current) URL.revokeObjectURL(file.url)
    }
  }, [])

  useEffect(() => {
    if (initialAuth !== undefined) return
    void getAuth().then(setAuthState)
  }, [initialAuth])

  useEffect(() => {
    let cancelled = false
    void sendCommand({ type: 'passwords.list' })
      .then((listing) => {
        if (!cancelled) setVault(listing.type === 'passwords.list' ? listing.entries : [])
      })
      .catch(() => {
        if (!cancelled) setVault([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Any edit invalidates the prepared bytes; a stale preview would publish the
   * old title/screenshots without the user noticing.
   */
  // The form holds content the user owns; the async prefill must not repaint it.
  const formOwnedRef = useRef(false)
  // Something changed since the dialog opened; closing must keep a draft.
  const draftDirtyRef = useRef(false)
  const edit = (): void => {
    formOwnedRef.current = true
    draftDirtyRef.current = true
    setPrepared(null)
    setPublishError(null)
  }

  /**
   * The form's contents as a draft, or null when nothing changed since it
   * opened or the publish already succeeded. Reads refs only, so the identity
   * is stable for the unmount cleanup.
   */
  const captureDraft = useCallback(async (key: string): Promise<PublishDraft | null> => {
    const snapshot = formRef.current
    if (!draftDirtyRef.current || resultRef.current) return null
    const [draftImages, draftAttachments] = await Promise.all([
      Promise.all(snapshot.images.map((image) => blobToDraftFile(image.blob))),
      Promise.all(snapshot.attachments.map((file) => blobToDraftFile(file.blob, file.name))),
    ])
    return {
      schema: DRAFT_SCHEMA_VERSION,
      workflowId: key,
      title: snapshot.title,
      description: snapshot.description,
      category: snapshot.category,
      customCategory: snapshot.customCategory,
      tags: snapshot.tagInput,
      videoUrl: snapshot.videoUrl,
      images: draftImages,
      attachments: draftAttachments,
      secretValues: snapshot.secretValues,
      savedAt: Date.now(),
    }
  }, [])

  /**
   * A saved draft outranks the published listing: it is the user's newer,
   * unfinished copy. Marking the form author-owned up front also stops the
   * async `meta.json` prefill from overwriting it field by field. Reruns when
   * the target changes; `switchTarget` clears the ownership so the incoming
   * target can restore its own draft.
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const draft = await loadDraft(draftKey)
      if (!draft || cancelled || formOwnedRef.current) return
      formOwnedRef.current = true
      setTitle(draft.title)
      setDescription(draft.description)
      setCategory(draft.category)
      setCustomCategory(draft.customCategory)
      setTagInput(draft.tags)
      setVideoUrl(draft.videoUrl)
      setSecretValues(draft.secretValues)
      const restoredImages = draft.images.flatMap((file) => {
        const blob = draftFileToBlob(file)
        return blob ? [{ blob, url: URL.createObjectURL(blob) }] : []
      })
      setImages((current) => {
        for (const image of current) URL.revokeObjectURL(image.url)
        return restoredImages
      })
      const restoredAttachments = draft.attachments.flatMap((file) => {
        const blob = draftFileToBlob(file)
        return blob && file.name ? [{ name: file.name, blob, url: URL.createObjectURL(blob) }] : []
      })
      setAttachments((current) => {
        for (const file of current) URL.revokeObjectURL(file.url)
        return restoredAttachments
      })
      setRestoredDraft(true)
    })()
    return () => {
      cancelled = true
    }
  }, [draftKey])

  /**
   * Every close path unmounts the dialog (Escape, backdrop, cancel, switching
   * the side panel's tab), so one cleanup covers them all. A successful
   * publish has already cleared the draft, and an untouched form writes
   * nothing.
   */
  useEffect(() => {
    return () => {
      void captureDraft(draftKeyRef.current)
        .then((draft) => (draft ? saveDraft(draft) : undefined))
        .catch(() => {
          // Losing a draft must never be what breaks closing the dialog.
        })
    }
  }, [captureDraft])

  const discardDraft = (): void => {
    void clearDraft(draftKeyRef.current)
    setRestoredDraft(false)
    // Keep the form author-owned so an in-flight prefill cannot repaint it,
    // but closing now must not write the discarded draft back.
    formOwnedRef.current = true
    draftDirtyRef.current = false
    setTitle(workflow.name)
    setDescription(workflow.description ?? '')
    setCategory('other')
    setCustomCategory('')
    setTagInput('')
    setVideoUrl('')
    setSecretValues({})
    setImages((current) => {
      for (const image of current) URL.revokeObjectURL(image.url)
      return []
    })
    setAttachments((current) => {
      for (const file of current) URL.revokeObjectURL(file.url)
      return []
    })
    setPrepared(null)
    setFormError(null)
    setPublishError(null)
  }

  const publishedSlug = workflow.marketplace?.slug
  const publishedRepoName = workflow.marketplace?.repo ?? MARKETPLACE_REPO_FULL
  /** Where the current listing lives; null until the team connection loads. */
  const publishedRepo = useMemo<RepoRef | null>(() => {
    if (publishedRepoName === MARKETPLACE_REPO_FULL) return PUBLIC_REPO
    return teamRef && repoFullName(teamRef) === publishedRepoName ? teamRef : null
  }, [publishedRepoName, teamRef])

  useEffect(() => {
    if (!publishedSlug || !publishedRepo) return
    const access: RepoReadAccess | undefined =
      publishedRepo !== PUBLIC_REPO && teamAuth
        ? { client: new GitHubClient({ token: teamAuth.token }) }
        : undefined
    if (publishedRepo !== PUBLIC_REPO && !access) return
    let cancelled = false
    void (async () => {
      const meta =
        publishedRepo === PUBLIC_REPO
          ? await fetchPublishedMeta(publishedSlug).catch(() => null)
          : await fetchRepoMeta(publishedRepo, publishedSlug, access).catch(() => null)
      if (!meta || cancelled || formOwnedRef.current) return
      setTitle(meta.title)
      setDescription(meta.description)
      setCategory(isBuiltinCategory(meta.category) ? meta.category : CUSTOM_CATEGORY)
      setCustomCategory(isBuiltinCategory(meta.category) ? '' : meta.category)
      setTagInput(meta.tags.join(', '))
      setVideoUrl(meta.videoUrl ?? '')
      const blobs = await Promise.all(
        meta.images
          .slice(0, MAX_PUBLISH_IMAGES)
          .map((asset) =>
            publishedRepo === PUBLIC_REPO
              ? fetchPublishedAsset(publishedSlug, asset)
              : fetchRepoAsset(publishedRepo, publishedSlug, asset, access),
          ),
      )
      if (cancelled || formOwnedRef.current) return
      const restored = blobs
        .filter((blob): blob is Blob => blob !== null)
        .map((blob) => ({ blob, url: URL.createObjectURL(blob) }))
      if (restored.length > 0) setImages(restored)
      const publishedAttachments = meta.attachments ?? []
      const attachmentBlobs = await Promise.all(
        publishedAttachments.map((file) =>
          publishedRepo === PUBLIC_REPO
            ? fetchPublishedAsset(publishedSlug, file.path)
            : fetchRepoAsset(publishedRepo, publishedSlug, file.path, access),
        ),
      )
      if (cancelled || formOwnedRef.current) return
      const restoredAttachments = publishedAttachments.flatMap((file, index) => {
        const blob = attachmentBlobs[index]
        return blob ? [{ name: file.name, blob, url: URL.createObjectURL(blob) }] : []
      })
      if (restoredAttachments.length > 0) setAttachments(restoredAttachments)
    })()
    return () => {
      cancelled = true
    }
  }, [publishedSlug, publishedRepo, teamAuth])

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

  const addAttachments = (files: FileList | null): void => {
    if (!files || files.length === 0) return
    setFormError(null)
    const next = [...attachments]
    for (const file of Array.from(files)) {
      if (next.length >= MAX_PUBLISH_ATTACHMENTS) {
        setFormError('too-many-attachments')
        break
      }
      if (file.size > MAX_PUBLISH_ATTACHMENT_BYTES) {
        setFormError('attachment-too-large')
        continue
      }
      next.push({ name: file.name, blob: file, url: URL.createObjectURL(file) })
    }
    setAttachments(next)
    edit()
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

  /** A new target invalidates the prepared bytes and any error from the old one. */
  const switchTarget = (next: PublishTarget): void => {
    if (next === target) return
    // Keep the outgoing target's unfinished form under its own key, then let
    // the incoming target's draft (if any) take over the form.
    void captureDraft(draftKeyRef.current)
      .then((draft) => (draft ? saveDraft(draft) : undefined))
      .catch(() => {})
    draftDirtyRef.current = false
    formOwnedRef.current = false
    setRestoredDraft(false)
    // Credential values belong to the repository they were typed for.
    setSecretValues({})
    setTarget(next)
    setPrepared(null)
    setPublishError(null)
    setFormError(null)
    setConnectError(null)
  }

  const publish = async (acknowledged: boolean): Promise<void> => {
    if (!targetAuth || busy) return
    const validation = validatePublishForm({
      title,
      category: effectiveCategory,
      description,
      videoUrl,
      images: images.map((image) => image.blob),
      attachments: attachments.map((file) => ({ name: file.name, size: file.blob.size })),
    })
    if (validation) {
      setFormError(validation)
      return
    }
    setFormError(null)
    setPublishError(null)
    setBusy(true)
    try {
      const isTeam = target === 'team'
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
            attachments: attachments.map((file) => ({ name: file.name, blob: file.blob })),
            secrets,
            ...(videoUrl.trim() ? { videoUrl: videoUrl.trim() } : {}),
          },
          {
            author: targetAuth.login,
            findExistingMeta: (slug) =>
              isTeam
                ? fetchRepoMeta(targetRepo, slug, {
                    client: new GitHubClient({ token: targetAuth.token }),
                  })
                : fetchPublishedMeta(slug),
            library,
            ...(isTeam ? { repo: targetRepoName } : {}),
          },
        )
        setPrepared(ready)
        if (ready.warnings.length > 0 && !acknowledged) return
      }
      const pushed = await pushPublish(ready, {
        client: new GitHubClient({ token: targetAuth.token }),
        auth: targetAuth,
        ...(isTeam ? { repo: targetRepo } : {}),
      })
      setResult(pushed)
      resultRef.current = pushed
      void clearDraft(draftKeyRef.current).catch(() => {})
      if (pushed.merged) {
        void invalidateCatalogCache(isTeam ? TEAM_CATALOG_CACHE_KEY : undefined).catch(() => {})
      }
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
  const disabled =
    busy ||
    imageBusy ||
    connecting ||
    !targetReady ||
    vault === null ||
    missingRefs.length > 0 ||
    missingCredentials.length > 0 ||
    tooMany

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
      {!result && (
        <label className="mb-3 block">
          <span className="mb-1 block text-[12px] font-medium text-muted">
            {t.marketplacePublishTarget}
          </span>
          <select
            aria-label={t.marketplacePublishTarget}
            className="w-full"
            disabled={busy}
            onChange={(event) => switchTarget(event.target.value as PublishTarget)}
            value={target}
          >
            <option value="public">{t.marketplacePublishTargetPublic}</option>
            <option value="team">{t.marketplacePublishTargetTeam}</option>
          </select>
        </label>
      )}
      {!(target === 'team' && teamUnavailable) && (
        <p className="mb-3 text-[12px] leading-snug text-muted">
          {t.marketplacePublishRepoHint({ repo: targetRepoName })}
        </p>
      )}

      {result ? (
        <div className="rounded-lg border border-border bg-panel-2 p-3">
          <p className="m-0 text-[13px] text-ink">
            {result.merged
              ? t.marketplacePublishMerged({ slug: result.slug, version: result.version })
              : t.marketplacePublishSuccess({ slug: result.slug, version: result.version })}
          </p>
          {!result.merged && (
            <p className="mt-1 mb-0 text-[12px] text-muted">{t.marketplacePublishMergePending}</p>
          )}
          <p className="mt-1 mb-0 text-[12px] text-muted">{result.prUrl}</p>
        </div>
      ) : (target === 'team' ? teamConfig === undefined : auth === undefined) ? (
        <p className="m-0 text-[12.5px] text-muted">{t.marketplaceConnectLoading}</p>
      ) : (
        <>
          {target === 'team' ? (
            <section className="mb-4 rounded-lg border border-border bg-panel-2 p-3">
              <h3 className="m-0 text-[12.5px] font-semibold text-ink">
                {t.marketplaceConnectTitle}
              </h3>
              {teamUnavailable ? (
                <p className="mt-1 mb-0 text-[11.5px] leading-snug text-muted">
                  {t.marketplacePublishTeamMissing}
                </p>
              ) : (
                <>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[12.5px] text-ink">
                      {t.marketplacePublishTeamConnected({
                        repo: targetRepoName,
                        login: teamAuth?.login ?? '',
                      })}
                    </span>
                  </div>
                  {teamReadOnly && (
                    <p className="mt-1 mb-0 text-[11.5px] leading-snug text-warn">
                      {t.settingsTeamReadOnlyWarning}
                    </p>
                  )}
                </>
              )}
            </section>
          ) : (
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
          )}

          {targetReady && (
            <>
              {restoredDraft && (
                <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-panel-2 px-2 py-1 text-[11.5px] leading-snug text-muted">
                  <span>{t.marketplaceDraftRestored}</span>
                  <button
                    className="border-0! bg-transparent! p-0! text-[11.5px]! text-accent!"
                    disabled={busy}
                    onClick={discardDraft}
                    type="button"
                  >
                    {t.marketplaceDraftDiscard}
                  </button>
                </p>
              )}
              {(bundle.dependencies.length > 0 || missingRefs.length > 0) && (
                <section className="mb-4 rounded-lg border border-border bg-panel-2 p-3">
                  <h3 className="m-0 text-[12.5px] font-semibold text-ink">
                    {t.marketplacePublishBundleTitle}
                  </h3>
                  {bundle.dependencies.length > 0 && (
                    <>
                      <p className="mt-1 mb-1 text-[11.5px] leading-snug text-muted">
                        {t.marketplacePublishBundleHint({ count: bundle.dependencies.length })}
                      </p>
                      <ul className="m-0 list-disc pl-4 text-[11.5px] leading-snug text-ink">
                        {bundle.dependencies.map((dependency) => (
                          <li key={dependency.path}>
                            {dependency.workflow.name || dependency.workflow.id}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {tooMany && (
                    <p className="mt-1 mb-0 text-[11.5px] leading-snug text-err" role="alert">
                      {t.marketplacePublishBundleTooMany({ count: bundle.dependencies.length })}
                    </p>
                  )}
                  {missingRefs.length > 0 && (
                    <p className="mt-1 mb-0 text-[11.5px] leading-snug text-err" role="alert">
                      {t.marketplacePublishBundleMissing({ names: missingRefs.join(', ') })}
                    </p>
                  )}
                </section>
              )}
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
                      aria-label={t.marketplaceFieldCategory}
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

              <div className="mb-3">
                <span className="mb-1 block text-[12px] font-medium text-muted">
                  {t.marketplaceFieldAttachments}
                </span>
                {attachments.length > 0 && (
                  <ul className="m-0 list-none space-y-1 p-0">
                    {attachments.map((file, index) => (
                      <li
                        className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-[11.5px] text-ink"
                        key={file.url}
                      >
                        <span className="min-w-0 flex-1 truncate" title={file.name}>
                          {file.name}
                        </span>
                        <span className="shrink-0 text-muted">
                          {formatAttachmentSize(file.blob.size)}
                        </span>
                        <button
                          aria-label={t.marketplaceAttachmentsRemove}
                          className="flex! h-5! w-5! shrink-0 items-center! justify-center! rounded! border-0! bg-transparent! p-0! text-muted! hover:text-ink!"
                          disabled={busy}
                          onClick={() => {
                            URL.revokeObjectURL(file.url)
                            setAttachments((current) => current.filter((_, i) => i !== index))
                            edit()
                          }}
                          title={t.marketplaceAttachmentsRemove}
                          type="button"
                        >
                          <Trash2 size={11} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {attachments.length < MAX_PUBLISH_ATTACHMENTS && (
                  <button
                    className="mt-1 inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-[11.5px] text-muted hover:bg-hover"
                    disabled={busy}
                    onClick={() => attachmentInputRef.current?.click()}
                    type="button"
                  >
                    <Paperclip size={12} aria-hidden="true" />
                    {t.marketplaceAttachmentsAdd}
                  </button>
                )}
                <input
                  ref={attachmentInputRef}
                  className="hidden"
                  multiple
                  onChange={(event) => {
                    addAttachments(event.target.files)
                    event.target.value = ''
                  }}
                  type="file"
                />
                <span className="mt-1 block text-[11.5px] leading-snug text-muted">
                  {t.marketplaceFieldAttachmentsHint}
                </span>
              </div>

              {(secrets.length > 0 || missingCredentials.length > 0) && (
                <section className="mb-3 rounded-lg border border-border bg-panel-2 p-3">
                  <h3 className="m-0 text-[12.5px] font-semibold text-ink">
                    {t.marketplaceFieldSecrets}
                  </h3>
                  <p className="mt-1 mb-2 text-[11.5px] leading-snug text-muted">
                    {t.marketplaceFieldSecretsHint}
                  </p>
                  {secrets.map((secret) => (
                    <div className="mt-2 first:mt-0" key={secret.id}>
                      <div className="text-[12px] font-medium text-ink">
                        {secret.label || secret.id}
                      </div>
                      {secret.fields.map((field) => (
                        <label className="mt-1 block" key={field.key}>
                          <span className="mb-0.5 block text-[11.5px] text-muted">{field.key}</span>
                          <input
                            autoComplete="off"
                            disabled={busy}
                            onChange={(event) => {
                              const value = event.target.value
                              setSecretValues((current) => ({
                                ...current,
                                [secretValueKey(secret.id, field.key)]: value,
                              }))
                              edit()
                            }}
                            type={field.secret ? 'password' : 'text'}
                            value={field.value}
                          />
                          {field.secret && (
                            <span className="mt-1 block text-[11px] leading-snug text-muted">
                              {t.marketplaceSecretsPasswordHint}
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                  ))}
                  {missingCredentials.length > 0 && (
                    <p className="mt-1 mb-0 text-[11.5px] leading-snug text-err" role="alert">
                      {t.marketplaceSecretsMissing({ names: missingCredentials.join(', ') })}
                    </p>
                  )}
                </section>
              )}

              {warningsPending && (
                <section className="mb-3 rounded-lg border border-border bg-accent-soft p-3">
                  <h3 className="m-0 text-[12.5px] font-semibold text-ink">
                    {t.marketplacePublishWarningsTitle}
                  </h3>
                  <ul className="mt-1 mb-0 list-disc pl-4 text-[11.5px] leading-snug text-ink">
                    {prepared.warnings.map((warning, index) => (
                      <li
                        key={`${warning.workflow ?? ''}-${warning.nodeLabel}-${warning.param}-${index}`}
                      >
                        {warningText(t, warning)}
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
