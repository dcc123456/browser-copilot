/**
 * Settings card: connect the panel to a private team repository.
 *
 * The card owns the whole lifecycle of the connection — probe, store, warn,
 * disconnect — because the repo address and token are a single unit: a token
 * without its repository is useless and a repository without a token only
 * produces 404s. Browsing and applying happen in the marketplace tab; this
 * card never reads workflows itself.
 *
 * Tailwind semantic tokens only (light + dark).
 *
 * @module sidepanel/TeamSharingCard
 */

import { useEffect, useState, type ReactElement } from 'react'
import { TEAM_CATALOG_CACHE_KEY, invalidateCatalogCache } from '../lib/marketplace/catalog'
import { GitHubClient } from '../lib/marketplace/github-client'
import { parseRepoFullName } from '../lib/marketplace/repo'
import {
  clearTeamConnection,
  getTeamAuth,
  getTeamRepo,
  resolveTeamConnection,
  setTeamConnection,
  type TeamRepoConfig,
} from '../lib/marketplace/team'
import { isClassicToken } from '../lib/marketplace/token'
import { MarketplaceError, type MarketplaceAuth } from '../lib/marketplace/types'
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui/button-styles'
import { marketplaceErrorMessage } from './marketplace-errors'
import { useT } from './i18n'

const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo&description=Browser%20Copilot%20Team'

interface Props {
  /** Test/preview seam: skip reading `chrome.storage.local`. */
  initial?: { config: TeamRepoConfig | null; auth: MarketplaceAuth | null }
}

export default function TeamSharingCard({ initial }: Props): ReactElement {
  const t = useT()
  const [config, setConfig] = useState<TeamRepoConfig | null | undefined>(initial?.config)
  const [auth, setAuth] = useState<MarketplaceAuth | null>(initial?.auth ?? null)
  const [repoInput, setRepoInput] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (initial) return
    let cancelled = false
    void Promise.all([getTeamRepo(), getTeamAuth()]).then(([storedConfig, storedAuth]) => {
      if (cancelled) return
      setConfig(storedConfig)
      setAuth(storedAuth)
    })
    return () => {
      cancelled = true
    }
  }, [initial])

  const connect = async (): Promise<void> => {
    setError(null)
    const parsed = parseRepoFullName(repoInput.trim())
    if (!parsed) {
      setError(t.settingsTeamRepoInvalid)
      return
    }
    const token = tokenInput.trim()
    if (!isClassicToken(token)) {
      setError(t.settingsTeamTokenInvalid)
      return
    }
    setBusy(true)
    try {
      const resolved = await resolveTeamConnection(
        new GitHubClient({ token }),
        parsed.owner,
        parsed.repo,
        token,
      )
      await setTeamConnection(resolved.config, resolved.auth)
      // A different repository has a different catalog; keeping the old cache
      // would show the previous team's workflows for up to two hours.
      await invalidateCatalogCache(TEAM_CATALOG_CACHE_KEY)
      setConfig(resolved.config)
      setAuth(resolved.auth)
      setRepoInput('')
      setTokenInput('')
    } catch (caught) {
      if (caught instanceof MarketplaceError && caught.code === 'not-found') {
        setError(t.settingsTeamRepoNotFound)
      } else {
        setError(marketplaceErrorMessage(t, caught))
      }
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    setError(null)
    try {
      await clearTeamConnection()
      await invalidateCatalogCache(TEAM_CATALOG_CACHE_KEY)
      setConfig(null)
      setAuth(null)
    } catch (caught) {
      setError(marketplaceErrorMessage(t, caught))
    }
  }

  return (
    <div className="mb-2.5 rounded-[10px] border border-border bg-panel p-3">
      <span className="font-semibold">{t.settingsTeamTitle}</span>
      <p className="mt-1.5 mb-2.5 text-[11px] leading-relaxed text-muted">{t.settingsTeamIntro}</p>
      {config && (
        <div>
          <p className="m-0 text-[12px] leading-relaxed text-ink">
            {t.settingsTeamConnected({
              repo: `${config.owner}/${config.repo}`,
              login: auth?.login ?? '',
            })}
          </p>
          {config.isPublic && (
            <p className="mt-1 mb-0 text-[11px] leading-relaxed text-warn">
              {t.settingsTeamPublicWarning}
            </p>
          )}
          {!config.canPush && (
            <p className="mt-1 mb-0 text-[11px] leading-relaxed text-warn">
              {t.settingsTeamReadOnlyWarning}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button className={SECONDARY_BUTTON} onClick={() => void disconnect()} type="button">
              {t.settingsTeamDisconnect}
            </button>
          </div>
        </div>
      )}
      {config === null && (
        <div className="flex flex-col gap-2">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-muted">
              {t.settingsTeamRepoLabel}
            </span>
            <input
              autoComplete="off"
              className="w-full"
              disabled={busy}
              onChange={(event) => {
                setRepoInput(event.target.value)
                setError(null)
              }}
              placeholder={t.settingsTeamRepoPlaceholder}
              spellCheck={false}
              value={repoInput}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-muted">
              {t.settingsTeamTokenLabel}
            </span>
            <input
              autoComplete="off"
              className="w-full"
              disabled={busy}
              onChange={(event) => {
                setTokenInput(event.target.value)
                setError(null)
              }}
              placeholder={t.settingsTeamTokenPlaceholder}
              type="password"
              value={tokenInput}
            />
            <span className="mt-1 block text-[11px] leading-snug text-muted">
              {t.settingsTeamTokenHint}{' '}
              <a className="text-accent" href={TOKEN_URL} rel="noreferrer" target="_blank">
                {t.settingsTeamTokenLink}
              </a>
            </span>
          </label>
          {error && (
            <p className="m-0 text-[11.5px] leading-relaxed text-err" role="alert">
              {error}
            </p>
          )}
          <div>
            <button
              className={PRIMARY_BUTTON}
              disabled={busy || !repoInput.trim() || !tokenInput.trim()}
              onClick={() => void connect()}
              type="button"
            >
              {busy ? t.settingsTeamConnecting : t.settingsTeamConnect}
            </button>
          </div>
        </div>
      )}
      {config && error && (
        <p className="mt-1.5 mb-0 text-[11.5px] leading-relaxed text-err" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
