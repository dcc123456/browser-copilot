/**
 * Classic-token connect controls, shared by the publish and feedback dialogs.
 *
 * Controls only: each host supplies its own section shell, because publish also
 * renders a connected row with a disconnect action while feedback only reports
 * the login.
 *
 * @module sidepanel/MarketplaceConnectPanel
 */

import { useState } from 'react'
import { connectMarketplaceToken } from '../lib/marketplace/connect'
import type { MarketplaceAuth } from '../lib/marketplace/types'
import { useT } from './i18n'
import { connectFailureText } from './marketplace-errors'

const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=public_repo&description=Browser%20Copilot'

interface Props {
  /** Called after `GET /user` resolved and the token was stored. */
  onConnected: (auth: MarketplaceAuth) => void
  /** Blocks the controls while the host dialog is busy. */
  disabled?: boolean
}

export default function MarketplaceConnectPanel({
  onConnected,
  disabled,
}: Props): React.ReactElement {
  const t = useT()
  const [tokenInput, setTokenInput] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  const connect = async (): Promise<void> => {
    setConnectError(null)
    setConnecting(true)
    try {
      const auth = await connectMarketplaceToken(tokenInput)
      setTokenInput('')
      onConnected(auth)
    } catch (caught) {
      console.warn('[marketplace] connect failed', caught)
      setConnectError(connectFailureText(t, caught))
    } finally {
      setConnecting(false)
    }
  }

  const blocked = disabled || connecting

  return (
    <>
      <p className="mt-1 mb-2 text-[11.5px] leading-snug text-muted">
        {t.marketplaceConnectHint}{' '}
        <a className="text-accent" href={TOKEN_URL} rel="noreferrer" target="_blank">
          {t.marketplaceConnectCreateToken}
        </a>
      </p>
      <div className="flex items-center gap-2">
        <input
          autoComplete="off"
          className="min-w-0 flex-1"
          disabled={blocked}
          onChange={(event) => {
            setTokenInput(event.target.value)
            setConnectError(null)
          }}
          placeholder={t.marketplaceConnectTokenPlaceholder}
          type="password"
          value={tokenInput}
        />
        <button
          className="section-action"
          disabled={blocked || !tokenInput.trim()}
          onClick={() => void connect()}
          type="button"
        >
          {t.marketplaceConnectButton}
        </button>
      </div>
      <p className="mt-1 mb-0 text-[11px] leading-snug text-muted">
        {t.marketplaceConnectScopeHint}
      </p>
      {connectError && (
        <p className="mt-1 mb-0 text-[11.5px] text-err" role="alert">
          {connectError}
        </p>
      )}
    </>
  )
}