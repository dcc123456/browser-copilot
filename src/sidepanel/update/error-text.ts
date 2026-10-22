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
  'archive-unsafe-path': 'updateErrorPath',
  'archive-duplicate-path': 'updateErrorDuplicate',
  'variant-mismatch': 'updateErrorVariant',
  'backup-failed': 'updateErrorBackup',
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
