/**
 * Writes a feedback report and opens a GitHub issue with it.
 *
 * The token is the marketplace's shared credential: connecting here also
 * enables publishing, and a rejected token is cleared so the next attempt
 * starts from a clean connect instead of retrying a dead one.
 *
 * @module sidepanel/FeedbackDialog
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from '../ui/FormDialog'
import { collectFeedbackDiagnostics } from '../lib/feedback/diagnostics'
import {
  buildFeedbackIssue,
  FEEDBACK_ISSUE_REPO,
  FEEDBACK_MAX_CHARS,
  type FeedbackDiagnostics,
} from '../lib/feedback/issue'
import { GitHubClient } from '../lib/marketplace/github-client'
import { clearAuth, getAuth } from '../lib/marketplace/token'
import { MarketplaceError, type MarketplaceAuth } from '../lib/marketplace/types'
import { useI18n, useT } from './i18n'
import { connectFailureText } from './marketplace-errors'
import MarketplaceConnectPanel from './MarketplaceConnectPanel'

interface Props {
  onClose: () => void
  /** Test/preview seam: skip reading `chrome.storage.local`. */
  initialAuth?: MarketplaceAuth | null
  /** Test seam: skip `chrome.runtime` and `navigator` reads. */
  initialDiagnostics?: FeedbackDiagnostics
}

type Phase = 'idle' | 'sending' | 'sent'

export default function FeedbackDialog({
  onClose,
  initialAuth,
  initialDiagnostics,
}: Props): React.ReactElement {
  const t = useT()
  const { locale } = useI18n()
  const [auth, setAuthState] = useState<MarketplaceAuth | null | undefined>(initialAuth)
  const [text, setText] = useState('')
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true)
  const [phase, setPhase] = useState<Phase>('idle')
  const [sendError, setSendError] = useState<string | null>(null)
  const [issued, setIssued] = useState<{ number: number; url: string } | null>(null)
  // Two clicks in one React batch would both pass the `phase` guard.
  const sendingRef = useRef(false)

  useEffect(() => {
    if (initialAuth !== undefined) return
    void getAuth().then(setAuthState)
  }, [initialAuth])

  /** What the hint promises; the payload is read again at submit time. */
  const diagnosticsPreview = useMemo(
    () => initialDiagnostics ?? collectFeedbackDiagnostics(locale),
    [initialDiagnostics, locale],
  )

  const requestClose = (): void => {
    if (phase === 'sending') return
    onClose()
  }

  const submit = async (): Promise<void> => {
    if (sendingRef.current || !auth || !text.trim()) return
    sendingRef.current = true
    setPhase('sending')
    setSendError(null)
    try {
      const diagnostics = includeDiagnostics
        ? (initialDiagnostics ?? collectFeedbackDiagnostics(locale))
        : null
      const { title, body } = buildFeedbackIssue(t, { text, diagnostics })
      const issue = await new GitHubClient({ token: auth.token }).createIssue(
        FEEDBACK_ISSUE_REPO.owner,
        FEEDBACK_ISSUE_REPO.repo,
        { title, body },
      )
      setIssued({ number: issue.number, url: issue.html_url })
      setPhase('sent')
    } catch (caught) {
      if (caught instanceof MarketplaceError && caught.code === 'unauthorized') {
        await clearAuth()
        setAuthState(null)
      }
      setSendError(connectFailureText(t, caught))
      setPhase('idle')
    } finally {
      sendingRef.current = false
    }
  }

  return (
    <FormDialog
      footer={
        issued ? (
          <>
            <FormDialogCancelButton label={t.marketplaceClose} onClick={onClose} />
            <a
              className="inline-flex h-8 items-center rounded-lg border border-accent bg-accent px-3.5 text-[13px] font-semibold text-on-accent transition-colors duration-150 hover:bg-accent-strong"
              href={issued.url}
              rel="noreferrer"
              target="_blank"
            >
              {t.feedbackOpenIssue}
            </a>
          </>
        ) : (
          <>
            <FormDialogCancelButton
              disabled={phase === 'sending'}
              label={t.cancel}
              onClick={requestClose}
            />
            <FormDialogPrimaryButton
              disabled={phase !== 'idle' || !auth || !text.trim()}
              label={phase === 'sending' ? t.feedbackSending : t.feedbackSubmit}
              onClick={() => void submit()}
            />
          </>
        )
      }
      onClose={requestClose}
      title={t.feedbackDialogTitle}
      width="lg"
    >
      {issued ? (
        <div className="rounded-lg border border-border bg-panel-2 p-3">
          <p className="m-0 text-[13px] text-ink">{t.feedbackSent({ number: issued.number })}</p>
          <p className="mt-1 mb-0 text-[12px] text-muted">{t.feedbackSentHint}</p>
          <p className="mt-1 mb-0 break-all text-[12px] text-muted">{issued.url}</p>
        </div>
      ) : (
        <>
          <section className="mb-4 rounded-lg border border-border bg-panel-2 p-3">
            <h3 className="m-0 text-[12.5px] font-semibold text-ink">
              {t.marketplaceConnectTitle}
            </h3>
            {auth === undefined ? (
              <p className="mt-1 mb-0 text-[12.5px] text-muted">{t.marketplaceConnectLoading}</p>
            ) : auth ? (
              <p className="mt-2 mb-0 text-[12.5px] text-ink">
                {t.marketplaceConnectConnected({ login: auth.login })}
              </p>
            ) : (
              <MarketplaceConnectPanel disabled={phase === 'sending'} onConnected={setAuthState} />
            )}
          </section>

          <label className="mb-3 block">
            <span className="mb-1 block text-[12px] font-medium text-muted">
              {t.feedbackTextLabel}
            </span>
            <textarea
              className="min-h-[120px]"
              disabled={phase === 'sending'}
              maxLength={FEEDBACK_MAX_CHARS}
              onChange={(event) => setText(event.target.value)}
              placeholder={t.feedbackPlaceholder}
              value={text}
            />
            <span className="mt-1 block text-[11.5px] leading-snug text-muted">
              {t.feedbackHint({ max: FEEDBACK_MAX_CHARS })}
            </span>
          </label>

          <label className="checkbox items-start!">
            <input
              checked={includeDiagnostics}
              disabled={phase === 'sending'}
              onChange={(event) => setIncludeDiagnostics(event.target.checked)}
              type="checkbox"
            />
            <span className="min-w-0">
              <span className="block text-[12px] text-ink">{t.feedbackDiagnosticsLabel}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                {t.feedbackDiagnosticsHint({
                  version: diagnosticsPreview.version,
                  build: diagnosticsPreview.build,
                })}
              </span>
            </span>
          </label>

          {sendError && (
            <p
              className="mb-0 mt-3 rounded-lg border border-err bg-err-surface px-3 py-2 text-[12.5px] leading-relaxed break-words text-err"
              role="alert"
            >
              {sendError}
            </p>
          )}
        </>
      )}
    </FormDialog>
  )
}
