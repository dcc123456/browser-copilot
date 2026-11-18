/**
 * Read-only full-change view for one operator AI answer. Each changed parameter
 * gets its own git-style block: `--- before` / `+++ after`, then context and
 * added/removed lines with old/new line numbers. Values are the real captured
 * before/after (secret keys already arrive masked), so no truncation here.
 *
 * @module workflow-editor/ai/ChangeDiffModal
 */

import type { OperatorParamChange } from '../../lib/workflow/operator-advise'
import { diffTextLines, type DiffLine } from '../../lib/text-diff'
import type { TranslateFn } from '../i18n'
import Modal from '../ui/Modal'

/** Strings stay raw so multi-line code keeps its indentation; other values are
 *  pretty-printed so an object or array is diffable line by line too. */
export function changeValueText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value, null, 2) ?? String(value)
}

function DiffRows({ rows }: { rows: readonly DiffLine[] }) {
  return (
    <div className="overflow-x-auto bg-panel px-2 py-1 font-mono text-[11px] leading-[1.45]">
      {rows.map((row, index) => (
        <div
          className={`flex whitespace-pre ${
            row.kind === 'removed'
              ? 'bg-err-surface text-err'
              : row.kind === 'added'
                ? 'bg-ok-surface text-ok'
                : 'text-muted'
          }`}
          key={index}
        >
          <span className="w-9 shrink-0 select-none text-right text-faint">
            {row.oldNumber ?? ''}
          </span>
          <span className="w-9 shrink-0 select-none text-right text-faint">
            {row.newNumber ?? ''}
          </span>
          <span className="w-4 shrink-0 select-none">
            {row.kind === 'removed' ? '-' : row.kind === 'added' ? '+' : ' '}
          </span>
          <span className="min-w-0">{row.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}

export function ChangeDiffBody({
  changes,
  t,
}: {
  changes: readonly OperatorParamChange[]
  t: TranslateFn
}) {
  if (changes.length === 0)
    return <p className="text-[11px] leading-snug text-muted">{t('operatorAiChangesEmpty')}</p>

  return (
    <div className="space-y-3">
      {changes.map((change, index) => {
        const rows = diffTextLines(changeValueText(change.before), changeValueText(change.after))
        return (
          <section
            className="overflow-hidden rounded-lg border border-border"
            key={`${change.key}-${index}`}
          >
            <header className="bg-panel-2 px-2 py-1">
              <span className="font-mono text-[11px] text-ink">{change.key}</span>
            </header>
            <div className="flex gap-4 border-y border-border px-2 py-1 text-[10px] text-faint">
              <span>--- {t('operatorAiChangeBefore')}</span>
              <span>+++ {t('operatorAiChangeAfter')}</span>
            </div>
            <DiffRows rows={rows} />
          </section>
        )
      })}
    </div>
  )
}

export default function ChangeDiffModal({
  open,
  onClose,
  changes,
  t,
}: {
  open: boolean
  onClose: () => void
  changes: readonly OperatorParamChange[] | null
  t: TranslateFn
}) {
  return (
    <Modal open={open} onClose={onClose} size="xl" title={t('operatorAiChangesTitle')}>
      {changes && <ChangeDiffBody changes={changes} t={t} />}
    </Modal>
  )
}
