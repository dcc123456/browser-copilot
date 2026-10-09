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
import type { ReplayFirstRunRecord } from '../lib/workflow/replay-metrics'
import type { WorkflowHealthSummary } from '../lib/workflow/workflow-health'
import { useT } from './i18n'

export interface WorkflowHealthViewProps {
  health: WorkflowHealthSummary
  /**
   * How the generated graph scored on its first replay at the revision it is
   * stored at — absent when the workflow was never generated or never run.
   */
  firstRun?: ReplayFirstRunRecord
}

const STATUS_CLASS: Record<WorkflowHealthSummary['status'], string> = {
  stable: 'text-ok',
  'needs-attention': 'text-warn',
  'no-data': 'text-muted',
}

function statusLabel(status: WorkflowHealthSummary['status'], t: ReturnType<typeof useT>): string {
  switch (status) {
    case 'stable':
      return t.healthStatusStable
    case 'needs-attention':
      return t.healthStatusNeedsAttention
    default:
      return t.healthStatusNoData
  }
}

type Tone = 'ok' | 'warn' | 'err' | 'muted'

const FIRST_RUN_CLASS: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
  muted: 'text-muted',
}

/**
 * What the generated graph did on its first replay, in the card's one line.
 *
 * The distinctions are the point: a pass that leaned on the last-resort
 * first-visible locator, or that only happened after an AI repair, is not the
 * same claim as "it ran". Reporting them alike would turn this line into a
 * number that flatters the generator.
 */
function firstRunLabel(
  record: ReplayFirstRunRecord,
  t: ReturnType<typeof useT>,
): { text: string; tone: Tone } {
  if (record.outcome === 'ok') {
    if (record.degradeRungs.some((rung) => rung >= 4)) {
      return { text: t.healthFirstRunGuessedLocator, tone: 'warn' }
    }
    if (record.degradedSteps > 0) {
      return {
        text: t.healthFirstRunFallbacks({ steps: record.degradedSteps }),
        tone: 'warn',
      }
    }
    return { text: t.healthFirstRunPassed, tone: 'ok' }
  }
  if (record.outcome === 'cancelled') {
    return { text: t.healthFirstRunCancelled, tone: 'muted' }
  }
  if (record.outcome === 'skipped') {
    return { text: t.healthFirstRunSkipped, tone: 'muted' }
  }
  if (record.autoRepaired) {
    return { text: t.healthFirstRunNeededRepair, tone: 'warn' }
  }
  return {
    text: record.failureCode
      ? t.healthFirstRunFailed({ code: record.failureCode })
      : t.healthFirstRunFailedPlain,
    tone: 'err',
  }
}

/** Compact, explainable health summary for one workflow card. */
export function WorkflowHealthView({ health, firstRun }: WorkflowHealthViewProps): ReactNode {
  const t = useT()
  const firstRunBadge = firstRun ? firstRunLabel(firstRun, t) : undefined
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

      {firstRunBadge && (
        <span className={FIRST_RUN_CLASS[firstRunBadge.tone]}>{firstRunBadge.text}</span>
      )}

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
