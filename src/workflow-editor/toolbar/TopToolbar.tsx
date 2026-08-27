/**
 * Floating top toolbar — React port of Automa's [id].vue toolbar +
 * EditorLocalActions. Sits in a pointer-events-none strip across the canvas
 * top; each interactive child re-enables pointer events.
 *
 * @module workflow-editor/toolbar/TopToolbar
 */

import { BlockIcon } from '../../lib/workflow/blocks/icons'

export type EditorTab = 'editor' | 'logs'

export default function TopToolbar({
  workflowName,
  workflowIcon,
  tab,
  onTabChange,
  sidebarOpen,
  onToggleSidebar,
  onTogglePalette,
  dirty,
  saving,
  running,
  recording,
  onSave,
  onRun,
  onToggleRecording,
}: {
  workflowName: string
  workflowIcon: string
  tab: EditorTab
  onTabChange: (t: EditorTab) => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onTogglePalette: () => void
  dirty: boolean
  saving: boolean
  running: boolean
  recording: boolean
  onSave: () => void
  onRun: () => void
  onToggleRecording: () => void
}) {
  return (
    <div className="wf-toolbar">
      <div className="wf-toolbar-card">
        <BlockIcon icon={workflowIcon || 'ri-flow-chart'} size={22} />
        <span className="wf-toolbar-name" title={workflowName}>
          {workflowName}
        </span>
      </div>

      <div className="wf-toolbar-group">
        <button
          type="button"
          className="wf-icon-btn"
          title="Toggle sidebar"
          onClick={onToggleSidebar}
        >
          <i className={sidebarOpen ? 'ri-side-bar-fill' : 'ri-side-bar-line'} />
        </button>
        <div className="wf-tabs">
          <button
            type="button"
            className={tab === 'editor' ? 'wf-tab wf-tab-active' : 'wf-tab'}
            onClick={() => onTabChange('editor')}
          >
            Editor
          </button>
          <button
            type="button"
            className={tab === 'logs' ? 'wf-tab wf-tab-active' : 'wf-tab'}
            onClick={() => onTabChange('logs')}
          >
            Logs
          </button>
        </div>
      </div>

      <span className="wf-toolbar-spacer" />

      <div className="wf-toolbar-group">
        <button
          type="button"
          className="wf-icon-btn"
          title="Add blocks"
          onClick={onTogglePalette}
        >
          <i className="ri-add-line" />
        </button>
        <button
          type="button"
          className={`wf-icon-btn${recording ? ' wf-rec-active' : ''}`}
          title={recording ? 'Stop recording' : 'Record workflow'}
          onClick={onToggleRecording}
        >
          <i className="ri-record-circle-line" />
        </button>
        <button
          type="button"
          className="wf-icon-btn wf-btn-primary"
          title="Save (Ctrl+S)"
          onClick={onSave}
          disabled={saving}
        >
          <i className="ri-save-line" />
          {dirty && <span className="wf-dirty-dot" />}
        </button>
        <button
          type="button"
          className="wf-icon-btn wf-btn-accent"
          title="Run (Ctrl+Enter)"
          onClick={onRun}
          disabled={running}
        >
          <i className={running ? 'ri-loader-4-line wf-spin' : 'ri-play-line'} />
        </button>
      </div>
    </div>
  )
}
