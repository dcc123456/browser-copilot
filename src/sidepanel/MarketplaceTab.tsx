/**
 * Marketplace tab: browse the shared workflow repository and install a copy.
 *
 * Reading is anonymous and cached for {@link MARKETPLACE_CACHE_TTL_MS}; the
 * three API calls behind one refresh are the whole cost of the page. Applying
 * is a local write only — an imported workflow arrives with its trigger
 * disabled and never starts by itself.
 *
 * @module sidepanel/MarketplaceTab
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, RefreshCw, ThumbsUp } from 'lucide-react'
import { sendCommand } from '../lib/messages'
import { onStoreChanged } from '../lib/store-events'
import type { Workflow } from '../lib/workflow/types'
import { findInstalled } from '../lib/marketplace/apply'
import { formatAttachmentSize } from '../lib/marketplace/attachments'
import { categoryKey, categoryLabel, categoryOptions } from '../lib/marketplace/categories'
import { chromeCatalogCache, loadCatalog, type LoadCatalogResult } from '../lib/marketplace/catalog'
import {
  chromeReactionCache,
  listAllComments,
  postComment,
  toggleLike,
  type ReactionCache,
} from '../lib/marketplace/engagement'
import { GitHubClient, type GitHubComment } from '../lib/marketplace/github-client'
import { assetRepoPath, needsUpdate, workflowDir } from '../lib/marketplace/meta'
import { unpublishWorkflow } from '../lib/marketplace/publish'
import { rawUrl } from '../lib/marketplace/raw'
import { clearAuth, getAuth } from '../lib/marketplace/token'
import {
  MARKETPLACE_BRANCH,
  MARKETPLACE_REPO_FULL,
  MarketplaceError,
  type MarketplaceAuth,
  type MarketplaceCard,
} from '../lib/marketplace/types'
import { confirmDialog } from '../ui/confirm'
import { useI18n, useT } from './i18n'
import { installFromCard } from './marketplace-install'
import { marketplaceErrorMessage } from './marketplace-errors'

type SortMode = 'recent' | 'likes'

/** `all` plus a built-in slug or a publisher-defined label. */
type CategoryFilter = string

interface Props {
  /** The tab is mounted from startup; the catalog loads on first activation. */
  active: boolean
}

function matchesQuery(card: MarketplaceCard, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  const meta = card.meta
  return (
    meta.title.toLowerCase().includes(needle) ||
    meta.description.toLowerCase().includes(needle) ||
    meta.author.toLowerCase().includes(needle) ||
    meta.tags.some((tag) => tag.toLowerCase().includes(needle))
  )
}

function updatedAtOf(card: MarketplaceCard): number {
  return Date.parse(card.meta.updatedAt) || 0
}

interface ThreadState {
  status: 'loading' | 'ready' | 'error'
  comments: GitHubComment[]
  error?: string
}

/**
 * Local like state per merged PR. `liked` comes from the stored reaction id
 * (the catalog cannot tell whether THIS device reacted); `likes: null` means
 * "nothing clicked here yet", so the count keeps following the catalog.
 */
interface LikeState {
  liked: boolean
  likes: number | null
}

/**
 * Shared look for the icon actions on a card. Icons carry the meaning so the
 * row fits a narrow side panel; the number beside each icon is its count.
 * The `!` modifiers are required: `styles.css` styles bare `button`s with
 * unlayered rules, which beat Tailwind's layered utilities. `inline-flex`
 * keeps Chrome from collapsing the inline <svg> to zero width.
 */
const CARD_ACTION_BASE =
  'inline-flex h-6! flex-none items-center gap-1 rounded-md border px-2! py-0! text-[11px] transition-colors duration-150'
const CARD_ACTION_IDLE =
  'border-border! bg-transparent! text-muted! hover:border-accent! hover:text-accent!'
const CARD_ACTION_ACTIVE = 'border-accent! bg-accent-soft! text-accent!'

/** GitHub's mark, which lucide dropped from its brand icons. */
function GitHubMark(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5 flex-none"
      fill="currentColor"
      viewBox="0 0 16 16"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

export default function MarketplaceTab({ active }: Props): React.ReactElement {
  const t = useT()
  const { locale } = useI18n()
  const [snapshot, setSnapshot] = useState<LoadCatalogResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [sort, setSort] = useState<SortMode>('recent')

  const [installed, setInstalled] = useState<Workflow[]>([])
  const [busySlug, setBusySlug] = useState<string | null>(null)
  /** Slug whose removal PR is being opened. */
  const [removingSlug, setRemovingSlug] = useState<string | null>(null)
  /** Slugs whose published file failed validation; retried only on refresh. */
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set())

  const [auth, setAuth] = useState<MarketplaceAuth | null | undefined>(undefined)
  /** Slug whose discussion panel is expanded; one at a time. */
  const [openSlug, setOpenSlug] = useState<string | null>(null)
  const [threads, setThreads] = useState<Record<number, ThreadState>>({})
  const [likeStates, setLikeStates] = useState<Record<number, LikeState>>({})
  const [draft, setDraft] = useState('')
  const [engaging, setEngaging] = useState(false)
  const reactionCacheRef = useRef<ReactionCache | null>(null)
  const reactionCache = useCallback((): ReactionCache => {
    reactionCacheRef.current ??= chromeReactionCache()
    return reactionCacheRef.current
  }, [])

  const loadedRef = useRef(false)

  const refresh = useCallback(
    async (force: boolean, quiet = false): Promise<void> => {
      if (!quiet) setLoading(true)
      setError(null)
      try {
        const result = await loadCatalog({
          client: new GitHubClient(),
          cache: chromeCatalogCache(),
          force,
        })
        setSnapshot(result)
        if (force) setUnavailable(new Set())
      } catch (caught) {
        setError(marketplaceErrorMessage(t, caught))
        setSnapshot(null)
      } finally {
        setLoading(false)
      }
    },
    [t],
  )

  useEffect(() => {
    if (!active) return
    // The panel stays mounted for its whole lifetime, so a one-shot load would
    // freeze the catalog until a manual refresh. Re-checking on every
    // activation lets the freshness window in `loadCatalog` actually expire;
    // cached hits return without touching the spinner.
    void refresh(false, loadedRef.current)
    loadedRef.current = true
  }, [active, refresh])

  const loadInstalled = useCallback(async (): Promise<void> => {
    try {
      const result = await sendCommand({ type: 'workflows.list' })
      if (result.type === 'workflows.list') setInstalled(result.workflows)
    } catch {
      // A failed list only costs the "Added/Update" labels; browse still works.
    }
  }, [])

  useEffect(() => {
    void loadInstalled()
  }, [loadInstalled])

  useEffect(() => onStoreChanged('workflows', () => void loadInstalled()), [loadInstalled])

  useEffect(() => {
    if (!active) return
    void getAuth().then(setAuth)
  }, [active])

  // The catalog knows the public counts, not whether this device reacted; the
  // stored reaction id is the only record, so the like icon would otherwise
  // always start out unliked. Entries already toggled in this session win.
  useEffect(() => {
    const numbers = (snapshot?.cards ?? [])
      .map((card) => card.prNumber)
      .filter((issueNumber): issueNumber is number => issueNumber !== null)
    if (numbers.length === 0) return
    let cancelled = false
    const cache = reactionCache()
    void Promise.all(numbers.map((issueNumber) => cache.get(issueNumber))).then((reactionIds) => {
      if (cancelled) return
      setLikeStates((prev) => {
        const next = { ...prev }
        numbers.forEach((issueNumber, index) => {
          if (next[issueNumber]) return
          next[issueNumber] = { liked: reactionIds[index] !== null, likes: null }
        })
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [snapshot, reactionCache])

  /** GitHub's own page for the discussion: the read-only path without a token. */
  const issueUrl = (issueNumber: number): string =>
    `https://github.com/${MARKETPLACE_REPO_FULL}/pull/${issueNumber}`

  const clientForWrites = (): GitHubClient => {
    if (!auth) throw new MarketplaceError('auth-required', 'Connect GitHub first')
    return new GitHubClient({ token: auth.token })
  }

  const forgetRejectedToken = async (): Promise<void> => {
    await clearAuth()
    setAuth(null)
  }

  const loadThread = useCallback(
    async (issueNumber: number): Promise<void> => {
      setThreads((prev) => ({ ...prev, [issueNumber]: { status: 'loading', comments: [] } }))
      try {
        const client = new GitHubClient(auth ? { token: auth.token } : {})
        const comments = await listAllComments(client, issueNumber)
        setThreads((prev) => ({ ...prev, [issueNumber]: { status: 'ready', comments } }))
      } catch (caught) {
        setThreads((prev) => ({
          ...prev,
          [issueNumber]: {
            status: 'error',
            comments: [],
            error: marketplaceErrorMessage(t, caught),
          },
        }))
      }
    },
    [auth, t],
  )

  const openDetail = (card: MarketplaceCard): void => {
    const issueNumber = card.prNumber
    if (issueNumber === null) return
    if (openSlug === card.meta.slug) {
      setOpenSlug(null)
      return
    }
    setOpenSlug(card.meta.slug)
    setDraft('')
    if (!threads[issueNumber]) void loadThread(issueNumber)
  }

  const like = async (card: MarketplaceCard, issueNumber: number): Promise<void> => {
    if (!auth) {
      setBanner({
        kind: 'error',
        text: marketplaceErrorMessage(
          t,
          new MarketplaceError('auth-required', 'Connect GitHub first'),
        ),
      })
      return
    }
    setEngaging(true)
    try {
      const result = await toggleLike({
        client: clientForWrites(),
        cache: reactionCache(),
        issueNumber,
        onUnauthorized: forgetRejectedToken,
      })
      setLikeStates((prev) => {
        const currentLikes = likeStates[issueNumber]?.likes ?? card.likes
        return {
          ...prev,
          [issueNumber]: {
            liked: result.liked,
            likes: Math.max(0, currentLikes + (result.liked ? 1 : -1)),
          },
        }
      })
    } catch (caught) {
      setBanner({ kind: 'error', text: marketplaceErrorMessage(t, caught) })
    } finally {
      setEngaging(false)
    }
  }

  const sendComment = async (issueNumber: number): Promise<void> => {
    const body = draft.trim()
    if (!auth || !body) return
    setEngaging(true)
    try {
      const created = await postComment({
        client: clientForWrites(),
        cache: reactionCache(),
        issueNumber,
        body,
        onUnauthorized: forgetRejectedToken,
      })
      setThreads((prev) => {
        const current = prev[issueNumber]
        return {
          ...prev,
          [issueNumber]: {
            status: 'ready',
            comments: [...(current?.comments ?? []), created],
          },
        }
      })
      setDraft('')
      setBanner({ kind: 'ok', text: t.marketplaceCommentPosted })
    } catch (caught) {
      setBanner({ kind: 'error', text: marketplaceErrorMessage(t, caught) })
    } finally {
      setEngaging(false)
    }
  }

  const cards = useMemo(() => {
    const list = (snapshot?.cards ?? []).filter(
      (card) =>
        (category === 'all' || categoryKey(card.meta.category) === categoryKey(category)) &&
        matchesQuery(card, query.trim()),
    )
    return list.sort((a, b) =>
      sort === 'likes'
        ? b.likes - a.likes || updatedAtOf(b) - updatedAtOf(a)
        : updatedAtOf(b) - updatedAtOf(a),
    )
  }, [snapshot, category, query, sort])

  const filterCategories = useMemo(() => categoryOptions(snapshot?.cards ?? []), [snapshot])

  // The banner used to say "GitHub could not be reached" for every failure,
  // including a quota rejection that resolves by itself. Name the real cause.
  const staleError = snapshot?.staleError
  const staleText = !snapshot?.stale
    ? null
    : !staleError
      ? t.marketplaceStale
      : staleError.code === 'rate-limited'
        ? t.marketplaceStaleRateLimited({
            time: staleError.resetAt
              ? new Date(staleError.resetAt).toLocaleTimeString(
                  locale === 'zh-CN' ? 'zh-CN' : 'en-US',
                  { hour: '2-digit', minute: '2-digit' },
                )
              : undefined,
          })
        : t.marketplaceStaleReason({ reason: marketplaceErrorMessage(t, staleError) })

  const apply = async (card: MarketplaceCard): Promise<void> => {
    const existing = findInstalled(installed, card.meta.slug)
    const isUpdate = !!existing && needsUpdate(card.meta, existing.marketplace)
    const bundled = (card.meta.dependencies ?? []).map((entry) => entry.name)
    const credentials = (card.meta.secrets ?? []).map((entry) => entry.label || entry.id)
    const message = isUpdate
      ? [
          t.marketplaceUpdateMessage({ title: card.meta.title }),
          ...(bundled.length ? [t.marketplaceUpdateBundled({ names: bundled.join(', ') })] : []),
        ].join('\n\n')
      : [
          t.marketplaceTrustMessage({ title: card.meta.title, author: card.meta.author }),
          ...(bundled.length ? [t.marketplaceTrustBundled({ names: bundled.join(', ') })] : []),
          ...(credentials.length
            ? [t.marketplaceTrustSecrets({ names: credentials.join(', ') })]
            : []),
        ].join('\n\n')
    const confirmed = await confirmDialog({
      title: isUpdate ? t.marketplaceUpdateTitle : t.marketplaceTrustTitle,
      message,
      confirmText: isUpdate ? t.marketplaceUpdate : t.marketplaceTrustConfirm,
      cancelText: t.cancel,
    })
    if (!confirmed) return

    setBusySlug(card.meta.slug)
    try {
      const plan = await installFromCard(card, existing, installed)
      setBanner({
        kind: 'ok',
        text:
          plan.status === 'up-to-date'
            ? t.marketplaceApplied
            : plan.status === 'update'
              ? t.marketplaceUpdateDone({ name: plan.workflow.name })
              : t.marketplaceApplyDone({ name: plan.workflow.name }),
      })
      await loadInstalled()
    } catch (caught) {
      if (caught instanceof MarketplaceError && caught.code === 'invalid') {
        setUnavailable((prev) => new Set(prev).add(card.meta.slug))
      }
      setBanner({ kind: 'error', text: marketplaceErrorMessage(t, caught) })
    } finally {
      setBusySlug(null)
    }
  }

  /**
   * Opens the removal PR for a listing authored by the connected account.
   *
   * Nothing is removed locally: the card stays until the maintainer merges, and
   * every copy already applied keeps working afterwards.
   */
  const unpublish = async (card: MarketplaceCard): Promise<void> => {
    if (!auth) return
    const confirmed = await confirmDialog({
      title: t.marketplaceUnpublishTitle,
      message: t.marketplaceUnpublishMessage({ title: card.meta.title }),
      confirmText: t.marketplaceUnpublishConfirm,
      cancelText: t.cancel,
    })
    if (!confirmed) return

    setRemovingSlug(card.meta.slug)
    try {
      const result = await unpublishWorkflow(
        { slug: card.meta.slug, title: card.meta.title },
        { client: clientForWrites(), auth },
      )
      setBanner({
        kind: 'ok',
        text: t.marketplaceUnpublishBanner({ number: result.prNumber }),
      })
    } catch (caught) {
      if (caught instanceof MarketplaceError && caught.code === 'unauthorized') {
        await forgetRejectedToken()
      }
      setBanner({ kind: 'error', text: marketplaceErrorMessage(t, caught) })
    } finally {
      setRemovingSlug(null)
    }
  }

  return (
    <div className="pane">
      {banner && (
        <div className="banner" data-kind={banner.kind} role="status">
          {banner.text}
        </div>
      )}

      <div className="section-head">
        <h3 className="shrink-0 whitespace-nowrap">{t.tabMarketplace}</h3>
        <button
          aria-label={t.marketplaceRefresh}
          className="section-action wf-icon-action"
          disabled={loading}
          onClick={() => void refresh(true)}
          title={t.marketplaceRefresh}
          type="button"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      <p className="mt-0 mb-3 text-[12px] leading-snug text-muted">{t.marketplaceIntro}</p>

      <input
        aria-label={t.marketplaceSearchPlaceholder}
        className="mb-2 w-full"
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t.marketplaceSearchPlaceholder}
        type="search"
        value={query}
      />
      <div className="mb-3 flex gap-2">
        <select
          aria-label={t.marketplaceFilterAll}
          className="min-w-0 flex-1"
          onChange={(event) => setCategory(event.target.value as CategoryFilter)}
          value={category}
        >
          <option value="all">{t.marketplaceFilterAll}</option>
          {filterCategories.map((item) => (
            <option key={item} value={item}>
              {categoryLabel(t, item)}
            </option>
          ))}
        </select>
        <select
          aria-label={t.marketplaceSortRecent}
          className="min-w-0 flex-1"
          onChange={(event) => setSort(event.target.value as SortMode)}
          value={sort}
        >
          <option value="recent">{t.marketplaceSortRecent}</option>
          <option value="likes">{t.marketplaceSortLikes}</option>
        </select>
      </div>

      {staleText && (
        <div className="banner" data-kind="error" role="status">
          {staleText}
        </div>
      )}
      {snapshot?.truncated && (
        <p className="mt-0 mb-2 text-[11.5px] text-muted">{t.marketplaceTruncated}</p>
      )}

      {loading && !snapshot ? (
        <p className="m-0 text-[12.5px] text-muted">{t.marketplaceLoading}</p>
      ) : error ? (
        <div className="empty-state">
          <p>{t.marketplaceLoadFailed}</p>
          <p className="mt-1">{error}</p>
        </div>
      ) : (snapshot?.cards.length ?? 0) === 0 ? (
        <div className="empty-state">
          <p>{t.marketplaceEmpty}</p>
          <p className="mt-1">{t.marketplaceEmptyHint}</p>
        </div>
      ) : cards.length === 0 ? (
        <div className="empty-state">
          <p>{t.marketplaceEmptyFiltered}</p>
        </div>
      ) : (
        <ul className="task-list">
          {cards.map((card) => {
            const meta = card.meta
            const existing = findInstalled(installed, meta.slug)
            const hasUpdate = !!existing && needsUpdate(meta, existing.marketplace)
            const isUnavailable = unavailable.has(meta.slug)
            const isMine = !!auth && auth.login.toLowerCase() === meta.author.toLowerCase()
            const cover = meta.images[0]
            const sourceUrl = `https://github.com/${MARKETPLACE_REPO_FULL}/tree/${MARKETPLACE_BRANCH}/${workflowDir(meta.slug)}`
            const issueNumber = card.prNumber
            const likeState = issueNumber === null ? undefined : likeStates[issueNumber]
            const liked = likeState?.liked ?? false
            const thread = issueNumber === null ? undefined : threads[issueNumber]
            const isOpen = openSlug === meta.slug
            const bundleCount = meta.dependencies?.length ?? 0
            return (
              <li className="task-item" key={meta.slug}>
                {cover && (
                  <img
                    alt=""
                    className="mb-2 aspect-video w-full rounded-md border border-border object-cover"
                    loading="lazy"
                    src={rawUrl(assetRepoPath(meta.slug, cover))}
                  />
                )}
                <div className="task-item-head">
                  <div className="task-item-lead">
                    <strong className="task-item-name">{meta.title}</strong>
                    <a
                      aria-label={t.marketplaceViewOnGithub}
                      className="inline-flex flex-none items-center text-muted hover:text-accent"
                      href={sourceUrl}
                      rel="noreferrer"
                      target="_blank"
                      title={t.marketplaceViewOnGithub}
                    >
                      <GitHubMark />
                    </a>
                  </div>
                  {isUnavailable ? (
                    <span className="task-status task-status-failed">
                      {t.marketplaceUnavailable}
                    </span>
                  ) : hasUpdate ? (
                    <span className="task-status task-status-skipped">{t.marketplaceUpdate}</span>
                  ) : existing ? (
                    <span className="task-status task-status-ok">{t.marketplaceApplied}</span>
                  ) : null}
                </div>
                <div className="task-meta">
                  <span className="task-chip" data-chip="author">
                    {t.marketplaceByAuthor({ author: meta.author })}
                  </span>
                  <span className="task-chip bg-accent-soft! text-accent!" data-chip="category">
                    {categoryLabel(t, meta.category)}
                  </span>
                  {bundleCount > 0 && (
                    <span className="task-chip">
                      {t.marketplaceCardBundle({ count: bundleCount })}
                    </span>
                  )}
                  {meta.tags.map((tag) => (
                    <span
                      className="task-chip rounded! border border-border bg-transparent! py-0! normal-case! tracking-normal! text-muted!"
                      data-chip="tag"
                      key={tag}
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
                {meta.description && (
                  <p className="mt-1.5 mb-0 text-[12px] leading-snug text-muted">
                    {meta.description}
                  </p>
                )}
                {!!meta.attachments?.length && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
                    <span className="text-muted">{t.marketplaceCardAttachments}</span>
                    {meta.attachments.map((file) => (
                      <a
                        className="text-accent"
                        href={rawUrl(assetRepoPath(meta.slug, file.path))}
                        key={file.path}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {file.name} ({formatAttachmentSize(file.size)})
                      </a>
                    ))}
                  </div>
                )}
                <div className="actions task-actions">
                  {issueNumber !== null && (
                    <>
                      <button
                        aria-label={liked ? t.marketplaceUnlikeAction : t.marketplaceLikeAction}
                        aria-pressed={liked}
                        className={[
                          CARD_ACTION_BASE,
                          liked ? CARD_ACTION_ACTIVE : CARD_ACTION_IDLE,
                        ].join(' ')}
                        disabled={engaging}
                        onClick={() => void like(card, issueNumber)}
                        title={liked ? t.marketplaceUnlikeAction : t.marketplaceLikeAction}
                        type="button"
                      >
                        <ThumbsUp aria-hidden="true" className="h-3.5 w-3.5 flex-none" />
                        <span>{likeState?.likes ?? card.likes}</span>
                      </button>
                      <button
                        aria-expanded={isOpen}
                        aria-label={t.marketplaceCommentsTitle}
                        className={[
                          CARD_ACTION_BASE,
                          isOpen ? CARD_ACTION_ACTIVE : CARD_ACTION_IDLE,
                        ].join(' ')}
                        onClick={() => openDetail(card)}
                        title={isOpen ? t.marketplaceClose : t.marketplaceCommentsTitle}
                        type="button"
                      >
                        <MessageSquare aria-hidden="true" className="h-3.5 w-3.5 flex-none" />
                        <span>{card.comments}</span>
                      </button>
                    </>
                  )}
                  <button
                    className="task-action-run"
                    disabled={busySlug !== null || isUnavailable || (!!existing && !hasUpdate)}
                    onClick={() => void apply(card)}
                    type="button"
                  >
                    {isUnavailable
                      ? t.marketplaceUnavailable
                      : hasUpdate
                        ? t.marketplaceUpdate
                        : existing
                          ? t.marketplaceApplied
                          : t.marketplaceApply}
                  </button>
                  {isMine && (
                    <button
                      disabled={busySlug !== null || removingSlug !== null}
                      onClick={() => void unpublish(card)}
                      type="button"
                    >
                      {t.marketplaceUnpublish}
                    </button>
                  )}
                </div>
                {isOpen && issueNumber !== null && (
                  <section className="mt-2 border-t border-border pt-2">
                    {!auth && (
                      <a
                        className="text-[11.5px] text-accent"
                        href={issueUrl(issueNumber)}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {t.marketplaceEngageGithub}
                      </a>
                    )}

                    <h4 className="mt-2 mb-1 text-[11.5px] font-semibold text-ink">
                      {t.marketplaceCommentsTitle}
                    </h4>
                    {!thread || thread.status === 'loading' ? (
                      <p className="m-0 text-[11.5px] text-muted">{t.marketplaceCommentsLoading}</p>
                    ) : thread.status === 'error' ? (
                      <p className="m-0 text-[11.5px] text-err">{thread.error}</p>
                    ) : thread.comments.length === 0 ? (
                      <p className="m-0 text-[11.5px] text-muted">{t.marketplaceCommentsEmpty}</p>
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                        {thread.comments.map((comment) => (
                          <li
                            className="rounded-md border border-border bg-panel p-2"
                            key={comment.id}
                          >
                            <span className="text-[11.5px] font-medium text-ink">
                              @{comment.user.login}
                            </span>
                            <p className="mt-0.5 mb-0 whitespace-pre-wrap text-[11.5px] leading-snug text-muted">
                              {comment.body}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}

                    {auth && (
                      <div className="mt-2 flex flex-col gap-1.5">
                        <textarea
                          className="w-full"
                          disabled={engaging}
                          onChange={(event) => setDraft(event.target.value)}
                          placeholder={t.marketplaceCommentPlaceholder}
                          rows={2}
                          value={draft}
                        />
                        <button
                          className="task-action-run self-end"
                          disabled={engaging || !draft.trim()}
                          onClick={() => void sendComment(issueNumber)}
                          type="button"
                        >
                          {t.marketplaceCommentSend}
                        </button>
                      </div>
                    )}
                  </section>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
