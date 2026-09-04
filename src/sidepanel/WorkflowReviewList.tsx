/**
 * Shared AI node-review rendering for both workflow save entries.
 *
 * `WorkflowReviewList` is the pure display half: the AI summary plus the
 * per-step checklist (checkbox = keep, satellite mechanism nodes rendered as
 * inline grey text, drop reasons under AI-dropped rows). `WorkflowReviewDialog`
 * wraps it in a ConfirmDialog-styled modal for the history-tab entry.
 *
 * The parent owns all state (review / keep selections) and re-derives the
 * preview workflow from its untouched base — this component never edits a
 * workflow itself.
 *
 * @module sidepanel/WorkflowReviewList
 */
import type { ReactElement } from 'react'
import { useI18n } from './i18n'
import { blockDisplayName } from '../workflow-editor/block-i18n'
import type { ReviewStep, WorkflowReview } from '../lib/workflow/review-patch'

export interface WorkflowReviewListProps {
  /** All reviewable steps of the generated workflow (chain order). */
  steps: ReviewStep[]
  /** AI verdicts; `null` while unavailable (no provider / failure). */
  review: WorkflowReview | null
  /** True while the review call is in flight. */
  reviewing: boolean
  /** stepId → keep; absent = keep (also the state before the review lands). */
  keep: Record<string, boolean> | null
  onToggle: (stepId: string, keep: boolean) => void
}

/** Localized display name of a block id (Chinese map, raw id fallback). */
function useBlockName(): (blockId: string) => string {
  const { locale } = useI18n()
  // The editor's map keys on 'en' | 'zh'; the panel locale is 'en' | 'zh-CN'.
  const editorLocale = locale === 'en' ? 'en' : 'zh'
  return (blockId: string) => blockDisplayName(blockId, blockId, editorLocale)
}

export function WorkflowReviewList({
  steps,
  review,
  reviewing,
  keep,
  onToggle,
}: WorkflowReviewListProps): ReactElement {
  const { t } = useI18n()
  const blockName = useBlockName()

  if (!review) {
    return (
      <p className="m-0 mt-1.5 text-[12.5px] leading-relaxed text-muted">
        {reviewing ? t.chatWorkflowReviewing : t.chatWorkflowReviewUnavailable}
      </p>
    )
  }

  const droppedByAi = review.steps.filter((verdict) => !verdict.keep).length
  const reasonOf = new Map(review.steps.map((verdict) => [verdict.id, verdict.reason]))

  return (
    <div className="mt-1.5">
      {review.summary && (
        <p className="m-0 text-[12.5px] leading-relaxed text-ink break-words">{review.summary}</p>
      )}
      <p className="m-0 mt-1 text-[12px] leading-relaxed text-muted">
        {droppedByAi > 0
          ? t.chatWorkflowReviewDropped({ count: droppedByAi })
          : t.chatWorkflowReviewAllKept}
      </p>
      <p className="m-0 mt-2 mb-1 text-[12px] font-medium text-muted">{t.chatWorkflowStepsTitle}</p>
      <div className="flex max-h-[38vh] flex-col gap-0.5 overflow-y-auto pr-1">
        {steps.map((step) => {
          const kept = keep?.[step.id] !== false
          const reason = reasonOf.get(step.id)
          return (
            <label
              key={step.id}
              className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-hover"
            >
              <input
                checked={kept}
                className="mt-0.5"
                onChange={(event) => onToggle(step.id, event.target.checked)}
                type="checkbox"
              />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-[12.5px] leading-snug text-ink">
                  {blockName(step.blockId)}
                  {step.description ? ` · ${step.description}` : ''}
                </span>
                {step.satelliteSummary.length > 0 && (
                  <span className="block break-words text-[11.5px] leading-snug text-muted">
                    {step.satelliteSummary.map((summary) => `· ${summary}`).join('  ')}
                  </span>
                )}
                {!kept && reason && (
                  <span className="block break-words text-[11.5px] leading-snug text-err">
                    {reason}
                  </span>
                )}
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

export interface WorkflowReviewDialogProps extends WorkflowReviewListProps {
  title: string
  /** Extra header line, e.g. the workflow name. */
  subtitle?: string
  onConfirm: () => void
  onCancel: () => void
}

/** Modal twin of the save card, for the history-tab save entry. */
export function WorkflowReviewDialog({
  title,
  subtitle,
  onConfirm,
  onCancel,
  ...list
}: WorkflowReviewDialogProps): ReactElement {
  const { t } = useI18n()
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center p-4 pt-[9vh]"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-slate-950/55 backdrop-blur-[2px] animate-[dialog-fade_140ms_ease-out]"
        onClick={onCancel}
      />
      <div
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-[360px] rounded-xl border border-border bg-panel shadow-[var(--bc-shadow)] p-4 animate-[dialog-slide-down_180ms_ease-out]"
        role="dialog"
      >
        <h2 className="m-0 text-[14px] font-semibold leading-snug text-ink">{title}</h2>
        {subtitle && (
          <p className="m-0 mt-1 text-[12px] leading-relaxed text-muted break-words">{subtitle}</p>
        )}
        <WorkflowReviewList {...list} />
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="h-8 cursor-pointer rounded-lg border border-border bg-panel-2 px-3.5 text-[13px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-ink"
            onClick={onCancel}
            type="button"
          >
            {t.workflowReviewDialogCancel}
          </button>
          <button
            className="h-8 cursor-pointer rounded-lg border border-accent bg-accent px-3.5 text-[13px] font-semibold text-on-accent transition-colors duration-150 hover:bg-accent-strong"
            onClick={onConfirm}
            type="button"
          >
            {t.workflowReviewDialogConfirm}
          </button>
        </div>
      </div>
    </div>
  )
}
