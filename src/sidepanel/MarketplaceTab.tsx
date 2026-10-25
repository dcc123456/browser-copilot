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
import { RefreshCw } from 'lucide-react'
import { sendCommand } from '../lib/messages'
import { onStoreChanged } from '../lib/store-events'
import type { Workflow } from '../lib/workflow/types'
import { findInstalled } from '../lib/marketplace/apply'
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
import { useT } from './i18n'
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

/** `liked: null` = the local reaction id is still being read. */
interface LikeState {
  liked: boolean | null
  likes: number
}

export default function MarketplaceTab({ active }: Props): React.ReactElement {
  const t = useT()
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
  const reactionCache = (): ReactionCache => {
    reactionCacheRef.current ??= chromeReactionCache()
    return reactionCacheRef.current
  }

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
    // activation lets the 30-minute window in `loadCatalog` actually expire;
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
    setLikeStates((prev) =>
      prev[issueNumber] ? prev : { ...prev, [issueNumber]: { liked: null, likes: card.likes } },
    )
    if (!likeStates[issueNumber]) {
      void reactionCache()
        .get(issueNumber)
        .then((reactionId) =>
          setLikeStates((prev) => ({
            ...prev,
            [issueNumber]: {
              liked: reactionId !== null,
              likes: prev[issueNumber]?.likes ?? card.likes,
            },
          })),
        )
    }
    if (!threads[issueNumber]) void loadThread(issueNumber)
  }

  const like = async (card: MarketplaceCard, issueNumber: number): Promise<void> => {
    if (!auth) return
    setEngaging(true)
    try {
      const result = await toggleLike({
        client: clientForWrites(),
        cache: reactionCache(),
        issueNumber,
        onUnauthorized: forgetRejectedToken,
      })
      setLikeStates((prev) => {
        const current = prev[issueNumber] ?? { liked: false, likes: card.likes }
        return {
          ...prev,
          [issueNumber]: {
            liked: result.liked,
            likes: Math.max(0, current.likes + (result.liked ? 1 : -1)),
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

  const apply = async (card: MarketplaceCard): Promise<void> => {
    const existing = findInstalled(installed, card.meta.slug)
    const isUpdate = !!existing && needsUpdate(card.meta, existing.marketplace)
    const confirmed = await confirmDialog({
      title: isUpdate ? t.marketplaceUpdateTitle : t.marketplaceTrustTitle,
      message: isUpdate
        ? t.marketplaceUpdateMessage({ title: card.meta.title })
        : t.marketplaceTrustMessage({ title: card.meta.title, author: card.meta.author }),
      confirmText: isUpdate ? t.marketplaceUpdate : t.marketplaceTrustConfirm,
      cancelText: t.cancel,
    })
    if (!confirmed) return

    setBusySlug(card.meta.slug)
    try {
      const plan = await installFromCard(card, existing)
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

      {snapshot?.stale && (
        <div className="banner" data-kind="error" role="status">
          {t.marketplaceStale}
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
            const thread = issueNumber === null ? undefined : threads[issueNumber]
            const isOpen = openSlug === meta.slug
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
                  <strong className="task-item-name">{meta.title}</strong>
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
                  <span className="task-chip">
                    {t.marketplaceByAuthor({ author: meta.author })}
                  </span>
                  <span className="task-chip">{categoryLabel(t, meta.category)}</span>
                  {meta.tags.map((tag) => (
                    <span className="task-chip" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
                {meta.description && (
                  <p className="mt-1.5 mb-0 text-[12px] leading-snug text-muted">
                    {meta.description}
                  </p>
                )}
                <div className="mt-1 flex items-center gap-3 text-[11.5px] text-muted">
                  <span>{t.marketplaceLikeCount({ count: likeState?.likes ?? card.likes })}</span>
                  <span>{t.marketplaceCommentCount({ count: card.comments })}</span>
                </div>
                <div className="actions task-actions">
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
                  {issueNumber !== null && (
                    <button disabled={engaging} onClick={() => openDetail(card)} type="button">
                      {isOpen
                        ? t.marketplaceClose
                        : `${t.marketplaceCommentsTitle} (${card.comments})`}
                    </button>
                  )}
                  <a className="text-accent" href={sourceUrl} rel="noreferrer" target="_blank">
                    {t.marketplaceViewOnGithub}
                  </a>
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
                    {auth ? (
                      <button
                        className="task-action-run"
                        disabled={engaging || likeState?.liked === null}
                        onClick={() => void like(card, issueNumber)}
                        type="button"
                      >
                        {likeState?.liked ? t.marketplaceUnlikeAction : t.marketplaceLikeAction}
                      </button>
                    ) : (
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
