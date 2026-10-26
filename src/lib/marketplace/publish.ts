/**
 * Publishing a workflow as a pull request, and removing one the same way.
 *
 * Split in two so the panel can show the sanitizer warnings BEFORE anything
 * leaves the machine: `preparePublish` is pure (hash, slug, meta, files), and
 * `pushPublish` performs the fork → branch → files → PR sequence.
 *
 * The fork path is used even when the publisher owns the marketplace repo:
 * one write path means one set of failure modes, and the maintainer still
 * reviews every change as a PR.
 *
 * Unpublishing is the inverse and deliberately keeps the same shape: a branch
 * that deletes the workflow's files and a PR the maintainer merges. Nothing is
 * deleted from anyone's local library — copies already applied keep working.
 *
 * @module lib/marketplace/publish
 */

import type { Workflow } from '../workflow/types'
import {
  attachmentFile,
  attachmentPath,
  formatAttachmentSize,
  uniqueAttachmentFile,
} from './attachments'
import { collectDependencies } from './dependencies'
import type { GitHubPull, GitHubRef, GitHubRepo, GitHubTree } from './github-client'
import {
  assetPath,
  assetRepoPath,
  buildMeta,
  dependencyFile,
  metaPath,
  workflowDir,
  workflowHash,
  workflowPath,
} from './meta'
import { toPublishableWorkflow, type PublishWarning, type PublishableWorkflow } from './sanitize'
import { buildSlug } from './slug'
import {
  MARKETPLACE_BRANCH,
  MARKETPLACE_OWNER,
  MARKETPLACE_PR_BRANCH_PREFIX,
  MARKETPLACE_REPO,
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_BUNDLE_WORKFLOWS,
  MAX_PUBLISH_ATTACHMENT_BYTES,
  MAX_PUBLISH_ATTACHMENTS,
  MAX_PUBLISH_IMAGE_BYTES,
  MAX_PUBLISH_IMAGES,
  MarketplaceError,
  type MarketplaceAttachment,
  type MarketplaceAuth,
  type MarketplaceMeta,
  type MarketplacePublishInput,
} from './types'

/** The subset of the GitHub client the publish path needs. */
export interface PublishClient {
  getRepo(owner: string, repo: string): Promise<GitHubRepo>
  createFork(owner: string, repo: string): Promise<unknown>
  getRef(owner: string, repo: string, branch: string): Promise<GitHubRef>
  createRef(owner: string, repo: string, branch: string, sha: string): Promise<unknown>
  putFile(
    owner: string,
    repo: string,
    path: string,
    input: { message: string; contentBase64: string; branch: string },
  ): Promise<unknown>
  createPull(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<GitHubPull>
}

export interface PreparedFile {
  path: string
  contentBase64: string
}

/** One called workflow committed next to the listing it belongs to. */
export interface PreparedDependency {
  /** Id the publishing graph references it by. */
  id: string
  name: string
  /** Workflow-relative file, e.g. `deps/export-orders.json`. */
  path: string
  json: string
}

export interface PreparedPublish {
  publishable: PublishableWorkflow
  json: string
  hash: string
  slug: string
  version: number
  meta: MarketplaceMeta
  warnings: PublishWarning[]
  /** Called workflows, in the order they are listed in `meta.json`. */
  dependencies: PreparedDependency[]
  files: PreparedFile[]
}

export interface PreparePublishOptions {
  /** GitHub login resolved from the token (`GET /user`). */
  author: string
  now?: Date
  /** Looks up an already published workflow by slug, for version bumps. */
  findExistingMeta?: (slug: string) => Promise<MarketplaceMeta | null>
  /**
   * The publisher's whole library, used to resolve `execute-workflow` calls.
   * Omitted means no other workflow is known and every call is unsatisfied.
   */
  library?: readonly Workflow[]
}

export interface PushPublishDeps {
  client: PublishClient
  auth: MarketplaceAuth
  now?: Date
  sleep?: (ms: number) => Promise<void>
}

export interface PublishResult {
  prUrl: string
  prNumber: number
  slug: string
  version: number
  hash: string
  meta: MarketplaceMeta
}

/** Everything an unpublish needs beyond the publish client. */
export interface UnpublishClient extends PublishClient {
  listTree(owner: string, repo: string, branch: string): Promise<GitHubTree>
  deleteFile(
    owner: string,
    repo: string,
    path: string,
    input: { message: string; sha: string; branch: string },
  ): Promise<unknown>
}

export interface UnpublishDeps {
  client: UnpublishClient
  auth: MarketplaceAuth
  now?: Date
  sleep?: (ms: number) => Promise<void>
}

export interface UnpublishResult {
  prUrl: string
  prNumber: number
  slug: string
  /** Files the removal PR deletes: both JSON files plus every asset. */
  files: number
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

/** `YYYYMMDDHHmm`, with a retry suffix so a second attempt gets a fresh branch. */
export function branchStamp(now: Date, attempt = 0): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 12)
  return attempt === 0 ? stamp : `${stamp}-${attempt}`
}

function isConflict(error: unknown): boolean {
  return error instanceof MarketplaceError && error.code === 'conflict'
}

/**
 * Builds everything that will be committed. No network, except the optional
 * existing-workflow lookup used to decide whether this is an update.
 */
export async function preparePublish(
  input: MarketplacePublishInput,
  options: PreparePublishOptions,
): Promise<PreparedPublish> {
  const author = options.author.trim()
  if (!author) throw new MarketplaceError('auth-required', 'Connect GitHub before publishing')

  if (input.images.length > MAX_PUBLISH_IMAGES) {
    throw new MarketplaceError('invalid', `At most ${MAX_PUBLISH_IMAGES} images can be published`)
  }
  for (const image of input.images) {
    if (!image.type.startsWith('image/')) {
      throw new MarketplaceError('invalid', 'Only image files can be published')
    }
    if (image.size > MAX_PUBLISH_IMAGE_BYTES) {
      throw new MarketplaceError('invalid', 'Each image must be 1 MB or smaller')
    }
  }

  const attachments = input.attachments ?? []
  if (attachments.length > MAX_PUBLISH_ATTACHMENTS) {
    throw new MarketplaceError(
      'invalid',
      `At most ${MAX_PUBLISH_ATTACHMENTS} attachments can be published`,
    )
  }
  for (const attachment of attachments) {
    if (!attachment.name.trim()) {
      throw new MarketplaceError('invalid', 'Attachment name is empty')
    }
    if (attachment.blob.size > MAX_PUBLISH_ATTACHMENT_BYTES) {
      throw new MarketplaceError(
        'invalid',
        `Each attachment must be ${MAX_PUBLISH_ATTACHMENT_BYTES / 1024} KB or smaller`,
      )
    }
  }

  const now = options.now ?? new Date()
  const bundle = collectDependencies(input.workflow, options.library ?? [])
  if (bundle.missing.length > 0) {
    const refs = bundle.missing.map((call) => call.workflowId || call.nodeLabel).join(', ')
    throw new MarketplaceError('invalid', `Called workflows are missing: ${refs}`)
  }
  if (bundle.dependencies.length > MAX_BUNDLE_WORKFLOWS) {
    throw new MarketplaceError(
      'invalid',
      `A listing can carry at most ${MAX_BUNDLE_WORKFLOWS} called workflows`,
    )
  }

  const localRef = input.workflow.marketplace
  const provisionalSlug =
    localRef && localRef.author === author ? localRef.slug : buildSlug(input.workflow.name, '')
  const sanitized = toPublishableWorkflow(input.workflow, provisionalSlug)
  const publishable = sanitized.workflow
  const warnings: PublishWarning[] = [...sanitized.warnings]
  const dependencies: PreparedDependency[] = bundle.dependencies.map((dependency) => {
    const file = dependencyFile(dependency.path)
    if (!file) {
      throw new MarketplaceError('invalid', `Invalid called workflow path: ${dependency.path}`)
    }
    const prepared = toPublishableWorkflow(dependency.workflow, file)
    for (const warning of prepared.warnings) {
      warnings.push({ ...warning, workflow: dependency.workflow.name })
    }
    return {
      id: dependency.workflow.id,
      name: prepared.workflow.name,
      path: dependency.path,
      json: JSON.stringify(prepared.workflow, null, 2),
    }
  })
  const json = JSON.stringify(publishable, null, 2)
  const hash = await workflowHash(json)

  const takenAttachmentFiles = new Set<string>()
  const publishedAttachments: MarketplaceAttachment[] = attachments.map((attachment) => ({
    name: attachment.name.trim().slice(0, MAX_ATTACHMENT_NAME_CHARS),
    path: attachmentPath(
      uniqueAttachmentFile(attachmentFile(attachment.name), takenAttachmentFiles),
    ),
    size: attachment.blob.size,
  }))

  let slug: string
  let version = 1
  if (localRef && localRef.author === author) {
    slug = localRef.slug
    version = localRef.version + 1
  } else {
    slug = buildSlug(input.workflow.name, hash)
    const existing = await options.findExistingMeta?.(slug)
    if (existing) {
      if (existing.author !== author) {
        throw new MarketplaceError(
          'conflict',
          `A workflow with the slug "${slug}" is already published by @${existing.author}`,
        )
      }
      version = existing.version + 1
    }
  }

  // The slug is part of the published body, so re-serialize once it is final.
  const finalPublishable: PublishableWorkflow = { ...publishable, id: slug }
  const finalJson = JSON.stringify(finalPublishable, null, 2)
  const finalHash = await workflowHash(finalJson)

  const meta = buildMeta({
    slug,
    title: input.title,
    description: input.description,
    category: input.category,
    tags: input.tags,
    dependencies: dependencies.map(({ id, name, path }) => ({ id, name, path })),
    attachments: publishedAttachments,
    author,
    version,
    hash: finalHash,
    imageCount: input.images.length,
    videoUrl: input.videoUrl,
    now,
  })

  const files: PreparedFile[] = [
    { path: workflowPath(slug), contentBase64: textToBase64(finalJson) },
    {
      path: metaPath(slug),
      contentBase64: textToBase64(`${JSON.stringify(meta, null, 2)}\n`),
    },
  ]
  for (const dependency of dependencies) {
    files.push({
      path: assetRepoPath(slug, dependency.path),
      contentBase64: textToBase64(dependency.json),
    })
  }
  for (let index = 0; index < attachments.length; index += 1) {
    files.push({
      path: assetRepoPath(slug, publishedAttachments[index]!.path),
      contentBase64: await blobToBase64(attachments[index]!.blob),
    })
  }
  for (let index = 0; index < input.images.length; index += 1) {
    files.push({
      path: assetRepoPath(slug, assetPath(index)),
      contentBase64: await blobToBase64(input.images[index]!),
    })
  }

  return {
    publishable: finalPublishable,
    json: finalJson,
    hash: finalHash,
    slug,
    version,
    meta,
    warnings,
    dependencies,
    files,
  }
}

function pullTitle(meta: MarketplaceMeta): string {
  const verb = meta.version > 1 ? 'Update workflow' : 'Add workflow'
  return `${verb}: ${meta.title} [wf:${meta.slug}]`
}

function pullBody(meta: MarketplaceMeta): string {
  const lines = [
    'Published from Browser Copilot.',
    '',
    meta.description || '_No description provided._',
    '',
    `- category: \`${meta.category}\``,
    `- tags: ${meta.tags.length ? meta.tags.map((tag) => `\`${tag}\``).join(', ') : '—'}`,
    `- version: ${meta.version}`,
  ]
  if (meta.dependencies?.length) {
    lines.push(`- bundle: ${meta.dependencies.map((dep) => `\`${dep.name}\``).join(', ')}`)
  }
  if (meta.attachments?.length) {
    const files = meta.attachments.map(
      (file) => `\`${file.name}\` (${formatAttachmentSize(file.size)})`,
    )
    lines.push(`- attachments: ${files.join(', ')}`)
  }
  if (meta.videoUrl) lines.push(`- video: ${meta.videoUrl}`)
  lines.push('', '<sub>Merging makes this workflow available to every Browser Copilot user.</sub>')
  return lines.join('\n')
}

/** Resolves the repo that can receive the branch: the fork, or upstream itself. */
async function writableOwner(
  client: PublishClient,
  login: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  if (login === MARKETPLACE_OWNER) return login
  try {
    await client.getRepo(login, MARKETPLACE_REPO)
    return login
  } catch (error) {
    if (!(error instanceof MarketplaceError) || error.code !== 'not-found') throw error
  }

  await client.createFork(MARKETPLACE_OWNER, MARKETPLACE_REPO)
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await sleep(2000)
    try {
      await client.getRepo(login, MARKETPLACE_REPO)
      return login
    } catch (error) {
      if (!(error instanceof MarketplaceError) || error.code !== 'not-found') throw error
    }
  }
  throw new MarketplaceError('fork-pending', 'GitHub is still creating the fork; try again shortly')
}

/** Pushes the prepared files to a branch and opens the PR. */
export async function pushPublish(
  prepared: PreparedPublish,
  deps: PushPublishDeps,
): Promise<PublishResult> {
  if (!deps.auth.token)
    throw new MarketplaceError('auth-required', 'Connect GitHub before publishing')
  const login = deps.auth.login
  const now = deps.now ?? new Date()
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const upstream = await deps.client.getRepo(MARKETPLACE_OWNER, MARKETPLACE_REPO)
  const base = upstream.default_branch || MARKETPLACE_BRANCH
  const writable = await writableOwner(deps.client, login, sleep)
  const baseRef = await deps.client.getRef(writable, MARKETPLACE_REPO, base)
  const commitMessage = `Add workflow: ${prepared.meta.title} [wf:${prepared.slug}]`

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const branch = `${MARKETPLACE_PR_BRANCH_PREFIX}${prepared.slug}-${branchStamp(now, attempt)}`
    try {
      await deps.client.createRef(writable, MARKETPLACE_REPO, branch, baseRef.object.sha)
    } catch (error) {
      if (isConflict(error) && attempt === 0) continue
      throw error
    }

    for (const file of prepared.files) {
      await deps.client.putFile(writable, MARKETPLACE_REPO, file.path, {
        message: commitMessage,
        contentBase64: file.contentBase64,
        branch,
      })
    }

    try {
      const pull = await deps.client.createPull(MARKETPLACE_OWNER, MARKETPLACE_REPO, {
        title: pullTitle(prepared.meta),
        head: `${login}:${branch}`,
        base,
        body: pullBody(prepared.meta),
      })
      return {
        prUrl: pull.html_url,
        prNumber: pull.number,
        slug: prepared.slug,
        version: prepared.version,
        hash: prepared.hash,
        meta: prepared.meta,
      }
    } catch (error) {
      if (isConflict(error) && attempt === 0) continue
      throw error
    }
  }
  throw new MarketplaceError('conflict', 'A pull request for this workflow is already open')
}

/** Convenience wrapper used by tests and callers that do not preview warnings. */
export async function publishWorkflow(
  input: MarketplacePublishInput,
  deps: PushPublishDeps & {
    author: string
    findExistingMeta?: (slug: string) => Promise<MarketplaceMeta | null>
    library?: readonly Workflow[]
  },
): Promise<PublishResult> {
  const prepared = await preparePublish(input, {
    author: deps.author,
    now: deps.now,
    findExistingMeta: deps.findExistingMeta,
    library: deps.library,
  })
  return pushPublish(prepared, deps)
}

/** Repo blobs under `workflows/<slug>/`: the exact set an unpublish deletes. */
function workflowBlobs(tree: GitHubTree, slug: string): Array<{ path: string; sha: string }> {
  const prefix = `${workflowDir(slug)}/`
  return tree.tree
    .filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix))
    .map((entry) => ({ path: entry.path, sha: entry.sha }))
}

/**
 * Opens the pull request that removes a published workflow.
 *
 * The tree is read from the same branch the removal PR targets, so the shas
 * GitHub requires for a delete match the files the PR branch will hold. The
 * directory disappears once its last file is deleted; a merge by the
 * maintainer then drops the card from the next catalog read.
 */
export async function unpublishWorkflow(
  input: { slug: string; title: string },
  deps: UnpublishDeps,
): Promise<UnpublishResult> {
  if (!deps.auth.token) {
    throw new MarketplaceError('auth-required', 'Connect GitHub before unpublishing')
  }
  const login = deps.auth.login
  const now = deps.now ?? new Date()
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const upstream = await deps.client.getRepo(MARKETPLACE_OWNER, MARKETPLACE_REPO)
  const base = upstream.default_branch || MARKETPLACE_BRANCH
  const writable = await writableOwner(deps.client, login, sleep)
  const baseRef = await deps.client.getRef(writable, MARKETPLACE_REPO, base)
  const tree = await deps.client.listTree(writable, MARKETPLACE_REPO, base)
  const blobs = workflowBlobs(tree, input.slug)
  if (blobs.length === 0) {
    throw new MarketplaceError('not-found', `No published files for "${input.slug}" were found`)
  }

  const commitMessage = `Remove workflow: ${input.title} [wf:${input.slug}]`
  const body = [
    'Unpublished from Browser Copilot.',
    '',
    `- slug: \`${input.slug}\``,
    `- version files: ${blobs.length}`,
    '',
    '<sub>Merging removes this workflow from the marketplace. Copies already applied locally keep working.</sub>',
  ].join('\n')

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const branch = `${MARKETPLACE_PR_BRANCH_PREFIX}${input.slug}-${branchStamp(now, attempt)}`
    try {
      await deps.client.createRef(writable, MARKETPLACE_REPO, branch, baseRef.object.sha)
    } catch (error) {
      if (isConflict(error) && attempt === 0) continue
      throw error
    }

    for (const blob of blobs) {
      await deps.client.deleteFile(writable, MARKETPLACE_REPO, blob.path, {
        message: commitMessage,
        sha: blob.sha,
        branch,
      })
    }

    try {
      const pull = await deps.client.createPull(MARKETPLACE_OWNER, MARKETPLACE_REPO, {
        title: commitMessage,
        head: `${login}:${branch}`,
        base,
        body,
      })
      return {
        prUrl: pull.html_url,
        prNumber: pull.number,
        slug: input.slug,
        files: blobs.length,
      }
    } catch (error) {
      if (isConflict(error) && attempt === 0) continue
      throw error
    }
  }
  throw new MarketplaceError('conflict', 'A pull request for this workflow is already open')
}
