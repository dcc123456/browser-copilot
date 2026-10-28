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
import { downloadBlob } from '../lib/export-answer'
import { onStoreChanged } from '../lib/store-events'
import type { Workflow } from '../lib/workflow/types'
import { findInstalled } from '../lib/marketplace/apply'
import { formatAttachmentSize } from '../lib/marketplace/attachments'
import { categoryKey, categoryLabel, categoryOptions } from '../lib/marketplace/categories'
import {
  chromeCatalogCache,
  loadCatalog,
  teamCatalogCacheKey,
  type LoadCatalogResult,
} from '../lib/marketplace/catalog'
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
import { fetchRepoAsset, rawUrl } from '../lib/marketplace/raw'
import { PUBLIC_REPO, repoFullName, type RepoRef } from '../lib/marketplace/repo'
import {
  connectionKey,
  connectionRepo,
  getTeamConnections,
  type TeamConnection,
} from '../lib/marketplace/team'
import { clearAuth, getAuth } from '../lib/marketplace/token'
import {
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

/** Which repository the tab is reading: the public one or the team ones. */
type Source = 'public' | 'team'

/** `all` plus a built-in slug or a publisher-defined label. */
type CategoryFilter = string

interface Props {
  /** The tab is mounted from startup; the catalog loads on first activation. */
  active: boolean
  /** Test/preview seam: start on a source with the stored connections known. */
  initial?: { source: Source; teamConnections: TeamConnection[] }
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

/** Public/team switch; the `!` modifiers beat `styles.css`'s bare button rule. */
const SOURCE_TAB_BASE =
  'flex-1 cursor-pointer rounded-md border-0! bg-transparent! px-2! py-1! text-[12px] font-medium transition-colors duration-150'
const SOURCE_TAB_IDLE = 'text-muted! hover:text-ink!'
const SOURCE_TAB_ACTIVE = 'bg-panel! text-ink! shadow-[var(--bc-shadow)]'

/**
 * Cover image from a private repository.
 *
 * The raw host ignores `Authorization`, so the blob comes through the
 * authenticated contents API and is shown through an object URL that is
 * revoked when the card unmounts or the source changes.
 */
function RepoImage({
  repo,
  slug,
  path,
  client,
}: {
  repo: RepoRef
  slug: string
  path: string
  client: GitHubClient
}): React.ReactElement | null {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    void fetchRepoAsset(repo, slug, path, { client })
      .then((blob) => {
        if (!blob || cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [repo, slug, path, client])

  if (!src) return null
  return (
    <img
      alt=""
      className="mb-2 aspect-video w-full rounded-md border border-border object-cover"
      loading="lazy"
      src={src}
    />
  )
}

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

export default function MarketplaceTab({ active, initial }: Props): React.ReactElement {
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
  /** Card identity (`repo/slug`) whose apply or removal is running. */
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [removingSlug, setRemovingSlug] = useState<string | null>(null)
  /** Card identities whose published file failed validation; retried on refresh. */
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set())

  const [auth, setAuth] = useState<MarketplaceAuth | null | undefined>(undefined)
  const [source, setSource] = useState<Source>(initial?.source ?? 'public')
  /** Every connected team repository; undefined while loading. */
  const [teamConnections, setTeamConnections] = useState<TeamConnection[] | undefined>(
    initial ? initial.teamConnections : undefined,
  )
  /** `all` or one connection key; only offered with more than one team. */
  const [teamFilter, setTeamFilter] = useState('all')
  /** Team repositories whose last refresh failed without a cached snapshot. */
  const [failedTeams, setFailedTeams] = useState<string[]>([])
  /** Card identity whose discussion panel is expanded; one at a time. */
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
  /** Guards against a slow public load overwriting a newer team result. */
  const requestIdRef = useRef(0)

  const publicClient = useMemo(() => new GitHubClient(), [])
  /** One authenticated client per connected repository, keyed by `owner/repo`. */
  const teamClients = useMemo(
    () =>
      new Map(
        (teamConnections ?? []).map((connection) => [
          connectionKey(connection),
          new GitHubClient({ token: connection.auth.token }),
        ]),
      ),
    [teamConnections],
  )
  const teamReady = (teamConnections?.length ?? 0) > 0

  /**
   * Where a card lives: its repository, the client that may read it, and the
   * connection (for the login and push permission). Public cards carry no
   * `repo`, so they resolve to the shared marketplace.
   */
  const cardSource = useCallback(
    (
      card: MarketplaceCard,
    ): { repo: RepoRef; client: GitHubClient; connection: TeamConnection | null } => {
      const name = card.repo
      if (!name || name === MARKETPLACE_REPO_FULL) {
        return { repo: PUBLIC_REPO, client: publicClient, connection: null }
      }
      const connection = (teamConnections ?? []).find((entry) => connectionKey(entry) === name)
      if (!connection) return { repo: PUBLIC_REPO, client: publicClient, connection: null }
      return {
        repo: connectionRepo(connection),
        client: teamClients.get(name) ?? publicClient,
        connection,
      }
    },
    [teamConnections, teamClients, publicClient],
  )

  /** Card identity across sources: the same slug may exist in two teams. */
  const cardKey = (card: MarketplaceCard): string =>
    `${card.repo ?? MARKETPLACE_REPO_FULL}/${card.meta.slug}`

  /** Every connected team's catalog, merged into one list. */
  const readTeamCatalog = useCallback(
    async (force: boolean): Promise<{ result: LoadCatalogResult; failed: string[] }> => {
      const connections = teamConnections ?? []
      const settled = await Promise.allSettled(
        connections.map(async (connection) => {
          const key = connectionKey(connection)
          const client = teamClients.get(key) ?? new GitHubClient({ token: connection.auth.token })
          const result = await loadCatalog({
            client,
            cache: chromeCatalogCache(teamCatalogCacheKey(connection.config)),
            force,
            repo: connectionRepo(connection),
            access: { client },
            includeEngagement: false,
          })
          return { key, result }
        }),
      )
      const fulfilled = settled.filter(
        (entry): entry is PromiseFulfilledResult<{ key: string; result: LoadCatalogResult }> =>
          entry.status === 'fulfilled',
      )
      const failed = connections
        .filter((_, index) => settled[index]!.status === 'rejected')
        .map((connection) => connectionKey(connection))
      if (fulfilled.length === 0) {
        const reason = settled.find(
          (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
        )?.reason
        throw reason ?? new MarketplaceError('network', 'No team repository could be read')
      }
      const results = fulfilled.map((entry) => entry.value.result)
      const result: LoadCatalogResult = {
        fetchedAt: Math.max(...results.map((entry) => entry.fetchedAt)),
        cards: fulfilled.flatMap(({ value }) =>
          value.result.cards.map((card) => ({
            ...card,
            repo: value.key,
          })),
        ),
        truncated: results.some((entry) => entry.truncated),
        fromCache: results.every((entry) => entry.fromCache),
        stale: results.some((entry) => entry.stale),
        staleError: results.find((entry) => entry.staleError)?.staleError,
      }
      return { result, failed }
    },
    [teamConnections, teamClients],
  )

  const refresh = useCallback(
    async (force: boolean, quiet = false): Promise<void> => {
      const requestId = ++requestIdRef.current
      if (source === 'team' && teamConnections !== undefined && teamConnections.length === 0) {
        setSnapshot(null)
        setError(null)
        setFailedTeams([])
        setLoading(false)
        return
      }
      if (!quiet) setLoading(true)
      setError(null)
      try {
        if (source === 'team') {
          const { result, failed } = await readTeamCatalog(force)
          if (requestIdRef.current !== requestId) return
          setSnapshot(result)
          setFailedTeams(failed)
        } else {
          const result = await loadCatalog({
            client: publicClient,
            cache: chromeCatalogCache(),
            force,
          })
          if (requestIdRef.current !== requestId) return
          setSnapshot(result)
          setFailedTeams([])
        }
        if (force) setUnavailable(new Set())
      } catch (caught) {
        if (requestIdRef.current !== requestId) return
        setError(marketplaceErrorMessage(t, caught))
        setSnapshot(null)
      } finally {
        if (requestIdRef.current === requestId) setLoading(false)
      }
    },
    [t, source, teamConnections, readTeamCatalog, publicClient],
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
    void getTeamConnections().then(setTeamConnections)
  }, [active])

  // Cards, threads and removals all belong to one repository; carrying any of
  // them across the switch would show the other source's state.
  useEffect(() => {
    setSnapshot(null)
    setError(null)
    setOpenSlug(null)
    setUnavailable(new Set())
    setFailedTeams([])
    setTeamFilter('all')
  }, [source])

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

  /**
   * Client for writes to the public marketplace. Team likes and comments do
   * not exist (team cards carry no issue number), so this stays public-only.
   */
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
    const identity = cardKey(card)
    if (openSlug === identity) {
      setOpenSlug(null)
      return
    }
    setOpenSlug(identity)
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
    // A disconnected team keeps its cached cards for a while; they are not
    // browsable or appliable any more, so drop them from the merged list.
    const teamKeys = new Set((teamConnections ?? []).map(connectionKey))
    const list = (snapshot?.cards ?? []).filter((card) => {
      if (source === 'team') {
        if (!card.repo || !teamKeys.has(card.repo)) return false
        if (teamFilter !== 'all' && card.repo !== teamFilter) return false
      }
      return (
        (category === 'all' || categoryKey(card.meta.category) === categoryKey(category)) &&
        matchesQuery(card, query.trim())
      )
    })
    return list.sort((a, b) =>
      sort === 'likes'
        ? b.likes - a.likes || updatedAtOf(b) - updatedAtOf(a)
        : updatedAtOf(b) - updatedAtOf(a),
    )
  }, [snapshot, category, query, sort, source, teamConnections, teamFilter])

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

  /** Downloads an attachment served by the private contents API. */
  const downloadAttachment = async (
    repo: RepoRef,
    slug: string,
    file: { name: string; path: string },
    client: GitHubClient,
  ): Promise<void> => {
    try {
      const blob = await fetchRepoAsset(repo, slug, file.path, { client })
      if (!blob) {
        setBanner({ kind: 'error', text: t.marketplaceAttachmentFailed })
        return
      }
      await downloadBlob(blob, blob.type || 'application/octet-stream', file.name)
    } catch (caught) {
      setBanner({ kind: 'error', text: marketplaceErrorMessage(t, caught) })
    }
  }

  const apply = async (card: MarketplaceCard): Promise<void> => {
    const where = cardSource(card)
    const repoName = repoFullName(where.repo)
    const existing = findInstalled(installed, card.meta.slug, repoName)
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
      confirmText: isUpdate ? t.marketplaceUpdateAction : t.marketplaceTrustConfirm,
      cancelText: t.cancel,
    })
    if (!confirmed) return

    setBusySlug(cardKey(card))
    try {
      const plan = await installFromCard(card, existing, installed, {
        repo: where.repo,
        access: where.connection ? { client: where.client } : undefined,
      })
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
        setUnavailable((prev) => new Set(prev).add(cardKey(card)))
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
    const where = cardSource(card)
    const writer = where.connection ? where.connection.auth : auth
    if (!writer) return
    const confirmed = await confirmDialog({
      title: t.marketplaceUnpublishTitle,
      message: t.marketplaceUnpublishMessage({ title: card.meta.title }),
      confirmText: t.marketplaceUnpublishConfirm,
      cancelText: t.cancel,
    })
    if (!confirmed) return

    setRemovingSlug(cardKey(card))
    try {
      const result = await unpublishWorkflow(
        { slug: card.meta.slug, title: card.meta.title },
        {
          client: new GitHubClient({ token: writer.token }),
          auth: writer,
          repo: where.repo,
        },
      )
      setBanner({
        kind: 'ok',
        text: t.marketplaceUnpublishBanner({ number: result.prNumber }),
      })
    } catch (caught) {
      if (
        !where.connection &&
        caught instanceof MarketplaceError &&
        caught.code === 'unauthorized'
      ) {
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

      <div
        aria-label={t.tabMarketplace}
        className="mb-2 flex gap-0.5 rounded-lg border border-border bg-panel-2 p-0.5"
        role="tablist"
      >
        <button
          aria-selected={source === 'public'}
          className={[
            SOURCE_TAB_BASE,
            source === 'public' ? SOURCE_TAB_ACTIVE : SOURCE_TAB_IDLE,
          ].join(' ')}
          onClick={() => setSource('public')}
          role="tab"
          type="button"
        >
          {t.marketplaceSourcePublic}
        </button>
        <button
          aria-selected={source === 'team'}
          className={[
            SOURCE_TAB_BASE,
            source === 'team' ? SOURCE_TAB_ACTIVE : SOURCE_TAB_IDLE,
          ].join(' ')}
          onClick={() => setSource('team')}
          role="tab"
          type="button"
        >
          {t.marketplaceSourceTeam}
        </button>
      </div>

      <p className="mt-0 mb-3 text-[12px] leading-snug text-muted">
        {source === 'team' ? t.marketplaceTeamIntro : t.marketplaceIntro}
      </p>
      {source === 'team' &&
        (teamConnections ?? [])
          .filter((connection) => !connection.config.canPush)
          .map((connection) => (
            <p
              className="mt-0 mb-3 text-[11.5px] leading-snug text-warn"
              key={connectionKey(connection)}
            >
              {connectionKey(connection)} · {t.settingsTeamReadOnlyWarning}
            </p>
          ))}

      {source === 'team' && (teamConnections?.length ?? 0) > 1 && (
        <select
          aria-label={t.marketplaceTeamFilter}
          className="mb-2 w-full"
          onChange={(event) => setTeamFilter(event.target.value)}
          value={teamFilter}
        >
          <option value="all">{t.marketplaceTeamFilterAll}</option>
          {(teamConnections ?? []).map((connection) => (
            <option key={connectionKey(connection)} value={connectionKey(connection)}>
              {connectionKey(connection)}
            </option>
          ))}
        </select>
      )}

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
      {failedTeams.length > 0 && (
        <div className="banner" data-kind="error" role="status">
          {t.marketplaceTeamPartialFailed({ repos: failedTeams.join(', ') })}
        </div>
      )}
      {snapshot?.truncated && (
        <p className="mt-0 mb-2 text-[11.5px] text-muted">{t.marketplaceTruncated}</p>
      )}

      {source === 'team' && !teamReady ? (
        teamConnections === undefined ? (
          <p className="m-0 text-[12.5px] text-muted">{t.marketplaceLoading}</p>
        ) : (
          <div className="empty-state">
            <p>{t.marketplaceTeamNotConnected}</p>
            <p className="mt-1">{t.marketplaceTeamNotConnectedHint}</p>
          </div>
        )
      ) : loading && !snapshot ? (
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
            const where = cardSource(card)
            const repoName = repoFullName(where.repo)
            const identity = cardKey(card)
            const existing = findInstalled(installed, meta.slug, repoName)
            const hasUpdate = !!existing && needsUpdate(meta, existing.marketplace)
            const isUnavailable = unavailable.has(identity)
            const sourceLogin = where.connection ? where.connection.auth.login : auth?.login
            const canWriteHere = !where.connection || where.connection.config.canPush
            const isMine =
              !!sourceLogin &&
              canWriteHere &&
              sourceLogin.toLowerCase() === meta.author.toLowerCase()
            const cover = meta.images[0]
            const sourceUrl = `https://github.com/${repoName}/tree/${where.repo.branch}/${workflowDir(meta.slug)}`
            const issueNumber = card.prNumber
            const likeState = issueNumber === null ? undefined : likeStates[issueNumber]
            const liked = likeState?.liked ?? false
            const thread = issueNumber === null ? undefined : threads[issueNumber]
            const isOpen = openSlug === identity
            const bundleCount = meta.dependencies?.length ?? 0
            return (
              <li className="task-item" key={identity}>
                {cover &&
                  (where.connection ? (
                    <RepoImage
                      client={where.client}
                      path={assetRepoPath(meta.slug, cover)}
                      repo={where.repo}
                      slug={meta.slug}
                    />
                  ) : (
                    <img
                      alt=""
                      className="mb-2 aspect-video w-full rounded-md border border-border object-cover"
                      loading="lazy"
                      src={rawUrl(where.repo, assetRepoPath(meta.slug, cover))}
                    />
                  ))}
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
                    {meta.attachments.map((file) =>
                      where.connection ? (
                        <button
                          className="cursor-pointer border-0! bg-transparent! p-0! text-[11.5px]! text-accent!"
                          key={file.path}
                          onClick={() =>
                            void downloadAttachment(where.repo, meta.slug, file, where.client)
                          }
                          type="button"
                        >
                          {file.name} ({formatAttachmentSize(file.size)})
                        </button>
                      ) : (
                        <a
                          className="text-accent"
                          href={rawUrl(where.repo, assetRepoPath(meta.slug, file.path))}
                          key={file.path}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {file.name} ({formatAttachmentSize(file.size)})
                        </a>
                      ),
                    )}
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
                        ? t.marketplaceUpdateAction
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
