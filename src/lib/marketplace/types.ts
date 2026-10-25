/**
 * Constants and shared types for the workflow marketplace.
 *
 * The marketplace is a public GitHub repository read through the REST API:
 * published workflows live as files, and each workflow's discussion is its
 * merged pull request. There is no server and no GitHub Action, so every limit
 * here is chosen against the anonymous rate budget (60 API calls per hour).
 *
 * @module lib/marketplace/types
 */

import type { Workflow } from '../workflow/types'

/** Repository that hosts every published workflow. */
export const MARKETPLACE_OWNER = 'dcc123456'
export const MARKETPLACE_REPO = 'BC-workflow'
export const MARKETPLACE_REPO_FULL = `${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}`
export const MARKETPLACE_BRANCH = 'main'

/** Bumped only when `meta.json` changes shape incompatibly. */
export const MARKETPLACE_SCHEMA_VERSION = 1

/**
 * How long a catalog read stays fresh. Two API calls per refresh against an
 * anonymous 60/hour budget allows ~20 refreshes/hour; 30 minutes keeps the
 * panel responsive without ever approaching that ceiling.
 */
export const MARKETPLACE_CACHE_TTL_MS = 30 * 60 * 1000

/** Browser branch prefix; the rest of the name is `<slug>-<stamp>`. */
export const MARKETPLACE_PR_BRANCH_PREFIX = 'submit/'

export const MAX_PUBLISH_IMAGES = 3
export const MAX_PUBLISH_IMAGE_BYTES = 1024 * 1024
export const MAX_WORKFLOW_JSON_BYTES = 512 * 1024
export const MAX_TITLE_CHARS = 120
export const MAX_DESCRIPTION_CHARS = 2000
export const MAX_TAGS = 8
export const MAX_TAG_CHARS = 24

/** Fixed category list, so labels can be translated instead of stored. */
export const MARKETPLACE_CATEGORIES = [
  'ecommerce',
  'content',
  'data',
  'office',
  'social',
  'other',
] as const

export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number]

/** One published workflow, as stored in `workflows/<slug>/meta.json`. */
export interface MarketplaceMeta {
  schema: typeof MARKETPLACE_SCHEMA_VERSION
  slug: string
  title: string
  description: string
  category: MarketplaceCategory
  tags: string[]
  /** GitHub login that opened the publishing PR. */
  author: string
  /** Starts at 1; increments on every accepted update. */
  version: number
  /** SHA-256 of the `workflow.json` committed for this version. */
  hash: string
  /** Repo-relative asset paths, e.g. `assets/1.webp`. */
  images: string[]
  /** External video link; videos are never committed to the repo. */
  videoUrl?: string
  createdAt: string
  updatedAt: string
}

/** A catalog entry with the engagement numbers resolved from GitHub. */
export interface MarketplaceCard {
  meta: MarketplaceMeta
  /** Merged PR that added or last updated this workflow, when known. */
  prNumber: number | null
  likes: number
  comments: number
}

/** Stable error codes, so the UI can translate instead of parsing messages. */
export type MarketplaceErrorCode =
  | 'auth-required'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'not-found'
  | 'conflict'
  | 'invalid'
  | 'fork-pending'
  | 'network'

/** Single error type crossing the marketplace modules. */
export class MarketplaceError extends Error {
  readonly code: MarketplaceErrorCode
  /** HTTP status when the failure came from GitHub. */
  readonly status?: number

  constructor(code: MarketplaceErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'MarketplaceError'
    this.code = code
    this.status = status
  }
}

/** Stored GitHub credential: only the token and the login it resolved to. */
export interface MarketplaceAuth {
  token: string
  login: string
}

/** A publishable workflow is the graph plus presentation fields, nothing local. */
export type MarketplacePublishInput = {
  workflow: Workflow
  title: string
  description: string
  category: MarketplaceCategory
  tags: string[]
  /** Already-compressed image files, in display order. */
  images: Blob[]
  videoUrl?: string
}
