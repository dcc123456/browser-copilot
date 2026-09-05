/**
 * Multi-window picker host.
 *
 * Mounted once at the app root (next to {@link ConfirmHost}). When an
 * unattended run under the "ask" window policy needs a target, the service
 * worker broadcasts `window.pick.request` to every connected panel; each
 * panel shows this dialog and the FIRST `window.pick.response` wins — the
 * worker ignores answers for requests it has already resolved or timed out.
 *
 * Only plugin windows (panel connected or minimized) are listed: unattended
 * runs may never operate elsewhere, so there is nothing to pick beyond them.
 *
 * @module sidepanel/WindowPicker
 */

import { useEffect, useState } from 'react'
import type { WindowChoice } from '../lib/messages'
import { useT } from './i18n'

/** Mirrors background/window-policy.ts; kept local to avoid importing it. */
const PICK_TIMEOUT_MS = 30_000

interface ActivePick {
  requestId: string
  windows: WindowChoice[]
}

export default function WindowPicker(): React.ReactElement | null {
  const t = useT()
  const [pick, setPick] = useState<ActivePick | null>(null)
  const [myWindowId, setMyWindowId] = useState<number | undefined>(undefined)

  useEffect(() => {
    void chrome.windows
      .getCurrent()
      .then((win) => setMyWindowId(typeof win?.id === 'number' ? win.id : undefined))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const listener = (message: unknown, _sender: unknown, sendResponse: (v: unknown) => void): void => {
      if ((message as { type?: string } | undefined)?.type !== 'window.pick.request') return
      const request = message as { requestId: string; windows: WindowChoice[] }
      setPick({ requestId: request.requestId, windows: request.windows ?? [] })
      // Ack immediately so the worker's broadcast promise resolves instead of
      // dangling on an unanswered channel; the real answer flows via
      // `window.pick.response`.
      sendResponse({ ok: true })
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  // The worker times the request out on its own; this just keeps a stale
  // dialog from sitting on screen (e.g. it was answered by another panel).
  useEffect(() => {
    if (!pick) return
    const timer = window.setTimeout(() => setPick(null), PICK_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [pick])

  const answer = (windowId: number | null): void => {
    if (!pick) return
    setPick(null)
    void chrome.runtime
      .sendMessage({ type: 'window.pick.response', requestId: pick.requestId, windowId })
      .catch(() => {})
  }

  useEffect(() => {
    if (!pick) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        answer(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // answer closes over the current pick; rebind per pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick])

  if (!pick) return null

  return (
    <div className="fixed inset-0 z-[1000] flex items-start justify-center p-4 pt-[9vh]" role="presentation">
      <div
        className="absolute inset-0 bg-slate-950/55 backdrop-blur-[2px] animate-[dialog-fade_140ms_ease-out]"
        onClick={() => answer(null)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.windowPickTitle}
        className="relative w-full max-w-[320px] rounded-xl border border-border bg-panel shadow-[var(--bc-shadow)] p-4 animate-[dialog-slide-down_180ms_ease-out]"
      >
        <h2 className="m-0 text-[14px] font-semibold leading-snug text-ink">{t.windowPickTitle}</h2>
        <p className="m-0 mt-1.5 text-[12.5px] leading-relaxed text-muted">{t.windowPickHint}</p>

        <div className="mt-3 flex max-h-[45vh] flex-col gap-1.5 overflow-y-auto">
          {pick.windows.map((win) => (
            <button
              key={win.windowId}
              type="button"
              onClick={() => answer(win.windowId)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2 text-left transition-colors duration-150 hover:bg-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">
                  {win.title || `#${win.windowId}`}
                </span>
                {win.host && (
                  <span className="block truncate text-[11.5px] text-muted">{win.host}</span>
                )}
              </span>
              {win.windowId === myWindowId && (
                <span className="flex-none rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                  {t.windowPickBadgeThisPanel}
                </span>
              )}
              {win.isMinimized && (
                <span className="flex-none rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">
                  {t.windowPickBadgeMinimized}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => answer(null)}
            className="h-8 cursor-pointer rounded-lg border border-border bg-panel-2 px-3.5 text-[13px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  )
}
