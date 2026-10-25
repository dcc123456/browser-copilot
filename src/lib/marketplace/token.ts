/**
 * The one credential the marketplace stores: a classic GitHub PAT.
 *
 * Publishing writes through a fork, so the token must be able to create and
 * push to the user's own public repositories. Classic tokens with `public_repo`
 * are the only kind with a stable permission model for that; fine-grained
 * tokens cannot reliably open a PR against a repository the user does not own,
 * so they are rejected up front instead of failing halfway through a publish.
 *
 * The token lives in `chrome.storage.local` (never in the user's data folder),
 * is masked in the UI, and is never exported or logged.
 *
 * @module lib/marketplace/token
 */

import type { MarketplaceAuth } from './types'

/** Configuration key; also listed in `fs-store.ts`'s CONFIG_KEYS. */
export const MARKETPLACE_AUTH_KEY = 'marketplaceAuth'

const CLASSIC_TOKEN_RE = /^ghp_[A-Za-z0-9]{20,}$/
const FINE_GRAINED_PREFIX = 'github_pat_'
const LOGIN_MAX = 64

export type TokenKind = 'classic' | 'fine-grained' | 'unknown'

export function tokenKind(token: string): TokenKind {
  const trimmed = token.trim()
  if (trimmed.startsWith(FINE_GRAINED_PREFIX)) return 'fine-grained'
  if (CLASSIC_TOKEN_RE.test(trimmed)) return 'classic'
  return 'unknown'
}

export function isClassicToken(token: string): boolean {
  return tokenKind(token) === 'classic'
}

/** Last four characters only — enough to tell two tokens apart in the UI. */
export function maskToken(token: string): string {
  return `••••${token.slice(-4)}`
}

export async function getAuth(): Promise<MarketplaceAuth | null> {
  const stored = await chrome.storage.local.get(MARKETPLACE_AUTH_KEY)
  const raw = stored[MARKETPLACE_AUTH_KEY]
  if (!raw || typeof raw !== 'object') return null
  const { token, login } = raw as Partial<MarketplaceAuth>
  if (typeof token !== 'string' || !isClassicToken(token)) return null
  if (typeof login !== 'string' || !login || login.length > LOGIN_MAX) return null
  return { token, login }
}

/** Validates and stores a token; callers resolve `login` with `GET /user` first. */
export async function setAuth(auth: MarketplaceAuth): Promise<void> {
  if (!isClassicToken(auth.token)) {
    throw new Error('The marketplace only accepts classic GitHub tokens (ghp_…)')
  }
  if (!auth.login || auth.login.length > LOGIN_MAX) {
    throw new Error('A GitHub login is required to save the marketplace token')
  }
  await chrome.storage.local.set({ [MARKETPLACE_AUTH_KEY]: { ...auth } })
}

export async function clearAuth(): Promise<void> {
  await chrome.storage.local.remove(MARKETPLACE_AUTH_KEY)
}
