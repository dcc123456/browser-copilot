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

import { ArrowLeft, Cloud, Info } from 'lucide-react'
import { isCloudBlock } from '../../lib/workflow/blocks/cloud-blocks'
import type { BlockCatalogEntry } from '../../lib/workflow/blocks/types'
import { operatorDocsUrl } from '../../lib/workflow/docs-links'
import { operatorCarriesGoal } from '../../lib/workflow/operator-registry'
import NumberInput from '../../ui/NumberInput'
import { EditForms } from '../blocks/EditForms'
import { Expand, Switch, TextArea, TextInput } from '../blocks/shared/Field'
import NodeGoalInspector from './NodeGoalInspector'
import type { TranslateFn } from '../i18n'
import { useEditorLocale } from '../locale-context'

export interface BlockEditFormProps {
  block: BlockCatalogEntry
  nodeName: string
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  onBack: () => void
  t: TranslateFn
  /**
   * Hide the goal/success-criteria section. A child of a group is not a graph
   * node: the engine never reads a contract for it, so offering one would
   * promise a verification that cannot happen.
   */
  hideGoal?: boolean
}

/**
 * Keys that DEFINE a name (a variable, a table column) instead of holding a
 * value: a `{{reference}}` there would become the name itself. The generic form
 * has no per-field knowledge, so the opt-out is by key.
 */
const isNameDefiningKey = (key: string): boolean =>
  /^(variableName|dataColumn|columnName|name|attributeName|key)$/.test(key)

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
            <Switch
              key={key}
              checked={value}
              label={<code>{key}</code>}
              onChange={(next) => onChange({ [key]: next })}
            />
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
              <TextArea
                rows={Math.min(8, str.split('\n').length + 1)}
                value={str}
                onChange={(v) => onChange({ [key]: v })}
                noSlash={isNameDefiningKey(key)}
              />
            ) : (
              <TextInput
                value={str}
                onChange={(v) => onChange({ [key]: v })}
                noSlash={isNameDefiningKey(key)}
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
  hideGoal = false,
}: BlockEditFormProps) {
  const { blockName, bt, locale } = useEditorLocale()
  const EditComponent = block.editComponent ? EditForms[block.editComponent] : undefined
  const cloud = isCloudBlock(block.id)
  const docsHref = operatorDocsUrl(block.id, locale)
  // Fire-and-done operators have nothing to verify, so they get no goal section
  // (no contract, no user words, no error log to work towards).
  const goalBearing = !hideGoal && operatorCarriesGoal(block.id)

  return (
    <div className="wf-edit-block">
      <div className="wf-edit-header">
        <button type="button" onClick={onBack} title={t('back')} className="wf-icon-btn">
          <ArrowLeft size={14} />
        </button>
        <p className="wf-edit-title">{nodeName || blockName(block.id, block.name)}</p>
        <span className="wf-edit-spacer" />
        {docsHref && (
          <a
            href={docsHref}
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

        {/* Goal + success criteria sit BELOW the block's own fields (and the
            description), collapsed by default; the user expands to edit. For
            upload-file the user only picks a selector and a file source. */}
        {block.id !== 'upload-file' && goalBearing && (
          <Expand
            title={t('nodeGoalSection')}
            defaultOpen={false}
            helpLabel={t('goalHelpTrigger')}
            help={
              <div className="flex flex-col gap-1.5">
                <p>{t('goalHelpIntro')}</p>
                <p>{t('goalHelpGoal')}</p>
                <p>{t('goalHelpCriteria')}</p>
                <p>{t('goalHelpPreconditions')}</p>
                <p className="text-faint">{t('goalHelpEmpty')}</p>
              </div>
            }
          >
            <NodeGoalInspector data={data} onChange={onChange} t={t} />
          </Expand>
        )}
      </div>
    </div>
  )
}
