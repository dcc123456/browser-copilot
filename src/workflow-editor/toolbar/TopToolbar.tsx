/**
 * Top toolbar — compact Automa-style controls in an in-flow row.
 *
 * Left group: palette toggle + Editor/Logs/Goal/Data-table tabs. Right group:
 * debug/testing, group-pack (when a chain is selected), record, a labelled Save
 * (with an unsaved-changes dot) and Run. Canvas history and auto-layout live in
 * the bottom toolbar. The workflow name/rename live in the left sidebar header.
 *
 * @module workflow-editor/toolbar/TopToolbar
 */

import {
  Bug,
  CheckCircle2,
  CircleDot,
  CircleStop,
  Group,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Save,
  SquareTerminal,
  Table2,
  Target,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { TranslateFn } from '../i18n'
import type { EditorRepairStatus } from '../use-repair-events'

export default function TopToolbar({
  paletteOpen,
  onTogglePalette,
  debugMode,
  onToggleDebug,
  testingMode,
  onToggleTesting,
  saving,
  dirty,
  running,
  recording,
  onSave,
  onRun,
  onOpenLogs,
  onOpenGoal,
  onOpenDataTable,
  onToggleRecording,
  selectedCount,
  onPackSelection,
  repair,
  onCancelRepair,
  t,
}: {
  paletteOpen: boolean
  onTogglePalette: () => void
  /** Debug mode: capture per-block variables for the logs viewer. */
  debugMode: boolean
  onToggleDebug: () => void
  /** Testing mode: pause at breakpoints while running. */
  testingMode: boolean
  onToggleTesting: () => void
  saving: boolean
  /** Canvas differs from the saved workflow — drives the Save-button dot. */
  dirty: boolean
  running: boolean
  recording: boolean
  onSave: () => void
  onRun: () => void
  /** Open the run-logs modal. */
  onOpenLogs: () => void
  /** Open the workflow-goal modal. */
  onOpenGoal: () => void
  /** Open the data-table explanation panel. */
  onOpenDataTable: () => void
  onToggleRecording: () => void
  /** How many canvas nodes are selected right now. */
  selectedCount: number
  /** Fold the selected chain into one group node. */
  onPackSelection: () => void
  /** Background AI repair status for the workflow in this editor. */
  repair?: EditorRepairStatus
  onCancelRepair?: () => void
  t: TranslateFn
}) {
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
        <span className="wf-tab wf-tab-active cursor-default" aria-current="page">
          {t('editor')}
        </span>
        <button
          type="button"
          className="wf-tab inline-flex items-center gap-1.5"
          onClick={onOpenLogs}
          title={t('logsTitle')}
        >
          <SquareTerminal size={14} />
          {t('logs')}
        </button>
        <button
          type="button"
          className="wf-tab inline-flex items-center gap-1.5"
          onClick={onOpenGoal}
          title={t('workflowGoalTitle')}
        >
          <Target size={14} />
          {t('workflowGoalTab')}
        </button>
        <button
          type="button"
          className="wf-tab inline-flex items-center gap-1.5"
          onClick={onOpenDataTable}
          title={t('dataTableTitle')}
        >
          <Table2 size={14} />
          {t('dataTable')}
        </button>
      </div>

      {repair && repair.state !== 'idle' ? (
        <div className="wf-toolbar-group flex items-center gap-1.5">
          <span
            title={repair.state === 'failed' ? repair.reason : undefined}
            className={`flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[11px] font-medium ${
              repair.state === 'running'
                ? 'text-accent'
                : repair.state === 'success'
                  ? 'text-ok'
                  : 'text-err'
            }`}
          >
            {repair.state === 'running' ? (
              <LoaderCircle size={13} className="wf-spin" aria-hidden />
            ) : repair.state === 'success' ? (
              <CheckCircle2 size={13} aria-hidden />
            ) : (
              <TriangleAlert size={13} aria-hidden />
            )}
            {repair.state === 'running'
              ? t('repairRunning')
              : repair.state === 'success'
                ? t('repairSuccess')
                : t('repairFailed')}
          </span>
          {repair.state === 'running' ? (
            <button
              type="button"
              className="wf-icon-btn"
              title={t('repairCancel')}
              onClick={onCancelRepair}
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
      ) : null}

      <span className="wf-toolbar-spacer" />

      <div className="wf-toolbar-group">
        <button
          type="button"
          className={`wf-debug-toggle${debugMode ? ' wf-debug-on' : ''}`}
          title={t('debugModeHint')}
          aria-label={t('debugMode')}
          aria-pressed={debugMode}
          onClick={onToggleDebug}
        >
          <Bug size={14} />
        </button>
        <button
          type="button"
          className={`wf-debug-toggle${testingMode ? ' wf-debug-on' : ''}`}
          title={t('testingModeHint')}
          aria-label={t('testingMode')}
          aria-pressed={testingMode}
          onClick={onToggleTesting}
        >
          <Pause size={14} />
        </button>
        {/* Packing only ever makes sense for a chain, so the button waits for a
            real selection instead of turning a single click into a surprise. */}
        {selectedCount >= 2 && (
          <button
            type="button"
            className="wf-icon-btn"
            title={t('groupPack')}
            onClick={onPackSelection}
          >
            <Group size={14} />
          </button>
        )}
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
          className="wf-btn-accent relative inline-flex h-8 items-center gap-1.5 rounded-lg border-none px-3 text-[13px] font-semibold disabled:cursor-default disabled:opacity-50"
          title={`${t('save')} (Ctrl+S)`}
          onClick={onSave}
          disabled={saving}
        >
          {saving ? <LoaderCircle size={14} className="wf-spin" /> : <Save size={14} />}
          <span>{t('save')}</span>
          {dirty && !saving && (
            <span
              className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-danger ring-2 ring-panel"
              title={t('unsavedChanges')}
              aria-label={t('unsavedChanges')}
            />
          )}
        </button>
        <button
          type="button"
          className="wf-icon-btn"
          title={`${t('run')} (Ctrl+Enter)`}
          onClick={onRun}
          disabled={running}
        >
          {running ? <LoaderCircle size={14} className="wf-spin" /> : <Play size={14} />}
        </button>
      </div>
    </div>
  )
}
