/**
 * Data-table panel — explains the run-scoped `dataTable` variable and shows
 * which blocks in THIS workflow write into it or read from it.
 *
 * There is no standalone table operator or schema editor: the table is created
 * at run time by operators that opt in. The panel is the missing entry point
 * that used to make the feature look unimplemented.
 *
 * @module workflow-editor/ui/DataTablePanel
 */
import { ArrowUpRight, Table2 } from 'lucide-react'
import { BLOCK_BY_ID, CATALOG_BY_ID } from '../../lib/workflow/blocks/palette'
import { BlockIcon } from '../../lib/workflow/blocks/icons'
import { useEditorLocale } from '../locale-context'
import type { DataTableUsage, DataTableUsageRow } from '../data-table-usage'
import Modal from './Modal'

function UsageRow({
  row,
  onFocusNode,
}: {
  row: DataTableUsageRow
  onFocusNode: (id: string) => void
}) {
  const { t, blockName } = useEditorLocale()
  const block = BLOCK_BY_ID.get(row.blockId) ?? CATALOG_BY_ID.get(row.blockId)
  return (
    <button
      type="button"
      className="group flex w-full items-center gap-2 rounded-lg border border-border bg-panel px-2.5 py-2 text-left hover:bg-hover"
      title={t('dataTableLocate')}
      onClick={() => onFocusNode(row.nodeId)}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
        <BlockIcon icon={block?.icon ?? 'lucide:Table'} size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-ink">
          {blockName(row.blockId, block?.name ?? row.blockId)}
        </span>
        {row.description && (
          <span className="block truncate text-[11px] text-muted">{row.description}</span>
        )}
      </span>
      {row.columns.length > 0 && (
        <span className="max-w-[45%] truncate font-mono text-[10.5px] text-faint">
          {row.columns.join(', ')}
        </span>
      )}
      <ArrowUpRight size={12} aria-hidden className="shrink-0 text-faint group-hover:text-muted" />
    </button>
  )
}

function Section({
  title,
  rows,
  empty,
  onFocusNode,
}: {
  title: string
  rows: DataTableUsageRow[]
  empty: string
  onFocusNode: (id: string) => void
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-faint">{empty}</p>
      ) : (
        rows.map((row) => <UsageRow key={row.nodeId} row={row} onFocusNode={onFocusNode} />)
      )}
    </section>
  )
}

export default function DataTablePanel({
  open,
  onClose,
  usage,
  onFocusNode,
}: {
  open: boolean
  onClose: () => void
  usage: DataTableUsage
  onFocusNode: (id: string) => void
}) {
  const { t } = useEditorLocale()
  const unused = usage.writers.length === 0 && usage.readers.length === 0
  return (
    <Modal open={open} onClose={onClose} title={t('dataTableTitle')} icon="lucide:Table" size="lg">
      <div className="flex flex-col gap-4 text-sm text-ink">
        <p className="text-[12.5px] leading-relaxed text-muted">{t('dataTableIntro')}</p>

        <div className="rounded-lg border border-border bg-panel px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
            <Table2 size={13} aria-hidden className="text-accent" />
            {t('dataTableHowTo')}
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12px] leading-relaxed text-muted">
            <li>{t('dataTableHowWrite')}</li>
            <li>{t('dataTableHowRead')}</li>
            <li>{t('dataTableHowInspect')}</li>
          </ul>
        </div>

        {unused ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-faint">
            {t('dataTableEmpty')}
          </p>
        ) : (
          <>
            <section className="flex flex-col gap-1.5">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                {t('dataTableColumns')}
              </h3>
              {usage.columns.length === 0 ? (
                <p className="text-xs text-faint">{t('dataTableNoColumns')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {usage.columns.map((column) => (
                    <span
                      key={column}
                      className="rounded-md border border-border bg-panel px-2 py-0.5 font-mono text-[11px] text-ink"
                    >
                      {column}
                    </span>
                  ))}
                </div>
              )}
            </section>

            <Section
              title={t('dataTableWriters')}
              rows={usage.writers}
              empty={t('dataTableNone')}
              onFocusNode={onFocusNode}
            />
            <Section
              title={t('dataTableReaders')}
              rows={usage.readers}
              empty={t('dataTableNone')}
              onFocusNode={onFocusNode}
            />
          </>
        )}
      </div>
    </Modal>
  )
}
