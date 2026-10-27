/**
 * Shared types and constants for the GitHub Releases self-updater.
 *
 * The repository is hard-coded: no part of this module accepts a URL from the
 * user or a page, so a compromised workflow cannot redirect the updater.
 *
 * @module lib/update/types
 */

export const UPDATE_REPO_OWNER = 'dcc123456'
export const UPDATE_REPO_NAME = 'browser-copilot'
export const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases`
export const UPDATE_LATEST_API_URL = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest`
/** Public redirect to the newest tag page; reads without spending API quota. */
export const UPDATE_LATEST_PAGE_URL = `${UPDATE_RELEASES_URL}/latest`
export const UPDATE_ASSET_URL_PREFIX = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/download/`

export const UPDATE_STATE_KEY = 'update.state'
export const UPDATE_DISMISSED_KEY = 'update.dismissedVersion'
export const UPDATE_PENDING_KEY = 'update.pendingReloadVersion'
/** Backups the updater must remove once the new build is running. */
export const UPDATE_BACKUP_KEY = 'update.backups'

/**
 * A folder `applyUpdate` created inside the install directory. It is only
 * deleted after the panel opens on the version it belongs to: until the
 * reload, it is the only way back to a working build.
 */
export interface UpdateBackup {
  folder: string
  version: string
}
export const UPDATE_CHECK_ALARM = 'update-check'
export const UPDATE_CHECK_INTERVAL_MINUTES = 12 * 60
/** One-shot alarm used to retry a transient failure before the next 12h tick. */
export const UPDATE_RETRY_ALARM = 'update-retry'

/** Which build produced this extension; decides the release asset. */
export type UpdateVariant = 'ocr' | 'no-ocr' | 'firefox'

export interface UpdateAssetInfo {
  name: string
  url: string
  size: number
  /** GitHub's `sha256:<hex>` digest. Never derived locally. */
  digest: string
}

export interface UpdateReleaseInfo {
  version: string
  tag: string
  name: string
  htmlUrl: string
  /** Release body, plain text and length-capped for storage. */
  notes: string
  publishedAt: string
}

export type UpdateCheckErrorCode =
  'network' | 'rate-limited' | 'http' | 'invalid-release' | 'asset-missing'

export interface UpdateCheckError {
  code: UpdateCheckErrorCode
  /** Developer-facing detail; the UI localizes by `code`. */
  message: string
}

export interface UpdateState {
  checkedAt: number
  currentVersion: string
  latest: UpdateReleaseInfo | null
  asset: UpdateAssetInfo | null
  available: boolean
  error: UpdateCheckError | null
  /** Consecutive transient failures; absent on states written before retries existed. */
  failures?: number
  /** Epoch ms of the next automatic retry, or `null` when nothing is scheduled. */
  retryAt?: number | null
}

export type UpdateStage =
  'downloading' | 'verifying' | 'extracting' | 'backing-up' | 'writing' | 'done'

export interface UpdateProgress {
  stage: UpdateStage
  /** Bytes downloaded in the `downloading` stage. */
  loaded: number
  /** Total bytes when the server reported `content-length`. */
  total: number | null
  /** Files written in the `writing` stage. */
  filesWritten?: number
  filesTotal?: number
}

/** Error code surfaced to the UI when a check or an apply step fails. */
export class UpdateFailure extends Error {
  readonly code: UpdateCheckErrorCode
  /** Epoch ms GitHub said the quota resets, when it told us. */
  readonly retryAt?: number

  constructor(code: UpdateCheckErrorCode, message: string, retryAt?: number) {
    super(message)
    this.name = 'UpdateFailure'
    this.code = code
    this.retryAt = retryAt
  }
}

export type UpdateApplyErrorCode =
  | 'not-development-install'
  | 'picker-failed'
  | 'permission-denied'
  | 'folder-invalid'
  | 'download-failed'
  | 'digest-mismatch'
  | 'archive-invalid'
  | 'archive-unsafe-path'
  | 'archive-duplicate-path'
  | 'variant-mismatch'
  | 'backup-failed'
  | 'write-failed'
  | 'aborted'

/** Failure while validating or applying a downloaded release. */
export class UpdateApplyError extends Error {
  readonly code: UpdateApplyErrorCode

  constructor(code: UpdateApplyErrorCode, message: string) {
    super(message)
    this.name = 'UpdateApplyError'
    this.code = code
  }
}
