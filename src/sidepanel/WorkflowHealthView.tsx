/**
 * Workflow health line (spec §22 · Commit 15).
 *
 * Renders the local-history-derived {@link WorkflowHealthSummary}: a plain
 * status word, a passed/total count, and the last verified / failure / recovery
 * facts. Every value maps to a real run, so there is no unexplainable score.
 * Semantic Tailwind tokens only; all copy via i18n.
 *
 * @module sidepanel/WorkflowHealthView
 */

import type { ReactNode } from 'react'
import type { WorkflowHealthSummary } from '../lib/workflow/workflow-health'
import { useT } from './i18n'

export interface WorkflowHealthViewProps {
  health: WorkflowHealthSummary
}

const STATUS_CLASS: Record<WorkflowHealthSummary['status'], string> = {
  stable: 'text-ok',
  'needs-attention': 'text-warn',
  'no-data': 'text-muted',
}

function statusLabel(
  status: WorkflowHealthSummary['status'],
  t: ReturnType<typeof useT>,
): string {
  switch (status) {
    case 'stable':
      return t.healthStatusStable
    case 'needs-attention':
      return t.healthStatusNeedsAttention
    default:
      return t.healthStatusNoData
  }
}

/** Compact, explainable health summary for one workflow card. */
export function WorkflowHealthView({ health }: WorkflowHealthViewProps): ReactNode {
  const t = useT()
  return (
    <div className="flex flex-col gap-0.5 text-[11px] leading-snug">
      <span className="flex flex-wrap items-center gap-x-1.5">
        <span className={`font-semibold ${STATUS_CLASS[health.status]}`}>
          {statusLabel(health.status, t)}
        </span>
        {health.totalRuns > 0 && (
          <span className="text-muted">
            {t.healthRunsPassed({
              passed: health.passedRuns,
              total: health.totalRuns,
            })}
          </span>
        )}
      </span>

      {health.lastVerifiedAt !== undefined && (
        <span className="text-muted">
          {t.healthLastVerified({
            time: new Date(health.lastVerifiedAt).toLocaleString(navigator.language),
          })}
        </span>
      )}

      {health.lastFailureCategory && (
        <span className="text-muted">
          {t.healthLastFailure({ category: health.lastFailureCategory })}
        </span>
      )}

      {(health.repairedRuns > 0 || health.resumedRuns > 0) && (
        <span className="text-muted">
          {t.healthRecoveryCounts({
            repaired: health.repairedRuns,
            resumed: health.resumedRuns,
          })}
        </span>
      )}
    </div>
  )
}
