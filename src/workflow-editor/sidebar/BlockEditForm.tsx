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

import { isCloudBlock } from '../../lib/workflow/blocks/cloud-blocks'
import { isCustomBlock } from '../../lib/workflow/blocks/custom'
import type { BlockCatalogEntry } from '../../lib/workflow/blocks/types'
import { EditForms } from '../blocks/EditForms'
import type { TranslateFn } from '../i18n'
import { useEditorLocale } from '../locale-context'

export interface BlockEditFormProps {
  block: BlockCatalogEntry
  nodeName: string
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  onBack: () => void
  t: TranslateFn
}

function GenericForm({
  data,
  onChange,
}: {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const keys = Object.keys(data).filter((k) => k !== 'disableBlock')
  return (
    <div className="wf-form">
      <p className="wf-form-note">Dedicated form coming in a later phase — generic editor:</p>
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
              <input
                type="number"
                value={value}
                onChange={(e) => onChange({ [key]: Number(e.target.value) })}
              />
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
              <input type="text" value={str} onChange={(e) => onChange({ [key]: e.target.value })} />
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
}: BlockEditFormProps) {
  const { blockName } = useEditorLocale()
  const EditComponent = block.editComponent ? EditForms[block.editComponent] : undefined
  const cloud = isCloudBlock(block.id)

  return (
    <div className="wf-edit-block">
      <div className="wf-edit-header">
        <button type="button" onClick={onBack} title={t('back')} className="wf-icon-btn">
          <i className="ri-arrow-left-line" />
        </button>
        <p className="wf-edit-title">{nodeName || blockName(block.id, block.name)}</p>
        <span className="wf-edit-spacer" />
        {!isCustomBlock(block.id) && (
          <a
            href={`https://docs.extension.automa.site/blocks/${block.id}.html`}
            target="_blank"
            rel="noreferrer"
            title="Docs"
            className="wf-icon-btn"
          >
            <i className="ri-information-line" />
          </a>
        )}
      </div>

      {cloud ? (
        <div className="wf-form wf-form-unsupported">
          <i className="ri-cloud-line" />
          <p>This block requires Automa's cloud service and is not supported.</p>
        </div>
      ) : block.disableEdit ? (
        <p className="wf-form-note">This block has no editable settings.</p>
      ) : EditComponent ? (
        <EditComponent data={data} onChange={onChange} blockId={block.id} />
      ) : (
        <GenericForm data={data} onChange={onChange} />
      )}
    </div>
  )
}
