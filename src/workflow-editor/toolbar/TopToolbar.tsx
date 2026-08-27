/**
 * Floating top toolbar — compact Automa-style controls across the canvas top.
 * Left group: palette toggle + name (icon first, name truncated small). Center:
 * Editor/Logs tabs. Right: record / save / run.
 *
 * @module workflow-editor/toolbar/TopToolbar
 */

import { BlockIcon } from '../../lib/workflow/blocks/icons'
import type { TranslateFn } from '../i18n'

export type EditorTab = 'editor' | 'logs'

export default function TopToolbar({
  workflowName,
  workflowIcon,
  tab,
  onTabChange,
  sidebarOpen,
  paletteOpen,
  onToggleSidebar,
  onTogglePalette,
  dirty,
  saving,
  running,
  recording,
  onSave,
  onRun,
  onToggleRecording,
  onAutoLayout,
  t,
}: {
  workflowName: string
  workflowIcon: string
  tab: EditorTab
  onTabChange: (t: EditorTab) => void
  sidebarOpen: boolean
  paletteOpen: boolean
  onToggleSidebar: () => void
  onTogglePalette: () => void
  dirty: boolean
  saving: boolean
  running: boolean
  recording: boolean
  onSave: () => void
  onRun: () => void
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
          <span className="wf-toolbar-name">{workflowName}</span>
        </span>
        <button type="button" className="wf-icon-btn" title={t('autoLayout')} onClick={onAutoLayout}>
          <i className="ri-magic-line" />
        </button>
      </div>

      <div className="wf-toolbar-group wf-toolbar-tabs">
        <button
          type="button"
          className={tab === 'editor' ? 'wf-tab wf-tab-active' : 'wf-tab'}
          onClick={() => onTabChange('editor')}
        >
          {t('editor')}
        </button>
        <button
          type="button"
          className={tab === 'logs' ? 'wf-tab wf-tab-active' : 'wf-tab'}
          onClick={() => onTabChange('logs')}
        >
          {t('logs')}
        </button>
      </div>

      <span className="wf-toolbar-spacer" />

      <div className="wf-toolbar-group">
        <button
          type="button"
          className="wf-icon-btn"
          title={t('toggleSidebar')}
          onClick={onToggleSidebar}
        >
          <i className={sidebarOpen ? 'ri-side-bar-fill' : 'ri-side-bar-line'} />
        </button>
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
          {dirty && <span className="wf-dirty-dot" />}
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
