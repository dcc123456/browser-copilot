/**
 * Maps a {@link MarketplaceError} to the translated copy for its stable code.
 * Shared by the publish dialog and the marketplace page so a failed write
 * reads the same wherever it happened.
 *
 * @module sidepanel/marketplace-errors
 */

import type { Messages } from '../lib/i18n'
import { MarketplaceError, type MarketplaceErrorCode } from '../lib/marketplace/types'

const ERROR_KEY: Record<MarketplaceErrorCode, keyof Messages> = {
  'auth-required': 'marketplaceErrorAuthRequired',
  unauthorized: 'marketplaceErrorUnauthorized',
  forbidden: 'marketplaceErrorForbidden',
  'rate-limited': 'marketplaceErrorRateLimited',
  'not-found': 'marketplaceErrorNotFound',
  conflict: 'marketplaceErrorConflict',
  invalid: 'marketplaceErrorInvalid',
  'fork-pending': 'marketplaceErrorForkPending',
  network: 'marketplaceErrorNetwork',
}

export function marketplaceErrorMessage(t: Messages, error: unknown): string {
  if (error instanceof MarketplaceError) return t[ERROR_KEY[error.code]] as string
  return error instanceof Error ? error.message : String(error)
}
