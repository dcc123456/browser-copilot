/**
 * Node Goal Inspector — displays (and optionally edits) a node's structured
 * Goal Contract: goal, success criteria, preconditions, failure meaning and
 * repair hints. Hidden entirely for legacy nodes without `__workflowAi`.
 *
 * Editing the contract invalidates the workflow's certification (the caller
 * marks the workflow unverified).
 *
 * @module workflow-editor/sidebar/NodeGoalInspector
 */

import { ListChecks, ShieldAlert, Target, Wrench } from 'lucide-react'
import { describeCondition } from '../../lib/workflow/conditions'
import {
  nodeGoalContractOf,
  normalizeNodeGoalContract,
  withNodeGoalContract,
  type WorkflowNodeGoalContract,
} from '../../lib/workflow/node-goal-contract'
import type { TranslateFn } from '../i18n'
import { useEditorLocale } from '../locale-context'

export interface NodeGoalInspectorProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  t: TranslateFn
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-panel p-3">
      <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-strong">
        {icon}
        {label}
      </h4>
      {children}
    </section>
  )
}

export default function NodeGoalInspector({ data, onChange, t }: NodeGoalInspectorProps) {
  const { bt } = useEditorLocale()
  const contract = nodeGoalContractOf(data)
  if (!contract) return null

  const update = (patch: Partial<WorkflowNodeGoalContract>) => {
    const next = normalizeNodeGoalContract({ ...contract, ...patch })
    if (!next) return
    onChange(withNodeGoalContract(data, next))
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Row icon={<Target size={13} />} label={t('nodeInspectorGoal')}>
        <textarea
          className="wf-input"
          rows={2}
          value={contract.goal}
          onChange={(e) => update({ goal: e.target.value })}
        />
      </Row>

      <Row icon={<ListChecks size={13} />} label={t('nodeInspectorSuccessCriteria')}>
        {contract.successCriteria.length === 0 ? (
          <p className="text-xs text-muted">{bt('No success criteria.')}</p>
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted">
            {contract.successCriteria.map((condition, i) => (
              <li key={i}>{describeCondition(condition)}</li>
            ))}
          </ul>
        )}
      </Row>

      {contract.preconditions && contract.preconditions.length > 0 && (
        <Row icon={<ShieldAlert size={13} />} label={t('nodeInspectorPreconditions')}>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted">
            {contract.preconditions.map((condition, i) => (
              <li key={i}>{describeCondition(condition)}</li>
            ))}
          </ul>
        </Row>
      )}

      {contract.failureMeaning && contract.failureMeaning.length > 0 && (
        <Row icon={<ShieldAlert size={13} />} label={t('nodeInspectorFailureMeaning')}>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted">
            {contract.failureMeaning.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </Row>
      )}

      {contract.repairHints && contract.repairHints.length > 0 && (
        <Row icon={<Wrench size={13} />} label={t('nodeInspectorRepairHints')}>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted">
            {contract.repairHints.map((hint, i) => (
              <li key={i}>
                <code>{hint.target}</code>: {hint.action}
              </li>
            ))}
          </ul>
        </Row>
      )}

      <p className="text-[11px] text-muted">{t('nodeInspectorEditInvalidates')}</p>
    </div>
  )
}
