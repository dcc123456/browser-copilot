/**
 * Workflow Goal Modal — edit the workflow-level goal behind the L3 gate.
 *
 * The goal is `settings.goalSpec`: a summary plus the success conditions the
 * run is checked against after its last step. When a condition fails, the run
 * outcome carries `目标未达成：<unmet rows>` and the editor shows it as the run
 * failure. Generated workflows get a goal derived from node postconditions;
 * this modal is the manual way to correct it, extend it, or remove it.
 *
 * Reuses {@link ConditionEditor} so element rows are named and pinned exactly
 * as they are in a node's goal contract. Only the summary and success
 * conditions are edited here; terminal-state conditions already on the goal
 * are carried through unchanged (they are what makes an already-done unsafe
 * action count as success).
 *
 * @module workflow-editor/sidebar/WorkflowGoalModal
 */

import { useState } from 'react'
import { isWorkflowCondition, type WorkflowCondition } from '../../lib/workflow/conditions'
import {
  conditionTargetName,
  conditionTargetSelector,
} from '../../lib/workflow/element-fingerprint'
import { normalizeGoalSpec } from '../../lib/workflow/goal'
import type { WorkflowGoalSpec } from '../../lib/workflow/reliability'
import type { WorkflowSettings } from '../../lib/workflow/types'
import type { TranslateFn } from '../i18n'
import Modal from '../ui/Modal'
import ConditionEditor from './ConditionEditor'

export interface WorkflowGoalModalProps {
  settings: WorkflowSettings
  onClose: () => void
  /** The normalized spec, or `null` to remove the goal (turns the gate off). */
  onSave: (goalSpec: WorkflowGoalSpec | null) => void
  t: TranslateFn
}

/**
 * A row a person would call filled in.
 *
 * `isWorkflowCondition` is deliberately lenient about empty element targets —
 * an empty `accessibleName` is still a string — because the observer must be
 * able to read recorded shapes without rejecting them. A half-typed editor row
 * is the other direction: stored as-is it matches everything, so the goal would
 * always pass. This check is the stricter, authoring-side reading.
 */
function isRowComplete(condition: WorkflowCondition): boolean {
  if (!isWorkflowCondition(condition)) return false
  if (!('target' in condition)) return true
  const named =
    conditionTargetName(condition.target).trim() || conditionTargetSelector(condition.target).trim()
  if (!named) return false
  return condition.kind !== 'elementText' || condition.expected.trim().length > 0
}

export default function WorkflowGoalModal({
  settings,
  onClose,
  onSave,
  t,
}: WorkflowGoalModalProps) {
  const existing = normalizeGoalSpec(settings.goalSpec)
  const [summary, setSummary] = useState(existing?.summary ?? '')
  const [conditions, setConditions] = useState<WorkflowCondition[]>(
    existing?.successConditions ?? [],
  )
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const terminalStateConditions = existing?.terminalStateConditions
  const nextSpec = normalizeGoalSpec({
    summary: summary.trim(),
    successConditions: conditions,
    ...(terminalStateConditions?.length ? { terminalStateConditions } : {}),
  })
  const canSave = conditions.every(isRowComplete) && nextSpec !== undefined

  return (
    <Modal open onClose={onClose} title={t('workflowGoalTitle')} size="md">
      <div className="flex flex-col gap-3">
        <p className="m-0 text-xs text-muted">{t('workflowGoalHint')}</p>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-strong">{t('workflowGoalSummary')}</span>
          <textarea
            rows={2}
            aria-label={t('workflowGoalSummary')}
            placeholder={t('workflowGoalSummaryPlaceholder')}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-strong">
            {t('workflowGoalConditions')}
          </span>
          <ConditionEditor conditions={conditions} t={t} onChange={setConditions} />
        </div>

        {terminalStateConditions?.length ? (
          <p className="m-0 text-[11px] text-muted">{t('workflowGoalTerminalKept')}</p>
        ) : null}
        {!canSave && <p className="m-0 text-[11px] text-muted">{t('workflowGoalIncomplete')}</p>}
        {confirmingDelete && (
          <p className="m-0 text-[11px] text-err">{t('workflowGoalDeleteWarning')}</p>
        )}

        <div className="mt-1 flex items-center justify-end gap-2">
          {settings.goalSpec !== undefined && (
            <button
              type="button"
              className="mr-auto inline-flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-xs text-muted hover:bg-hover hover:text-err"
              onClick={() => {
                if (!confirmingDelete) {
                  setConfirmingDelete(true)
                  return
                }
                onSave(null)
                onClose()
              }}
            >
              {confirmingDelete ? t('workflowGoalDeleteConfirm') : t('workflowGoalDelete')}
            </button>
          )}
          <button type="button" className="wf-tab" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            type="button"
            className="wf-btn-accent inline-flex h-8 items-center gap-1.5 rounded-lg border-none px-3 text-[13px] font-semibold disabled:cursor-default disabled:opacity-50"
            disabled={!canSave}
            onClick={() => {
              if (!nextSpec || !canSave) return
              onSave(nextSpec)
              onClose()
            }}
          >
            {t('save')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
