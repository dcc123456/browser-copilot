import { describe, expect, it } from 'vitest'
import type {
  GitHubPull,
  GitHubRef,
  GitHubRepo,
  GitHubTree,
  GitHubTreeEntry,
} from '../src/lib/marketplace/github-client'
import {
  branchStamp,
  preparePublish,
  pushPublish,
  unpublishWorkflow,
  type PreparedPublish,
  type UnpublishClient,
} from '../src/lib/marketplace/publish'
import {
  MARKETPLACE_OWNER,
  MARKETPLACE_REPO,
  MarketplaceError,
  type MarketplaceAuth,
  type MarketplaceMeta,
  type MarketplacePublishInput,
} from '../src/lib/marketplace/types'
import type { Workflow } from '../src/lib/workflow/types'

const NOW = new Date('2026-10-25T09:00:00.000Z')
const AUTH: MarketplaceAuth = { token: 'ghp_test-token', login: 'octocat' }
const BASE_SHA = 'c'.repeat(40)

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'local-1',
    name: 'Scrape orders',
    description: 'Open the orders page and copy every row.',
    plan: 'internal reasoning that must not be shared',
    folderId: 'folder-a',
    createdAt: 1,
    updatedAt: 2,
    trigger: { type: 'manual' },
    settings: { saveLog: true, debugMode: true, notification: true, reuseLastState: true },
    drawflow: {
      nodes: [
        {
          id: 'n1',
          label: 'Open page',
          position: { x: 10, y: 20 },
          data: { selector: 'table' },
        },
      ],
      edges: [],
    },
    ...overrides,
  }
}

function makeInput(overrides: Partial<MarketplacePublishInput> = {}): MarketplacePublishInput {
  return {
    workflow: makeWorkflow(),
    title: 'Scrape orders',
    description: 'Open the orders page and copy every row.',
    category: 'ecommerce',
    tags: ['shop', 'orders'],
    images: [],
    ...overrides,
  }
}

interface ClientOptions {
  /** Owner-repo lookups that 404 before the fork appears, including the pre-fork check. */
  forkReadyAfter?: number
  /** Number of `createRef` calls rejected with a conflict. */
  createRefConflicts?: number
  /** Repo tree the removal path reads. */
  tree?: GitHubTreeEntry[]
}

interface ClientCalls {
  getRepo: Array<{ owner: string; repo: string }>
  createFork: Array<{ owner: string; repo: string }>
  getRef: Array<{ owner: string; repo: string; branch: string }>
  createRef: Array<{ owner: string; repo: string; branch: string; sha: string }>
  putFile: Array<{ owner: string; repo: string; path: string; branch: string }>
  deleteFile: Array<{ owner: string; repo: string; path: string; sha: string; branch: string }>
  listTree: Array<{ owner: string; repo: string; branch: string }>
  createPull: Array<{ owner: string; repo: string; title: string; head: string; base: string }>
}

function makeClient(options: ClientOptions = {}): {
  client: UnpublishClient
  calls: ClientCalls
} {
  const forkReadyAfter = options.forkReadyAfter ?? 0
  let remainingRefConflicts = options.createRefConflicts ?? 0
  let forkPolls = 0

  const calls: ClientCalls = {
    getRepo: [],
    createFork: [],
    getRef: [],
    createRef: [],
    putFile: [],
    deleteFile: [],
    listTree: [],
    createPull: [],
  }

  const client: UnpublishClient = {
    async getRepo(owner: string, repo: string): Promise<GitHubRepo> {
      calls.getRepo.push({ owner, repo })
      if (owner !== MARKETPLACE_OWNER) {
        forkPolls += 1
        if (forkPolls <= forkReadyAfter) {
          throw new MarketplaceError('not-found', 'Not Found', 404)
        }
      }
      return { full_name: `${owner}/${repo}`, default_branch: 'main' }
    },
    async createFork(owner: string, repo: string): Promise<unknown> {
      calls.createFork.push({ owner, repo })
      return { full_name: `${AUTH.login}/${repo}` }
    },
    async getRef(owner: string, repo: string, branch: string): Promise<GitHubRef> {
      calls.getRef.push({ owner, repo, branch })
      return { object: { sha: BASE_SHA } }
    },
    async createRef(owner: string, repo: string, branch: string, sha: string): Promise<unknown> {
      calls.createRef.push({ owner, repo, branch, sha })
      if (remainingRefConflicts > 0) {
        remainingRefConflicts -= 1
        throw new MarketplaceError('conflict', 'Reference already exists', 422)
      }
      return { ref: `refs/heads/${branch}` }
    },
    async putFile(owner, repo, path, input): Promise<unknown> {
      calls.putFile.push({ owner, repo, path, branch: input.branch })
      return { content: { path } }
    },
    async deleteFile(owner, repo, path, input): Promise<unknown> {
      calls.deleteFile.push({
        owner,
        repo,
        path,
        sha: input.sha,
        branch: input.branch,
      })
      return { commit: { sha: BASE_SHA } }
    },
    async listTree(owner: string, repo: string, branch: string): Promise<GitHubTree> {
      calls.listTree.push({ owner, repo, branch })
      return { tree: options.tree ?? [], truncated: false }
    },
    async createPull(owner, repo, input): Promise<GitHubPull> {
      calls.createPull.push({ owner, repo, title: input.title, head: input.head, base: input.base })
      return {
        number: 42,
        title: input.title,
        html_url: `https://github.com/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/pull/42`,
        merged_at: null,
        head: { ref: input.head },
      }
    },
  }

  return { client, calls }
}

function decodeText(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8')
}

async function prepare(input: MarketplacePublishInput = makeInput()): Promise<PreparedPublish> {
  return preparePublish(input, { author: 'octocat', now: NOW })
}

function existingMeta(slug: string, overrides: Partial<MarketplaceMeta> = {}): MarketplaceMeta {
  return {
    schema: 1,
    slug,
    title: 'Scrape orders',
    description: '',
    category: 'ecommerce',
    tags: [],
    author: 'octocat',
    version: 1,
    hash: 'a'.repeat(64),
    images: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('preparePublish', () => {
  it('builds a slug, version 1 and the two committed JSON files', async () => {
    const prepared = await prepare()

    expect(prepared.slug).toMatch(/^scrape-orders-[a-f0-9]{6}$/)
    expect(prepared.version).toBe(1)
    expect(prepared.files.map((file) => file.path)).toEqual([
      `workflows/${prepared.slug}/workflow.json`,
      `workflows/${prepared.slug}/meta.json`,
    ])

    const committed = JSON.parse(decodeText(prepared.files[0]!.contentBase64)) as Workflow
    expect(committed.id).toBe(prepared.slug)
    expect(committed).not.toHaveProperty('plan')
    expect(committed).not.toHaveProperty('folderId')

    const meta = JSON.parse(decodeText(prepared.files[1]!.contentBase64)) as { hash: string }
    expect(meta.hash).toBe(prepared.hash)
    expect(prepared.meta.author).toBe('octocat')
  })

  it('commits images under the workflow directory', async () => {
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' })
    const prepared = await prepare(makeInput({ images: [image] }))

    const asset = prepared.files.find((file) => file.path.endsWith('/assets/1.webp'))
    expect(asset).toBeDefined()
    expect(asset!.path).toBe(`workflows/${prepared.slug}/assets/1.webp`)
    expect([...Buffer.from(asset!.contentBase64, 'base64')]).toEqual([1, 2, 3])
    expect(prepared.meta.images).toEqual(['assets/1.webp'])
  })

  it('bumps the same slug when republishing a workflow you already own', async () => {
    const prepared = await prepare(
      makeInput({
        workflow: makeWorkflow({
          marketplace: {
            repo: `${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}`,
            slug: 'scrape-orders-abcdef',
            version: 2,
            hash: 'a'.repeat(64),
            author: 'octocat',
            appliedAt: 1,
          },
        }),
      }),
    )

    expect(prepared.slug).toBe('scrape-orders-abcdef')
    expect(prepared.version).toBe(3)
  })

  it('bumps the version published under the same slug by the same author', async () => {
    const prepared = await preparePublish(makeInput(), {
      author: 'octocat',
      now: NOW,
      findExistingMeta: async (slug) => existingMeta(slug, { author: 'octocat', version: 4 }),
    })

    expect(prepared.slug).toBe(prepared.meta.slug)
    expect(prepared.version).toBe(5)
    expect(prepared.meta.version).toBe(5)
  })

  it('refuses a slug already owned by a different author', async () => {
    await expect(
      preparePublish(makeInput(), {
        author: 'octocat',
        now: NOW,
        findExistingMeta: async (slug) => existingMeta(slug, { author: 'someone-else' }),
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects missing identity, oversized images and non-images', async () => {
    await expect(preparePublish(makeInput(), { author: '  ' })).rejects.toMatchObject({
      code: 'auth-required',
    })
    await expect(
      prepare(
        makeInput({
          images: [new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'image/webp' })],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      prepare(makeInput({ images: [new Blob(['hi'], { type: 'text/plain' })] })),
    ).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('pushPublish', () => {
  it('creates a branch, commits every file and opens the pull request', async () => {
    const prepared = await prepare()
    const { client, calls } = makeClient()
    const sleeps: number[] = []

    const result = await pushPublish(prepared, {
      client,
      auth: AUTH,
      now: NOW,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    const branch = `submit/${prepared.slug}-202610250900`
    expect(calls.createFork).toHaveLength(0)
    expect(calls.getRef).toEqual([{ owner: 'octocat', repo: MARKETPLACE_REPO, branch: 'main' }])
    expect(calls.createRef).toEqual([
      { owner: 'octocat', repo: MARKETPLACE_REPO, branch, sha: BASE_SHA },
    ])
    expect(calls.putFile.map((call) => call.path)).toEqual([
      `workflows/${prepared.slug}/workflow.json`,
      `workflows/${prepared.slug}/meta.json`,
    ])
    expect(calls.putFile.every((call) => call.branch === branch)).toBe(true)
    expect(calls.createPull).toEqual([
      {
        owner: MARKETPLACE_OWNER,
        repo: MARKETPLACE_REPO,
        title: `Add workflow: Scrape orders [wf:${prepared.slug}]`,
        head: `octocat:${branch}`,
        base: 'main',
      },
    ])
    expect(sleeps).toEqual([])
    expect(result).toMatchObject({
      prNumber: 42,
      prUrl: `https://github.com/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/pull/42`,
      slug: prepared.slug,
      version: 1,
    })
  })

  it('forks the repo and polls until GitHub exposes it', async () => {
    const prepared = await prepare()
    const { client, calls } = makeClient({ forkReadyAfter: 2 })
    const sleeps: number[] = []

    await pushPublish(prepared, {
      client,
      auth: AUTH,
      now: NOW,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    expect(calls.createFork).toEqual([{ owner: MARKETPLACE_OWNER, repo: MARKETPLACE_REPO }])
    expect(sleeps).toEqual([2000, 2000])
    expect(calls.createRef[0]!.owner).toBe('octocat')
  })

  it('writes straight to the upstream repo for its owner', async () => {
    const prepared = await prepare()
    const { client, calls } = makeClient()

    await pushPublish(prepared, {
      client,
      auth: { token: 'ghp_test-token', login: MARKETPLACE_OWNER },
      now: NOW,
      sleep: async () => {},
    })

    expect(calls.createFork).toHaveLength(0)
    expect(calls.createRef[0]!.owner).toBe(MARKETPLACE_OWNER)
    expect(calls.createPull[0]!.head).toMatch(new RegExp(`^${MARKETPLACE_OWNER}:submit/`))
  })

  it('retries once on a branch-name conflict', async () => {
    const prepared = await prepare()
    const { client, calls } = makeClient({ createRefConflicts: 1 })

    await pushPublish(prepared, { client, auth: AUTH, now: NOW, sleep: async () => {} })

    const base = `submit/${prepared.slug}-202610250900`
    expect(calls.createRef.map((call) => call.branch)).toEqual([base, `${base}-1`])
    expect(calls.putFile.every((call) => call.branch === `${base}-1`)).toBe(true)
    expect(calls.createPull[0]!.head).toBe(`octocat:${base}-1`)
  })

  it('requires a token', async () => {
    const prepared = await prepare()
    const { client } = makeClient()

    await expect(
      pushPublish(prepared, { client, auth: { token: '', login: 'octocat' } }),
    ).rejects.toMatchObject({ code: 'auth-required' })
  })
})

describe('unpublishWorkflow', () => {
  const SLUG = 'scrape-orders-abcdef'

  function treeFor(slug: string): GitHubTreeEntry[] {
    return [
      { path: `workflows/${slug}/workflow.json`, type: 'blob', sha: '1'.repeat(40) },
      { path: `workflows/${slug}/meta.json`, type: 'blob', sha: '2'.repeat(40) },
      { path: `workflows/${slug}/assets/1.webp`, type: 'blob', sha: '3'.repeat(40) },
      { path: 'workflows/other-111111/meta.json', type: 'blob', sha: '4'.repeat(40) },
      { path: 'README.md', type: 'blob', sha: '5'.repeat(40) },
    ]
  }

  it('deletes every file under the slug and opens a removal pull request', async () => {
    const { client, calls } = makeClient({ tree: treeFor(SLUG) })

    const result = await unpublishWorkflow(
      { slug: SLUG, title: 'Scrape orders' },
      { client, auth: AUTH, now: NOW, sleep: async () => {} },
    )

    const branch = `submit/${SLUG}-202610250900`
    expect(calls.listTree).toEqual([{ owner: 'octocat', repo: MARKETPLACE_REPO, branch: 'main' }])
    expect(calls.deleteFile.map((call) => call.path)).toEqual([
      `workflows/${SLUG}/workflow.json`,
      `workflows/${SLUG}/meta.json`,
      `workflows/${SLUG}/assets/1.webp`,
    ])
    expect(calls.deleteFile.map((call) => call.sha)).toEqual([
      '1'.repeat(40),
      '2'.repeat(40),
      '3'.repeat(40),
    ])
    expect(calls.deleteFile.every((call) => call.branch === branch)).toBe(true)
    expect(calls.createPull).toEqual([
      {
        owner: MARKETPLACE_OWNER,
        repo: MARKETPLACE_REPO,
        title: `Remove workflow: Scrape orders [wf:${SLUG}]`,
        head: `octocat:${branch}`,
        base: 'main',
      },
    ])
    expect(result).toMatchObject({
      prNumber: 42,
      slug: SLUG,
      files: 3,
      prUrl: `https://github.com/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/pull/42`,
    })
  })

  it('reports a slug with no published files instead of opening an empty PR', async () => {
    const { client, calls } = makeClient({ tree: treeFor('another-111111') })

    await expect(
      unpublishWorkflow(
        { slug: SLUG, title: 'Scrape orders' },
        { client, auth: AUTH, now: NOW, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(calls.createRef).toHaveLength(0)
    expect(calls.deleteFile).toHaveLength(0)
    expect(calls.createPull).toHaveLength(0)
  })

  it('retries once on a branch-name conflict', async () => {
    const { client, calls } = makeClient({
      tree: treeFor(SLUG),
      createRefConflicts: 1,
    })

    await unpublishWorkflow(
      { slug: SLUG, title: 'Scrape orders' },
      { client, auth: AUTH, now: NOW, sleep: async () => {} },
    )

    const base = `submit/${SLUG}-202610250900`
    expect(calls.createRef.map((call) => call.branch)).toEqual([base, `${base}-1`])
    expect(calls.deleteFile.every((call) => call.branch === `${base}-1`)).toBe(true)
    expect(calls.createPull[0]!.head).toBe(`octocat:${base}-1`)
  })

  it('requires a token', async () => {
    const { client } = makeClient({ tree: treeFor(SLUG) })

    await expect(
      unpublishWorkflow(
        { slug: SLUG, title: 'Scrape orders' },
        { client, auth: { token: '', login: 'octocat' } },
      ),
    ).rejects.toMatchObject({ code: 'auth-required' })
  })
})

describe('branchStamp', () => {
  it('is a minute-precision UTC stamp with an optional retry suffix', () => {
    expect(branchStamp(NOW)).toBe('202610250900')
    expect(branchStamp(NOW, 1)).toBe('202610250900-1')
  })
})
