/**
 * Bottom-center canvas actions: undo, redo and one-click auto-layout.
 *
 * Sits above the canvas as a floating bar so the three most frequent editing
 * gestures stay reachable without crossing the window. Undo/redo are also on
 * the keyboard; the buttons exist because the shortcuts were undiscoverable.
 *
 * @module workflow-editor/toolbar/BottomToolbar
 */
import { Redo2, Undo2, WandSparkles } from 'lucide-react'
import type { TranslateFn } from '../i18n'

export default function BottomToolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onAutoLayout,
  t,
}: {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onAutoLayout: () => void
  t: TranslateFn
}) {
  return (
    <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-panel p-1 shadow-lg">
      <button
        type="button"
        className="wf-icon-btn disabled:cursor-default disabled:opacity-40"
        title={`${t('undo')} (Ctrl+Z)`}
        aria-label={t('undo')}
        disabled={!canUndo}
        onClick={onUndo}
      >
        <Undo2 size={14} />
      </button>
      <button
        type="button"
        className="wf-icon-btn disabled:cursor-default disabled:opacity-40"
        title={`${t('redo')} (Ctrl+Shift+Z)`}
        aria-label={t('redo')}
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2 size={14} />
      </button>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <button
        type="button"
        className="wf-icon-btn"
        title={t('autoLayout')}
        aria-label={t('autoLayout')}
        onClick={onAutoLayout}
      >
        <WandSparkles size={14} />
      </button>
    </div>
  )
}
