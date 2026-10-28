/**
 * Resolves a pasted classic token to the account it belongs to and stores it
 * as the marketplace credential.
 *
 * The publish dialog and the feedback dialog connect with the same token, so
 * the "validate → GET /user → persist" sequence lives here once instead of
 * drifting in two dialogs.
 *
 * @module lib/marketplace/connect
 */

import { GitHubClient } from './github-client'
import { isClassicToken, setAuth } from './token'
import { MarketplaceError, type MarketplaceAuth } from './types'

export interface ConnectMarketplaceOptions {
  /** Test seam: replaces the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * @throws MarketplaceError('invalid') when the token is not a classic `ghp_`
 * one — rejected before any network call.
 * @throws MarketplaceError from `GET /user` (unauthorized, rate-limited, …).
 */
export async function connectMarketplaceToken(
  rawToken: string,
  options: ConnectMarketplaceOptions = {},
): Promise<MarketplaceAuth> {
  const token = rawToken.trim()
  if (!isClassicToken(token)) {
    throw new MarketplaceError('invalid', 'Only classic GitHub tokens (ghp_…) are supported')
  }
  const me = await new GitHubClient({ token, ...options }).getUser()
  const auth: MarketplaceAuth = { token, login: me.login }
  await setAuth(auth)
  return auth
}
