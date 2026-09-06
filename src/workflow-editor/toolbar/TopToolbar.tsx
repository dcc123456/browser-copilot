/**
 * Floating top toolbar — compact Automa-style controls across the canvas top.
 *
 * Left group: palette toggle (PanelLeft open/close icons matching the
 * expand/collapse intent) + the workflow name (CLICK opens a rename dialog —
 * no more inline keystroke renaming) + auto-layout. Center: debug mode + Logs
 * toggles (nowrap so the labels never wrap). Right: record / save / run.
 *
 * @module workflow-editor/toolbar/TopToolbar
 */

import {
  Bug,
  CircleDot,
  CircleStop,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Save,
  SquareTerminal,
  WandSparkles,
} from 'lucide-react'
import { useState } from 'react'
import { BlockIcon } from '../../lib/workflow/blocks/icons'
import Modal from '../ui/Modal'
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
  // Rename dialog state: the toolbar shows the name as a button; editing
  // happens in the dialog so a stray click can no longer turn the name into
  // an input mid-canvas-work.
  const [renameOpen, setRenameOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState(workflowName)

  const confirmRename = (): void => {
    const next = nameDraft.trim()
    if (next && next !== workflowName) onRename(next)
    setRenameOpen(false)
  }

  return (
    <div className="wf-toolbar">
      <div className="wf-toolbar-group">
        <button
          type="button"
          className="wf-icon-btn"
          title={paletteOpen ? t('hidePalette') : t('addBlocks')}
          onClick={onTogglePalette}
        >
          {paletteOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </button>
        <button
          type="button"
          className="wf-toolbar-mini wf-toolbar-name-btn"
          title={t('renameWorkflow')}
          onClick={() => {
            setNameDraft(workflowName)
            setRenameOpen(true)
          }}
        >
          <BlockIcon icon={workflowIcon || 'lucide:Workflow'} size={16} />
          <span className="wf-toolbar-name">{workflowName || t('untitled')}</span>
          <Pencil size={11} className="wf-name-pencil" />
          {dirty && <span className="wf-dirty-dot" title={t('unsavedChanges')} />}
        </button>
        <button
          type="button"
          className="wf-icon-btn"
          title={t('autoLayout')}
          onClick={onAutoLayout}
        >
          <WandSparkles size={14} />
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
          <Bug size={14} />
          <span>{t('debugMode')}</span>
        </button>
        <button type="button" className="wf-tab" onClick={onOpenLogs} title={t('logsTitle')}>
          <SquareTerminal size={14} />
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
          {recording ? <CircleStop size={14} /> : <CircleDot size={14} />}
          {recording && <span className="wf-rec-label">REC</span>}
        </button>
        <button
          type="button"
          className="wf-icon-btn wf-btn-primary"
          title={`${t('save')} (Ctrl+S)`}
          onClick={onSave}
          disabled={saving}
        >
          <Save size={14} />
        </button>
        <button
          type="button"
          className="wf-icon-btn wf-btn-accent"
          title={`${t('run')} (Ctrl+Enter)`}
          onClick={onRun}
          disabled={running}
        >
          {running ? <LoaderCircle size={14} className="wf-spin" /> : <Play size={14} />}
        </button>
      </div>

      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title={t('renameWorkflow')}
        size="sm"
      >
        <input
          autoFocus
          aria-label={t('workflowName')}
          className="wf-rename-input"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') confirmRename()
          }}
        />
        <div className="wf-rename-actions">
          <button type="button" className="wf-tab" onClick={() => setRenameOpen(false)}>
            {t('cancel')}
          </button>
          <button type="button" className="wf-tab wf-tab-active" onClick={confirmRename}>
            {t('save')}
          </button>
        </div>
      </Modal>
    </div>
  )
}
