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
  /** Merge attempts rejected with 405 before GitHub reports the PR mergeable. */
  mergeRejects?: number
  /** Merge refused outright, as GitHub does for a token without write access. */
  mergeForbidden?: boolean
}

interface ClientCalls {
  getRepo: Array<{ owner: string; repo: string }>
  createFork: Array<{ owner: string; repo: string }>
  getRef: Array<{ owner: string; repo: string; branch: string }>
  createRef: Array<{ owner: string; repo: string; branch: string; sha: string }>
  putFile: Array<{ owner: string; repo: string; path: string; branch: string; sha?: string }>
  deleteFile: Array<{ owner: string; repo: string; path: string; sha: string; branch: string }>
  listTree: Array<{ owner: string; repo: string; branch: string }>
  createPull: Array<{
    owner: string
    repo: string
    title: string
    head: string
    base: string
    body: string
  }>
  mergePull: Array<{
    owner: string
    repo: string
    pullNumber: number
    mergeMethod?: string
  }>
}

function makeClient(options: ClientOptions = {}): {
  client: UnpublishClient
  calls: ClientCalls
} {
  const forkReadyAfter = options.forkReadyAfter ?? 0
  let remainingRefConflicts = options.createRefConflicts ?? 0
  let remainingMergeRejects = options.mergeRejects ?? 0
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
    mergePull: [],
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
      calls.putFile.push({ owner, repo, path, branch: input.branch, sha: input.sha })
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
      calls.createPull.push({
        owner,
        repo,
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
      })
      return {
        number: 42,
        title: input.title,
        html_url: `https://github.com/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/pull/42`,
        merged_at: null,
        head: { ref: input.head },
      }
    },
    async mergePull(owner, repo, pullNumber, input) {
      calls.mergePull.push({ owner, repo, pullNumber, mergeMethod: input?.mergeMethod })
      if (options.mergeForbidden) {
        throw new MarketplaceError('forbidden', 'GitHub refused the request', 403)
      }
      if (remainingMergeRejects > 0) {
        remainingMergeRejects -= 1
        throw new MarketplaceError('network', 'GitHub returned 405', 405)
      }
      return { merged: true, message: 'Pull Request successfully merged' }
    },
  }

  return { client, calls }
}

function decodeText(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8')
}

/** A graph whose only steps call other workflows. */
function callParent(...targets: string[]): Workflow {
  return makeWorkflow({
    drawflow: {
      nodes: targets.map((target, index) => ({
        id: `call-${index}`,
        label: 'Execute workflow',
        position: { x: 0, y: 0 },
        data: { blockId: 'execute-workflow', values: { workflowId: target } },
      })),
      edges: [],
    },
  })
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

  it('commits attachments under attachments/ and records them in meta', async () => {
    const prepared = await prepare(
      makeInput({
        attachments: [
          { name: '订单数据.csv', blob: new Blob([new Uint8Array([4, 5, 6])]) },
          { name: 'orders.csv', blob: new Blob([new Uint8Array([7])]) },
          { name: 'notes.txt', blob: new Blob(['hi']) },
        ],
      }),
    )

    expect(prepared.files.map((file) => file.path)).toEqual([
      `workflows/${prepared.slug}/workflow.json`,
      `workflows/${prepared.slug}/meta.json`,
      `workflows/${prepared.slug}/attachments/file.csv`,
      `workflows/${prepared.slug}/attachments/orders.csv`,
      `workflows/${prepared.slug}/attachments/notes.txt`,
    ])
    expect(prepared.meta.attachments).toEqual([
      { name: '订单数据.csv', path: 'attachments/file.csv', size: 3 },
      { name: 'orders.csv', path: 'attachments/orders.csv', size: 1 },
      { name: 'notes.txt', path: 'attachments/notes.txt', size: 2 },
    ])
    expect([...Buffer.from(prepared.files[2]!.contentBase64, 'base64')]).toEqual([4, 5, 6])
  })

  it('rejects oversized or too many attachments', async () => {
    await expect(
      prepare(
        makeInput({
          attachments: [{ name: 'big.csv', blob: new Blob([new Uint8Array(200 * 1024 + 1)]) }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      prepare(
        makeInput({
          attachments: Array.from({ length: 4 }, (_, index) => ({
            name: `file-${index}.csv`,
            blob: new Blob(['x']),
          })),
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' })
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

  it('commits called workflows next to the listing and records them in meta', async () => {
    const child = makeWorkflow({ id: 'child-1', name: 'Collect numbers' })
    const parent = callParent('child-1')

    const prepared = await preparePublish(makeInput({ workflow: parent }), {
      author: 'octocat',
      now: NOW,
      library: [parent, child],
    })

    expect(prepared.meta.dependencies).toEqual([
      { id: 'child-1', name: 'Collect numbers', path: 'deps/collect-numbers.json' },
    ])
    expect(prepared.files.map((file) => file.path)).toEqual([
      `workflows/${prepared.slug}/workflow.json`,
      `workflows/${prepared.slug}/meta.json`,
      `workflows/${prepared.slug}/deps/collect-numbers.json`,
    ])

    const parentJson = JSON.parse(decodeText(prepared.files[0]!.contentBase64)) as Workflow
    expect(parentJson.drawflow.nodes[0]!.data).toEqual({
      blockId: 'execute-workflow',
      values: { workflowId: 'child-1' },
    })

    const dependencyJson = JSON.parse(decodeText(prepared.files[2]!.contentBase64)) as Workflow
    expect(dependencyJson.id).toBe('collect-numbers')
    expect(dependencyJson).not.toHaveProperty('plan')
    expect(dependencyJson).not.toHaveProperty('folderId')
    expect(dependencyJson.trigger?.enabled).toBe(false)
  })

  it('bundles transitive dependencies leaf first', async () => {
    const leaf = makeWorkflow({ id: 'leaf-1', name: 'Read rows' })
    const middle = makeWorkflow({
      id: 'middle-1',
      name: 'Export orders',
      drawflow: {
        nodes: [
          {
            id: 'call-0',
            label: 'Execute workflow',
            position: { x: 0, y: 0 },
            data: { blockId: 'execute-workflow', values: { workflowId: 'leaf-1' } },
          },
        ],
        edges: [],
      },
    })
    const parent = callParent('middle-1')

    const prepared = await preparePublish(makeInput({ workflow: parent }), {
      author: 'octocat',
      now: NOW,
      library: [parent, middle, leaf],
    })

    expect(prepared.meta.dependencies?.map((dep) => dep.name)).toEqual([
      'Read rows',
      'Export orders',
    ])
  })

  it('refuses to publish while a called workflow is missing', async () => {
    await expect(prepare(makeInput({ workflow: callParent('ghost-1') }))).rejects.toThrow(
      'Called workflows are missing: ghost-1',
    )
    await expect(
      preparePublish(makeInput({ workflow: callParent('ghost-1') }), {
        author: 'octocat',
        now: NOW,
        library: [callParent('ghost-1')],
      }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('caps how many workflows one listing can carry', async () => {
    const children = Array.from({ length: 21 }, (_, index) =>
      makeWorkflow({ id: `child-${index}`, name: `Child ${index}` }),
    )
    const parent = callParent(...children.map((child) => child.id))

    await expect(
      preparePublish(makeInput({ workflow: parent }), {
        author: 'octocat',
        now: NOW,
        library: [parent, ...children],
      }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('attributes a bundled workflow warning to that workflow', async () => {
    const child = makeWorkflow({
      id: 'child-1',
      name: 'Collect numbers',
      drawflow: {
        nodes: [
          {
            id: 'n1',
            label: 'Sign in',
            position: { x: 0, y: 0 },
            data: { password: 'hunter2' },
          },
        ],
        edges: [],
      },
    })
    const parent = callParent('child-1')

    const prepared = await preparePublish(makeInput({ workflow: parent }), {
      author: 'octocat',
      now: NOW,
      library: [parent, child],
    })

    expect(prepared.warnings).toEqual([
      {
        kind: 'credential-literal',
        nodeLabel: 'Sign in',
        param: 'password',
        workflow: 'Collect numbers',
      },
    ])
  })

  it('publishes the referenced credential fields and warns about a filled password', async () => {
    const workflow = makeWorkflow({
      drawflow: {
        nodes: [
          {
            id: 's1',
            label: 'Get secret',
            position: { x: 0, y: 0 },
            data: {
              blockId: 'get-secret',
              values: { credential: 'gh::token', variableName: 'token' },
            },
          },
          {
            id: 's2',
            label: 'Get secret',
            position: { x: 0, y: 0 },
            data: {
              blockId: 'get-secret',
              values: { credential: 'gh::password', variableName: 'password' },
            },
          },
        ],
        edges: [],
      },
    })

    const prepared = await prepare(
      makeInput({
        workflow,
        secrets: [
          {
            id: 'gh',
            label: 'GitHub',
            fields: [
              { key: 'token', value: 'ghp_live' },
              { key: 'password', value: 'typed', secret: true },
              { key: 'unreferenced', value: 'dropped' },
            ],
          },
        ],
      }),
    )

    expect(prepared.meta.secrets).toEqual([
      {
        id: 'gh',
        label: 'GitHub',
        fields: [
          { key: 'token', value: 'ghp_live' },
          { key: 'password', value: 'typed', secret: true },
        ],
      },
    ])
    expect(prepared.warnings).toEqual([
      { kind: 'secret-value', nodeLabel: 'GitHub', param: 'password' },
    ])
  })

  it('refuses to publish a step whose credential has no record', async () => {
    const workflow = makeWorkflow({
      drawflow: {
        nodes: [
          {
            id: 's1',
            label: 'Get secret',
            position: { x: 0, y: 0 },
            data: { blockId: 'get-secret', values: { credential: 'gh::token' } },
          },
        ],
        edges: [],
      },
    })

    await expect(prepare(makeInput({ workflow }))).rejects.toMatchObject({ code: 'invalid' })
  })

  it('does not reuse a local ref that belongs to another repository', async () => {
    const prepared = await preparePublish(
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
      { author: 'octocat', now: NOW, repo: 'acme/team-workflows' },
    )

    expect(prepared.slug).not.toBe('scrape-orders-abcdef')
    expect(prepared.version).toBe(1)
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

    const branch = `submit/${prepared.slug}-20261025090000`
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
    expect(calls.createPull).toMatchObject([
      {
        owner: MARKETPLACE_OWNER,
        repo: MARKETPLACE_REPO,
        title: `Add workflow: Scrape orders [wf:${prepared.slug}]`,
        head: `octocat:${branch}`,
        base: 'main',
      },
    ])
    expect(sleeps).toEqual([])
    expect(calls.mergePull).toEqual([
      { owner: MARKETPLACE_OWNER, repo: MARKETPLACE_REPO, pullNumber: 42, mergeMethod: 'merge' },
    ])
    expect(result).toMatchObject({
      prNumber: 42,
      prUrl: `https://github.com/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/pull/42`,
      slug: prepared.slug,
      version: 1,
      merged: true,
    })
  })

  it('lists the bundled workflows in the pull request body', async () => {
    const child = makeWorkflow({ id: 'child-1', name: 'Collect numbers' })
    const parent = callParent('child-1')
    const prepared = await preparePublish(makeInput({ workflow: parent }), {
      author: 'octocat',
      now: NOW,
      library: [parent, child],
    })
    const { client, calls } = makeClient()

    await pushPublish(prepared, { client, auth: AUTH, now: NOW, sleep: async () => {} })

    expect(calls.putFile.map((call) => call.path)).toContain(
      `workflows/${prepared.slug}/deps/collect-numbers.json`,
    )
    expect(calls.createPull[0]!.body).toContain('- bundle: `Collect numbers`')
  })

  it('lists the attached files in the pull request body', async () => {
    const prepared = await prepare(
      makeInput({
        attachments: [{ name: 'orders.csv', blob: new Blob([new Uint8Array(2048)]) }],
      }),
    )
    const { client, calls } = makeClient()

    await pushPublish(prepared, { client, auth: AUTH, now: NOW, sleep: async () => {} })

    expect(calls.putFile.map((call) => call.path)).toContain(
      `workflows/${prepared.slug}/attachments/orders.csv`,
    )
    expect(calls.createPull[0]!.body).toContain('- attachments: `orders.csv` (2 KB)')
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

  it('overwrites the files of an existing listing instead of colliding with them', async () => {
    const prepared = await prepare()
    const listingSha = '1'.repeat(40)
    const droppedSha = '2'.repeat(40)
    const { client, calls } = makeClient({
      tree: [
        { path: `workflows/${prepared.slug}/workflow.json`, type: 'blob', sha: listingSha },
        { path: `workflows/${prepared.slug}/meta.json`, type: 'blob', sha: listingSha },
        {
          path: `workflows/${prepared.slug}/assets/cover-0.webp`,
          type: 'blob',
          sha: droppedSha,
        },
        { path: 'workflows/other-workflow/meta.json', type: 'blob', sha: droppedSha },
      ],
    })

    await pushPublish(prepared, {
      client,
      auth: { token: 'ghp_test-token', login: MARKETPLACE_OWNER },
      now: NOW,
      sleep: async () => {},
    })

    // GitHub answers 422 to a write over a path whose blob sha is not echoed
    // back, which is the conflict an "update" used to surface.
    expect(calls.putFile.map((call) => [call.path, call.sha])).toEqual([
      [`workflows/${prepared.slug}/workflow.json`, listingSha],
      [`workflows/${prepared.slug}/meta.json`, listingSha],
    ])
    expect(calls.deleteFile).toEqual([
      {
        owner: MARKETPLACE_OWNER,
        repo: MARKETPLACE_REPO,
        path: `workflows/${prepared.slug}/assets/cover-0.webp`,
        sha: droppedSha,
        branch: `submit/${prepared.slug}-20261025090000`,
      },
    ])
  })

  it('retries once on a branch-name conflict', async () => {
    const prepared = await prepare()
    const { client, calls } = makeClient({ createRefConflicts: 1 })

    await pushPublish(prepared, { client, auth: AUTH, now: NOW, sleep: async () => {} })

    const base = `submit/${prepared.slug}-20261025090000`
    expect(calls.createRef.map((call) => call.branch)).toEqual([base, `${base}-1`])
    expect(calls.putFile.every((call) => call.branch === `${base}-1`)).toBe(true)
    expect(calls.createPull[0]!.head).toBe(`octocat:${base}-1`)
  })

  it('keeps the pull request open when the token cannot merge it', async () => {
    const prepared = await prepare()
    const { client, calls } = makeClient({ mergeForbidden: true })

    const result = await pushPublish(prepared, {
      client,
      auth: AUTH,
      now: NOW,
      sleep: async () => {},
    })

    expect(calls.mergePull).toHaveLength(1)
    expect(result.merged).toBe(false)
    expect(result.prUrl).toContain('/pull/42')
  })

  it('retries the merge while GitHub is still computing mergeability', async () => {
    const prepared = await prepare()
    const { client, calls } = makeClient({ mergeRejects: 1 })
    const sleeps: number[] = []

    const result = await pushPublish(prepared, {
      client,
      auth: AUTH,
      now: NOW,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    expect(calls.mergePull).toHaveLength(2)
    expect(sleeps).toEqual([1500])
    expect(result.merged).toBe(true)
  })

  it('requires a token', async () => {
    const prepared = await prepare()
    const { client } = makeClient()

    await expect(
      pushPublish(prepared, { client, auth: { token: '', login: 'octocat' } }),
    ).rejects.toMatchObject({ code: 'auth-required' })
  })

  const TEAM = { owner: 'acme', repo: 'team-workflows', branch: 'main', isPrivate: true }

  it('pushes a team publish as a same-repo branch and pull request', async () => {
    const prepared = await prepare()
    const { client, calls } = makeClient()

    const result = await pushPublish(prepared, {
      client,
      auth: AUTH,
      repo: TEAM,
      now: NOW,
      sleep: async () => {},
    })

    const branch = `submit/${prepared.slug}-20261025090000`
    expect(calls.createFork).toHaveLength(0)
    expect(calls.getRepo).toEqual([{ owner: 'acme', repo: 'team-workflows' }])
    expect(calls.getRef).toEqual([{ owner: 'acme', repo: 'team-workflows', branch: 'main' }])
    expect(calls.createRef).toEqual([
      { owner: 'acme', repo: 'team-workflows', branch, sha: BASE_SHA },
    ])
    expect(calls.putFile.every((call) => call.owner === 'acme')).toBe(true)
    expect(calls.putFile.every((call) => call.repo === 'team-workflows')).toBe(true)
    expect(calls.createPull).toMatchObject([
      {
        owner: 'acme',
        repo: 'team-workflows',
        head: branch,
        base: 'main',
      },
    ])
    expect(calls.createPull[0]!.body).toContain(
      'available to everyone with access to this repository',
    )
    expect(calls.mergePull).toEqual([
      { owner: 'acme', repo: 'team-workflows', pullNumber: 42, mergeMethod: 'merge' },
    ])
    expect(result).toMatchObject({ repo: 'acme/team-workflows', merged: true })
  })

  it('leaves a team pull request open for a read-only member', async () => {
    const prepared = await prepare()
    const { client, calls } = makeClient({ mergeForbidden: true })

    const result = await pushPublish(prepared, {
      client,
      auth: AUTH,
      repo: TEAM,
      now: NOW,
      sleep: async () => {},
    })

    expect(calls.mergePull).toHaveLength(1)
    expect(result).toMatchObject({ repo: 'acme/team-workflows', merged: false })
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

    const branch = `submit/${SLUG}-20261025090000`
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
    expect(calls.createPull).toMatchObject([
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

    const base = `submit/${SLUG}-20261025090000`
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

  it('removes a team listing through a same-repo pull request', async () => {
    const { client, calls } = makeClient({ tree: treeFor(SLUG) })

    const result = await unpublishWorkflow(
      { slug: SLUG, title: 'Scrape orders' },
      {
        client,
        auth: AUTH,
        repo: { owner: 'acme', repo: 'team-workflows', branch: 'main', isPrivate: true },
        now: NOW,
        sleep: async () => {},
      },
    )

    const branch = `submit/${SLUG}-20261025090000`
    expect(calls.createFork).toHaveLength(0)
    expect(calls.listTree).toEqual([{ owner: 'acme', repo: 'team-workflows', branch: 'main' }])
    expect(calls.deleteFile.every((call) => call.owner === 'acme')).toBe(true)
    expect(calls.createPull).toMatchObject([
      { owner: 'acme', repo: 'team-workflows', head: branch, base: 'main' },
    ])
    expect(calls.createPull[0]!.body).toContain('from the team repository')
    expect(result).toMatchObject({ slug: SLUG, files: 3 })
  })
})

describe('branchStamp', () => {
  it('is a second-precision UTC stamp with an optional retry suffix', () => {
    expect(branchStamp(NOW)).toBe('20261025090000')
    expect(branchStamp(NOW, 1)).toBe('20261025090000-1')
  })

  it('changes within the same minute, so a quick update gets a fresh branch', () => {
    const later = new Date(NOW.getTime() + 40_000)
    expect(branchStamp(later)).not.toBe(branchStamp(NOW))
  })
})
