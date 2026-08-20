/**
 * Error boundary for the side panel.
 *
 * A React render error propagates to the root and unmounts everything, so one bad
 * value used to blank the entire panel — including the Settings tab needed to fix
 * whatever caused it. That failure mode is worse than the bug itself.
 *
 * This keeps the panel usable: it shows what broke and offers a reload, rather
 * than leaving the user with an empty pane and a message only visible in
 * DevTools.
 *
 * @module sidepanel/ErrorBoundary
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { effectiveLocale, messagesFor, type Messages } from '../lib/i18n'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Messages are resolved from the browser language, not from settings.
 *
 * This boundary must be able to render when the app below it has failed — which
 * includes failing before settings ever loaded — so it cannot depend on the i18n
 * context or on any stored preference.
 */
const t: Messages = messagesFor(effectiveLocale('auto', navigator.language))

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the component stack in the console: it names the failing component,
    // which a minified message alone does not.
    console.error('[Browser Copilot] panel render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="pane">
        <div className="banner" data-kind="error">
          {t.errorPanelCrashed}
        </div>
        <div className="card">
          <div className="card-title">{t.errorWhatHappened}</div>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              fontSize: 12,
            }}
          >
            {error.message || String(error)}
          </pre>
          <p className="hint" style={{ marginTop: 10 }}>
            {t.errorVersionSkew}
          </p>
          <div className="actions">
            <button
              className="primary"
              onClick={() => {
                this.setState({ error: null })
              }}
              type="button"
            >
              {t.tryAgain}
            </button>
            <button onClick={() => window.location.reload()} type="button">
              {t.reloadPanel}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
