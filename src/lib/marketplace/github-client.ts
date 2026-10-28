/**
 * The only module that talks to `api.github.com`.
 *
 * Keeping every call here means one place maps HTTP failures to the stable
 * error codes the UI translates, and one place pins the API version. Reads work
 * without a token (anonymous, 60 calls/hour); writes require one.
 *
 * @module lib/marketplace/github-client
 */

import { MarketplaceError } from './types'

const DEFAULT_BASE_URL = 'https://api.github.com'
const API_VERSION = '2022-11-28'

export interface GitHubClientOptions {
  token?: string
  fetchImpl?: typeof fetch
  baseUrl?: string
}

export interface GitHubUser {
  login: string
}

export interface GitHubRepo {
  full_name: string
  default_branch: string
  private?: boolean
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean }
}

export interface GitHubRef {
  object: { sha: string }
}

export interface GitHubTreeEntry {
  path: string
  type: 'blob' | 'tree' | string
  sha: string
}

export interface GitHubTree {
  tree: GitHubTreeEntry[]
  truncated: boolean
}

export interface GitHubPull {
  number: number
  title: string
  html_url: string
  merged_at: string | null
  head: { ref: string }
}

export interface GitHubMergeResult {
  merged: boolean
  message: string
  sha?: string
}

export interface GitHubIssue {
  number: number
  comments?: number
  reactions?: { total_count?: number; '+1'?: number }
  pull_request?: unknown
}

export interface GitHubReaction {
  id: number
  content: string
  user: { login: string }
}

export interface GitHubComment {
  id: number
  body: string
  html_url: string
  created_at: string
  user: { login: string }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
}

/** Encodes each path segment but keeps the separators. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export class GitHubClient {
  private readonly token?: string
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(options: GitHubClientOptions = {}) {
    this.token = options.token
    // Storing a bare `fetch` and calling it as `this.fetchImpl(...)` would pass
    // the client as its receiver; Chrome rejects that with "Illegal invocation".
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  get authenticated(): boolean {
    return !!this.token
  }

  private authHeaders(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      'X-GitHub-Api-Version': API_VERSION,
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    return headers
  }

  private async send(path: string, init: RequestOptions & { headers: Record<string, string> }) {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: init.headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      })
    } catch (error) {
      throw new MarketplaceError(
        'network',
        `GitHub request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = this.authHeaders('application/vnd.github+json')
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'

    const response = await this.send(path, { ...options, headers })
    if (!response.ok) throw await toMarketplaceError(response)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  /**
   * Raw file bytes at a path on a branch, or null when absent (404).
   *
   * Private repositories cannot be read from `raw.githubusercontent.com` — the
   * raw host ignores `Authorization` — so content goes through the API with the
   * raw media type, one call per file against the authenticated quota.
   */
  private async requestContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<Response | null> {
    const response = await this.send(
      `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      { headers: this.authHeaders('application/vnd.github.raw+json') },
    )
    // 404 covers both "no such file" and "no access" — callers treat them alike.
    if (response.status === 404) return null
    if (!response.ok) throw await toMarketplaceError(response)
    return response
  }

  async getFileText(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    const response = await this.requestContent(owner, repo, path, ref)
    return response ? response.text() : null
  }

  async getFileBlob(owner: string, repo: string, path: string, ref: string): Promise<Blob | null> {
    const response = await this.requestContent(owner, repo, path, ref)
    return response ? response.blob() : null
  }

  getUser(): Promise<GitHubUser> {
    return this.request<GitHubUser>('/user')
  }

  getRepo(owner: string, repo: string): Promise<GitHubRepo> {
    return this.request<GitHubRepo>(`/repos/${owner}/${repo}`)
  }

  /** Forks the marketplace repo into the authenticated user's account. */
  createFork(owner: string, repo: string): Promise<unknown> {
    return this.request(`/repos/${owner}/${repo}/forks`, {
      method: 'POST',
      body: { default_branch_only: true },
    })
  }

  getRef(owner: string, repo: string, branch: string): Promise<GitHubRef> {
    return this.request<GitHubRef>(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    )
  }

  createRef(owner: string, repo: string, branch: string, sha: string): Promise<unknown> {
    return this.request(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha },
    })
  }

  putFile(
    owner: string,
    repo: string,
    path: string,
    input: { message: string; contentBase64: string; branch: string; sha?: string },
  ): Promise<unknown> {
    return this.request(`/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body: {
        message: input.message,
        content: input.contentBase64,
        branch: input.branch,
        // GitHub rejects a write to a path that already exists unless its blob
        // sha is echoed back — which is what makes a republish an update.
        ...(input.sha ? { sha: input.sha } : {}),
      },
    })
  }

  deleteFile(
    owner: string,
    repo: string,
    path: string,
    input: { message: string; sha: string; branch: string },
  ): Promise<unknown> {
    return this.request(`/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
      method: 'DELETE',
      body: input,
    })
  }

  createPull(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<GitHubPull> {
    return this.request<GitHubPull>(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: input,
    })
  }

  /**
   * Merges a pull request. GitHub returns 405 while it is still computing
   * mergeability and 403 when the token has no write access to the repo.
   */
  mergePull(
    owner: string,
    repo: string,
    pullNumber: number,
    input: { mergeMethod?: 'merge' | 'squash' | 'rebase' } = {},
  ): Promise<GitHubMergeResult> {
    return this.request<GitHubMergeResult>(`/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
      method: 'PUT',
      body: { merge_method: input.mergeMethod ?? 'merge' },
    })
  }

  listTree(owner: string, repo: string, branch: string): Promise<GitHubTree> {
    return this.request<GitHubTree>(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    )
  }

  listClosedPulls(owner: string, repo: string, page = 1): Promise<GitHubPull[]> {
    return this.request<GitHubPull[]>(
      `/repos/${owner}/${repo}/pulls?state=closed&per_page=100&page=${page}&sort=updated&direction=desc`,
    )
  }

  listIssues(owner: string, repo: string, page = 1): Promise<GitHubIssue[]> {
    return this.request<GitHubIssue[]>(
      `/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`,
    )
  }

  addReaction(owner: string, repo: string, issueNumber: number): Promise<GitHubReaction> {
    return this.request<GitHubReaction>(`/repos/${owner}/${repo}/issues/${issueNumber}/reactions`, {
      method: 'POST',
      body: { content: '+1' },
    })
  }

  listReactions(
    owner: string,
    repo: string,
    issueNumber: number,
    page = 1,
  ): Promise<GitHubReaction[]> {
    return this.request<GitHubReaction[]>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/reactions?per_page=100&page=${page}`,
    )
  }

  deleteReaction(
    owner: string,
    repo: string,
    issueNumber: number,
    reactionId: number,
  ): Promise<void> {
    return this.request<void>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/reactions/${reactionId}`,
      { method: 'DELETE' },
    )
  }

  listComments(
    owner: string,
    repo: string,
    issueNumber: number,
    page = 1,
  ): Promise<GitHubComment[]> {
    return this.request<GitHubComment[]>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
    )
  }

  createComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubComment> {
    return this.request<GitHubComment>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      body: { body },
    })
  }
}

async function toMarketplaceError(response: Response): Promise<MarketplaceError> {
  const status = response.status
  let detail = ''
  try {
    const body = (await response.json()) as { message?: unknown }
    if (typeof body?.message === 'string') detail = body.message
  } catch {
    // Non-JSON error bodies are common; the status carries the meaning.
  }
  const suffix = detail ? `: ${detail}` : ''

  if (status === 401) {
    return new MarketplaceError('unauthorized', `GitHub rejected the token${suffix}`, status)
  }
  if (status === 403 || status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    const resetSeconds = Number(response.headers.get('x-ratelimit-reset'))
    const resetAt =
      Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : undefined
    if (status === 429 || remaining === '0') {
      return new MarketplaceError(
        'rate-limited',
        `GitHub API rate limit reached${suffix}`,
        status,
        resetAt,
      )
    }
    return new MarketplaceError('forbidden', `GitHub refused the request${suffix}`, status)
  }
  if (status === 404) {
    return new MarketplaceError('not-found', `GitHub resource not found${suffix}`, status)
  }
  if (status === 409 || status === 422) {
    return new MarketplaceError('conflict', `GitHub rejected the request${suffix}`, status)
  }
  return new MarketplaceError('network', `GitHub returned ${status}${suffix}`, status)
}
