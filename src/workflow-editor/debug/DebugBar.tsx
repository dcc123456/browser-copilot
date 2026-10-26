/**
 * Breakpoint debug bar — Automa's testing-mode controls (Resume / Next / Stop).
 *
 * Shown while a testing run is suspended at a breakpoint. The paused block's
 * variable snapshot is the same one the run recorded for the logs viewer, so
 * the Data button reuses {@link VariablesInspector} instead of a second
 * inspector. Live updates: every control is one `debug.control` command.
 *
 * @module workflow-editor/debug/DebugBar
 */

import { Play, SkipForward, Square } from 'lucide-react'
import { useState } from 'react'
import Modal from '../ui/Modal'
import { VariablesInspector } from '../sidebar/log-view'
import { useEditorLocale } from '../locale-context'

export interface DebugPause {
  nodeId: string
  label: string
  at: number
}

export default function DebugBar({
  pause,
  variables,
  onControl,
}: {
  pause: DebugPause
  /** Variables captured at the pause; absent until the snapshot propagates. */
  variables?: Record<string, unknown>
  onControl: (action: 'resume' | 'next' | 'stop') => void
}) {
  const { t } = useEditorLocale()
  const [dataOpen, setDataOpen] = useState(false)
  return (
    <>
      <div className="absolute bottom-20 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-xl border border-border bg-panel px-3 py-2 shadow-lg">
        <span className="mr-1 h-2 w-2 shrink-0 rounded-full bg-err" aria-hidden />
        <span className="shrink-0 text-[11px] text-muted">{t('debugPausedAt')}</span>
        <span className="max-w-56 truncate text-xs font-semibold text-ink" title={pause.label}>
          {pause.label}
        </span>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent"
          onClick={() => onControl('resume')}
        >
          <Play size={12} aria-hidden />
          {t('debugResume')}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-ink hover:bg-hover"
          onClick={() => onControl('next')}
        >
          <SkipForward size={12} aria-hidden />
          {t('debugNext')}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-err hover:bg-hover"
          onClick={() => onControl('stop')}
        >
          <Square size={12} aria-hidden />
          {t('debugStop')}
        </button>
        <button
          type="button"
          className="inline-flex items-center rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-ink hover:bg-hover disabled:cursor-not-allowed disabled:text-faint"
          disabled={!variables}
          onClick={() => setDataOpen(true)}
        >
          {t('debugData')}
        </button>
      </div>
      <Modal
        open={dataOpen}
        onClose={() => setDataOpen(false)}
        title={`${t('debugData')} — ${pause.label}`}
        size="md"
      >
        <VariablesInspector vars={variables ?? {}} onBack={() => setDataOpen(false)} />
      </Modal>
    </>
  )
}
