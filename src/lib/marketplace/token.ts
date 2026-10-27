/**
 * The GitHub tokens the marketplace stores: classic PATs, one per source.
 *
 * The public marketplace token publishes through a fork, so it must be able to
 * create and push to the user's own public repositories. A team token reads
 * (and, for members with write access, pushes branches to) a private repo, so
 * it needs the `repo` scope. Classic tokens are the only kind with a stable
 * permission model for that; fine-grained tokens cannot reliably open a PR
 * against a repository the user does not own, so they are rejected up front
 * instead of failing halfway through a publish.
 *
 * Tokens live in `chrome.storage.local` (never in the user's data folder), are
 * masked in the UI, and are never exported or logged.
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

/** Reads a token record under `key`; null when absent or no longer classic. */
export async function readAuth(key: string): Promise<MarketplaceAuth | null> {
  const stored = await chrome.storage.local.get(key)
  const raw = stored[key]
  if (!raw || typeof raw !== 'object') return null
  const { token, login } = raw as Partial<MarketplaceAuth>
  if (typeof token !== 'string' || !isClassicToken(token)) return null
  if (typeof login !== 'string' || !login || login.length > LOGIN_MAX) return null
  return { token, login }
}

/** Validates and writes a token record under `key`. */
export async function writeAuth(key: string, auth: MarketplaceAuth): Promise<void> {
  if (!isClassicToken(auth.token)) {
    throw new Error('Only classic GitHub tokens (ghp_…) are supported')
  }
  if (!auth.login || auth.login.length > LOGIN_MAX) {
    throw new Error('A GitHub login is required to save the token')
  }
  await chrome.storage.local.set({ [key]: { ...auth } })
}

export async function removeAuth(key: string): Promise<void> {
  await chrome.storage.local.remove(key)
}

export function getAuth(): Promise<MarketplaceAuth | null> {
  return readAuth(MARKETPLACE_AUTH_KEY)
}

/** Validates and stores a token; callers resolve `login` with `GET /user` first. */
export function setAuth(auth: MarketplaceAuth): Promise<void> {
  return writeAuth(MARKETPLACE_AUTH_KEY, auth)
}

export function clearAuth(): Promise<void> {
  return removeAuth(MARKETPLACE_AUTH_KEY)
}
