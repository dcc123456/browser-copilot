/**
 * Block edit form shell — React port of Automa's WorkflowEditBlock.
 *
 * Sticky header with a back button (returns to workflow details), the block's
 * English name, and a docs link. The body renders the block's dedicated edit
 * component (registered in blocks/EditForms — P4). Blocks that do not have a
 * dedicated form yet fall back to a generic key/value editor so the node is
 * still editable; cloud blocks that somehow exist in old data show an
 * unsupported notice.
 *
 * @module workflow-editor/sidebar/BlockEditForm
 */

import { useState } from 'react'
import { ArrowLeft, Cloud, Info, RotateCcw, Wand2 } from 'lucide-react'
import { isCloudBlock } from '../../lib/workflow/blocks/cloud-blocks'
import { isCustomBlock } from '../../lib/workflow/blocks/custom'
import type { BlockCatalogEntry } from '../../lib/workflow/blocks/types'
import NumberInput from '../../ui/NumberInput'
import { EditForms } from '../blocks/EditForms'
import NodeGoalInspector from './NodeGoalInspector'
import NodeFixModal from './NodeFixModal'
import type { TranslateFn } from '../i18n'
import { useEditorLocale } from '../locale-context'

export interface BlockEditFormProps {
  block: BlockCatalogEntry
  nodeName: string
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  onBack: () => void
  t: TranslateFn
  /** Apply verified AI-fix parameters (whole replacement). */
  onApplyFix: (next: Record<string, unknown>) => void
  /** Editor host window the fix trial run / verification are scoped to. */
  windowId?: number
  /** Whether a pre-fix snapshot exists to restore. */
  canRevert: boolean
  /** Restore the node data captured before the last AI fix. */
  onRevert: () => void
}

function GenericForm({
  data,
  onChange,
}: {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const { bt } = useEditorLocale()
  const keys = Object.keys(data).filter((k) => k !== 'disableBlock')
  return (
    <div className="wf-form">
      <p className="wf-form-note">
        {bt('Dedicated form coming in a later phase — generic editor:')}
      </p>
      {keys.map((key) => {
        const value = data[key]
        if (typeof value === 'boolean') {
          return (
            <label key={key} className="wf-field wf-field-check">
              <input
                type="checkbox"
                checked={value}
                onChange={(e) => onChange({ [key]: e.target.checked })}
              />
              <code>{key}</code>
            </label>
          )
        }
        if (typeof value === 'number') {
          return (
            <div key={key} className="wf-field">
              <label>
                <code>{key}</code>
              </label>
              {/* No known default here: clearing restores the previous number on blur. */}
              <NumberInput value={value} onChange={(n) => onChange({ [key]: n })} />
            </div>
          )
        }
        const str = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)
        const long = str.length > 40 || str.includes('\n')
        return (
          <div key={key} className="wf-field">
            <label>
              <code>{key}</code>
            </label>
            {long ? (
              <textarea
                rows={Math.min(8, str.split('\n').length + 1)}
                value={str}
                onChange={(e) => onChange({ [key]: e.target.value })}
              />
            ) : (
              <input
                type="text"
                value={str}
                onChange={(e) => onChange({ [key]: e.target.value })}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function BlockEditForm({
  block,
  nodeName,
  data,
  onChange,
  onBack,
  t,
  onApplyFix,
  windowId,
  canRevert,
  onRevert,
}: BlockEditFormProps) {
  const { blockName, bt } = useEditorLocale()
  const EditComponent = block.editComponent ? EditForms[block.editComponent] : undefined
  const cloud = isCloudBlock(block.id)
  const [fixOpen, setFixOpen] = useState(false)

  return (
    <div className="wf-edit-block">
      <div className="wf-edit-header">
        <button type="button" onClick={onBack} title={t('back')} className="wf-icon-btn">
          <ArrowLeft size={14} />
        </button>
        <p className="wf-edit-title">{nodeName || blockName(block.id, block.name)}</p>
        <span className="wf-edit-spacer" />
        {!cloud && (
          <button
            type="button"
            onClick={() => setFixOpen(true)}
            title={bt('AI Fix')}
            className="wf-icon-btn text-accent"
          >
            <Wand2 size={14} />
          </button>
        )}
        {!isCustomBlock(block.id) && (
          <a
            href={`https://docs.extension.automa.site/blocks/${block.id}.html`}
            target="_blank"
            rel="noreferrer"
            title={bt('Docs')}
            className="wf-icon-btn"
          >
            <Info size={14} />
          </a>
        )}
      </div>

      <div className="wf-edit-body">
        {/* The goal contract (goal, success criteria, failure meaning, repair
            hints) is AI-internal bookkeeping. For upload-file the user only
            picks a selector and a file source, so hide it entirely. */}
        {block.id !== 'upload-file' && <NodeGoalInspector data={data} onChange={onChange} t={t} />}
        {cloud ? (
          <div className="wf-form wf-form-unsupported">
            <Cloud size={14} />
            <p>{bt("This block requires Automa's cloud service and is not supported.")}</p>
          </div>
        ) : block.disableEdit ? (
          <p className="wf-form-note">{bt('This block has no editable settings.')}</p>
        ) : EditComponent ? (
          <EditComponent data={data} onChange={onChange} blockId={block.id} />
        ) : (
          <GenericForm data={data} onChange={onChange} />
        )}

        {canRevert && (
          <button
            type="button"
            onClick={onRevert}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-panel text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <RotateCcw size={13} />
            {t('nodeFixRevert')}
          </button>
        )}
      </div>

      <NodeFixModal
        open={fixOpen}
        onClose={() => setFixOpen(false)}
        blockId={block.id}
        data={data}
        onApply={onApplyFix}
        windowId={windowId}
        t={t}
      />
    </div>
  )
}
