/**
 * Node Goal Inspector — edit a node's structured Goal Contract: goal, success
 * criteria, preconditions, failure meaning and repair hints.
 *
 * Unlike the earlier read-only version this is shown for EVERY node: when no
 * contract exists the user can add the goal and success criteria manually. The
 * contract is only persisted once it has a non-empty goal AND at least one
 * well-formed success criterion; before that the section stays in edit mode.
 *
 * Editing the contract invalidates the workflow's certification (the caller
 * marks the workflow unverified).
 *
 * @module workflow-editor/sidebar/NodeGoalInspector
 */

import { useState } from 'react'
import type { WorkflowCondition } from '../../lib/workflow/conditions'
import {
  nodeGoalContractOf,
  normalizeNodeGoalContract,
  withNodeGoalContract,
} from '../../lib/workflow/node-goal-contract'
import type { TranslateFn } from '../i18n'
import ConditionEditor from './ConditionEditor'

export interface NodeGoalInspectorProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  t: TranslateFn
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-semibold text-strong">{children}</span>
}

export default function NodeGoalInspector({ data, onChange, t }: NodeGoalInspectorProps) {
  const existing = nodeGoalContractOf(data)

  // Local draft used when no valid contract exists yet, so the user can type a
  // goal and add conditions before the contract is well-formed enough to store.
  const [draft, setDraft] = useState<{
    goal: string
    successCriteria: WorkflowCondition[]
  }>(() => ({
    goal: typeof data?.['description'] === 'string' ? data['description'] : '',
    successCriteria: [],
  }))

  const goal = existing?.goal ?? draft.goal
  const successCriteria = existing?.successCriteria ?? draft.successCriteria

  const commit = (nextGoal: string, nextCriteria: WorkflowCondition[]) => {
    // Persist only when a valid contract can be built.
    const normalized = normalizeNodeGoalContract({
      version: 1,
      goal: nextGoal,
      successCriteria: nextCriteria,
    })
    if (normalized) {
      onChange(withNodeGoalContract(data, normalized))
      return
    }
    // Otherwise keep editing the local draft.
    setDraft({ goal: nextGoal, successCriteria: nextCriteria })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <Label>{t('nodeInspectorGoal')}</Label>
        <textarea
          className="block w-full resize-y rounded-md border border-border bg-panel px-2 py-1.5 text-xs text-ink outline-none focus:border-accent"
          rows={2}
          value={goal}
          onChange={(e) => commit(e.target.value, successCriteria)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label>{t('nodeInspectorSuccessCriteria')}</Label>
        <ConditionEditor
          conditions={successCriteria}
          t={t}
          onChange={(next) => commit(goal, next)}
        />
      </div>

      {existing?.preconditions && existing.preconditions.length > 0 && (
        <div className="flex flex-col gap-1">
          <Label>{t('nodeInspectorPreconditions')}</Label>
          <ConditionEditor
            conditions={existing.preconditions}
            t={t}
            onChange={(next) => {
              const updated = normalizeNodeGoalContract({
                ...existing,
                preconditions: next,
              })
              if (updated) onChange(withNodeGoalContract(data, updated))
            }}
          />
        </div>
      )}

      <p className="text-[11px] text-muted">{t('nodeInspectorEditInvalidates')}</p>
    </div>
  )
}
