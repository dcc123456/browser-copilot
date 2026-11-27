/**
 * Localizes updater failures.
 *
 * The background and apply layers carry stable codes plus an English detail
 * string meant for developers; the panel owns the user-facing wording.
 *
 * @module sidepanel/update/error-text
 */

import type { Messages } from '../../lib/i18n'
import {
  UpdateApplyError,
  type UpdateApplyErrorCode,
  type UpdateCheckError,
} from '../../lib/update/types'

export function describeCheckError(t: Messages, error: UpdateCheckError): string {
  switch (error.code) {
    case 'network':
      return t.updateErrorNetwork
    case 'rate-limited':
      return t.updateErrorRateLimited
    case 'http':
      return t.updateErrorHttp
    case 'invalid-release':
      return t.updateErrorInvalidRelease
    case 'asset-missing':
      return t.updateErrorAssetMissing
    default:
      return t.updateErrorGeneric({ detail: error.message })
  }
}

const APPLY_ERROR_TEXT: Partial<Record<UpdateApplyErrorCode, keyof Messages>> = {
  'not-development-install': 'updateErrorNotDevelopment',
  'picker-failed': 'updateErrorPicker',
  'permission-denied': 'updateErrorPermission',
  'folder-invalid': 'updateErrorFolder',
  'download-failed': 'updateErrorDownload',
  'digest-mismatch': 'updateErrorDigest',
  'archive-invalid': 'updateErrorArchive',
  'archive-version-mismatch': 'updateErrorArchiveVersion',
  'archive-unsafe-path': 'updateErrorPath',
  'archive-duplicate-path': 'updateErrorDuplicate',
  'variant-mismatch': 'updateErrorVariant',
  'write-failed': 'updateErrorWrite',
  aborted: 'updateErrorAborted',
}

export function describeApplyError(t: Messages, error: unknown): string {
  if (error instanceof UpdateApplyError) {
    const key = APPLY_ERROR_TEXT[error.code]
    if (key) {
      const text = t[key]
      if (typeof text === 'string') return text
    }
  }
  return t.updateErrorGeneric({
    detail: error instanceof Error ? error.message : String(error),
  })
}

/**
 * Technical detail for failures whose localized line cannot say what actually
 * went wrong (writing into the install folder, where the browser error name is
 * the actionable clue). Every other code has a complete localized explanation,
 * so its detail would only repeat it.
 */
const DETAILED_CODES: ReadonlySet<UpdateApplyErrorCode> = new Set(['write-failed'])

export function describeApplyErrorDetail(error: unknown): string | null {
  return error instanceof UpdateApplyError && DETAILED_CODES.has(error.code) ? error.message : null
}
