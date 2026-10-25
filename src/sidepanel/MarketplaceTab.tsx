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
import type { Messages } from '../lib/i18n'
import { sendCommand } from '../lib/messages'
import { onStoreChanged } from '../lib/store-events'
import type { Workflow } from '../lib/workflow/types'
import { findInstalled, planApply } from '../lib/marketplace/apply'
import { chromeCatalogCache, loadCatalog, type LoadCatalogResult } from '../lib/marketplace/catalog'
import { GitHubClient } from '../lib/marketplace/github-client'
import { assetRepoPath, needsUpdate, workflowDir } from '../lib/marketplace/meta'
import { fetchPublishedWorkflow, rawUrl } from '../lib/marketplace/raw'
import {
  MARKETPLACE_BRANCH,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_REPO_FULL,
  MarketplaceError,
  type MarketplaceCard,
  type MarketplaceCategory,
} from '../lib/marketplace/types'
import { confirmDialog } from '../ui/confirm'
import { useT } from './i18n'
import { marketplaceErrorMessage } from './marketplace-errors'

const CATEGORY_KEY: Record<MarketplaceCategory, keyof Messages> = {
  ecommerce: 'marketplaceCategoryEcommerce',
  content: 'marketplaceCategoryContent',
  data: 'marketplaceCategoryData',
  office: 'marketplaceCategoryOffice',
  social: 'marketplaceCategorySocial',
  other: 'marketplaceCategoryOther',
}

type SortMode = 'recent' | 'likes'

/** `all` is a filter sentinel, not a published category. */
type CategoryFilter = 'all' | MarketplaceCategory

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
  /** Slugs whose published file failed validation; retried only on refresh. */
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set())

  const loadedRef = useRef(false)

  const refresh = useCallback(
    async (force: boolean): Promise<void> => {
      setLoading(true)
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
    if (!active || loadedRef.current) return
    loadedRef.current = true
    void refresh(false)
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

  const cards = useMemo(() => {
    const list = (snapshot?.cards ?? []).filter(
      (card) =>
        (category === 'all' || card.meta.category === category) && matchesQuery(card, query.trim()),
    )
    return list.sort((a, b) =>
      sort === 'likes'
        ? b.likes - a.likes || updatedAtOf(b) - updatedAtOf(a)
        : updatedAtOf(b) - updatedAtOf(a),
    )
  }, [snapshot, category, query, sort])

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
      const published = await fetchPublishedWorkflow(card.meta.slug)
      if (published === null) {
        throw new MarketplaceError('not-found', `workflows/${card.meta.slug}/workflow.json`)
      }
      const plan = planApply(card, published, existing)
      if (plan.status === 'up-to-date') {
        setBanner({ kind: 'ok', text: t.marketplaceApplied })
        return
      }
      await sendCommand({ type: 'workflows.save', workflow: plan.workflow })
      setBanner({
        kind: 'ok',
        text:
          plan.status === 'update'
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
          {MARKETPLACE_CATEGORIES.map((item) => (
            <option key={item} value={item}>
              {t[CATEGORY_KEY[item]] as string}
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
            const cover = meta.images[0]
            const sourceUrl = `https://github.com/${MARKETPLACE_REPO_FULL}/tree/${MARKETPLACE_BRANCH}/${workflowDir(meta.slug)}`
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
                  <span className="task-chip">{t[CATEGORY_KEY[meta.category]] as string}</span>
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
                  <span>{t.marketplaceLikeCount({ count: card.likes })}</span>
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
                  <a className="text-accent" href={sourceUrl} rel="noreferrer" target="_blank">
                    {t.marketplaceViewOnGithub}
                  </a>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
