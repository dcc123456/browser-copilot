/**
 * Floating top toolbar — compact Automa-style controls across the canvas top.
 *
 * Left group: palette toggle + an INLINE-EDITABLE workflow name (Automa lets you
 * rename the workflow from the editor top bar) + auto-layout. Center: a Logs
 * button that opens the run-logs/debug modal. Right: record / save / run.
 *
 * @module workflow-editor/toolbar/TopToolbar
 */

import { BlockIcon } from '../../lib/workflow/blocks/icons'
import type { TranslateFn } from '../i18n'

export default function TopToolbar({
  workflowName,
  workflowIcon,
  paletteOpen,
  onTogglePalette,
  onRename,
  debugMode,
  onToggleDebug,
  dirty,
  saving,
  running,
  recording,
  onSave,
  onRun,
  onOpenLogs,
  onToggleRecording,
  onAutoLayout,
  t,
}: {
  workflowName: string
  workflowIcon: string
  paletteOpen: boolean
  onTogglePalette: () => void
  /** Rename the workflow (called on every keystroke of the inline name input). */
  onRename: (name: string) => void
  /** Debug mode: capture per-block variables for the logs viewer. */
  debugMode: boolean
  onToggleDebug: () => void
  dirty: boolean
  saving: boolean
  running: boolean
  recording: boolean
  onSave: () => void
  onRun: () => void
  /** Open the run-logs modal. */
  onOpenLogs: () => void
  onToggleRecording: () => void
  onAutoLayout: () => void
  t: TranslateFn
}) {
  return (
    <div className="wf-toolbar">
      <div className="wf-toolbar-group">
        <button type="button" className="wf-icon-btn" title={t('addBlocks')} onClick={onTogglePalette}>
          <i className={paletteOpen ? 'ri-function-line' : 'ri-add-line'} />
        </button>
        <span className="wf-toolbar-mini" title={workflowName}>
          <BlockIcon icon={workflowIcon || 'ri-flow-chart'} size={16} />
          <input
            className="wf-toolbar-name-input"
            value={workflowName}
            placeholder={t('untitled')}
            onChange={(e) => onRename(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label={t('workflowName')}
          />
          {dirty && <span className="wf-dirty-dot" title={t('unsavedChanges')} />}
        </span>
        <button type="button" className="wf-icon-btn" title={t('autoLayout')} onClick={onAutoLayout}>
          <i className="ri-magic-line" />
        </button>
      </div>

      <div className="wf-toolbar-group wf-toolbar-tabs">
        <button
          type="button"
          className={`wf-debug-toggle${debugMode ? ' wf-debug-on' : ''}`}
          title={t('debugModeHint')}
          onClick={onToggleDebug}
          aria-pressed={debugMode}
        >
          <i className="ri-bug-line" />
          <span>{t('debugMode')}</span>
        </button>
        <button type="button" className="wf-tab" onClick={onOpenLogs} title={t('logsTitle')}>
          <i className="ri-terminal-box-line" />
          {t('logs')}
        </button>
      </div>

      <span className="wf-toolbar-spacer" />

      <div className="wf-toolbar-group">
        <button
          type="button"
          className={`wf-icon-btn wf-btn-record${recording ? ' wf-rec-active' : ''}`}
          title={recording ? t('stopRecord') : t('record')}
          onClick={onToggleRecording}
          disabled={false}
        >
          <i className={recording ? 'ri-stop-circle-line' : 'ri-record-circle-line'} />
          {recording && <span className="wf-rec-label">REC</span>}
        </button>
        <button
          type="button"
          className="wf-icon-btn wf-btn-primary"
          title={`${t('save')} (Ctrl+S)`}
          onClick={onSave}
          disabled={saving}
        >
          <i className="ri-save-line" />
        </button>
        <button
          type="button"
          className="wf-icon-btn wf-btn-accent"
          title={`${t('run')} (Ctrl+Enter)`}
          onClick={onRun}
          disabled={running}
        >
          <i className={running ? 'ri-loader-4-line wf-spin' : 'ri-play-line'} />
        </button>
      </div>
    </div>
  )
}
