/**
 * Settings card: connect the panel to private team repositories.
 *
 * The card owns the whole lifecycle of every connection — probe, store, warn,
 * disconnect — because a repository address and its token are a single unit: a
 * token without its repository is useless and a repository without a token only
 * produces 404s. A user can belong to several teams, each with its own token, so
 * the card lists what is connected and keeps the form ready for one more.
 * Browsing and applying happen in the marketplace tab; this card never reads
 * workflows itself.
 *
 * Tailwind semantic tokens only (light + dark).
 *
 * @module sidepanel/TeamSharingCard
 */

import { useEffect, useState, type ReactElement } from 'react'
import { teamCatalogCacheKey, invalidateCatalogCache } from '../lib/marketplace/catalog'
import { GitHubClient } from '../lib/marketplace/github-client'
import { parseRepoFullName } from '../lib/marketplace/repo'
import {
  clearTeamConnection,
  connectionKey,
  getTeamConnections,
  resolveTeamConnection,
  setTeamConnection,
  type TeamConnection,
} from '../lib/marketplace/team'
import { isClassicToken } from '../lib/marketplace/token'
import { MarketplaceError } from '../lib/marketplace/types'
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui/button-styles'
import { marketplaceErrorMessage } from './marketplace-errors'
import { useT } from './i18n'

const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo&description=Browser%20Copilot%20Team'

interface Props {
  /** Test/preview seam: skip reading `chrome.storage.local`. */
  initialConnections?: TeamConnection[]
}

export default function TeamSharingCard({ initialConnections }: Props): ReactElement {
  const t = useT()
  const [connections, setConnections] = useState<TeamConnection[] | undefined>(initialConnections)
  const [repoInput, setRepoInput] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Card-level error for a failed disconnect; connect errors stay in the form. */
  const [listError, setListError] = useState<string | null>(null)

  useEffect(() => {
    if (initialConnections) return
    let cancelled = false
    void getTeamConnections().then((stored) => {
      if (!cancelled) setConnections(stored)
    })
    return () => {
      cancelled = true
    }
  }, [initialConnections])

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
      // Only this repository's catalog is stale after (re)connecting it.
      await invalidateCatalogCache(teamCatalogCacheKey(resolved.config))
      setConnections((current) => {
        const key = connectionKey(resolved)
        const rest = (current ?? []).filter((entry) => connectionKey(entry) !== key)
        return [...rest, resolved]
      })
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

  const disconnect = async (connection: TeamConnection): Promise<void> => {
    setListError(null)
    const key = connectionKey(connection)
    try {
      await clearTeamConnection(key)
      await invalidateCatalogCache(teamCatalogCacheKey(connection.config))
      setConnections((current) => (current ?? []).filter((entry) => connectionKey(entry) !== key))
    } catch (caught) {
      setListError(marketplaceErrorMessage(t, caught))
    }
  }

  const connected = connections ?? []
  return (
    <div className="mb-2.5 rounded-[10px] border border-border bg-panel p-3">
      <span className="font-semibold">{t.settingsTeamTitle}</span>
      <p className="mt-1.5 mb-2.5 text-[11px] leading-relaxed text-muted">{t.settingsTeamIntro}</p>

      {connected.length > 0 && (
        <ul className="mb-2.5 flex list-none flex-col gap-1.5 p-0">
          {connected.map((connection) => {
            const key = connectionKey(connection)
            return (
              <li className="rounded-md border border-border bg-panel-2 p-2" key={key}>
                <p className="m-0 text-[12px] leading-relaxed text-ink">
                  {t.settingsTeamConnected({ repo: key, login: connection.auth.login })}
                </p>
                {connection.config.isPublic && (
                  <p className="mt-1 mb-0 text-[11px] leading-relaxed text-warn">
                    {t.settingsTeamPublicWarning}
                  </p>
                )}
                {!connection.config.canPush && (
                  <p className="mt-1 mb-0 text-[11px] leading-relaxed text-warn">
                    {t.settingsTeamReadOnlyWarning}
                  </p>
                )}
                <button
                  className={`${SECONDARY_BUTTON} mt-2`}
                  onClick={() => void disconnect(connection)}
                  type="button"
                >
                  {t.settingsTeamDisconnect}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {listError && (
        <p className="mt-0 mb-2 text-[11.5px] leading-relaxed text-err" role="alert">
          {listError}
        </p>
      )}

      {connections !== undefined && (
        <div className="flex flex-col gap-2">
          {connected.length > 0 && (
            <span className="text-[12px] font-medium text-muted">{t.settingsTeamAddAnother}</span>
          )}
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
    </div>
  )
}
