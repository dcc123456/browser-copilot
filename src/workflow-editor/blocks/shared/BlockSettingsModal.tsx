/**
 * Block settings modal — opened from a node's hover-toolbar gear button.
 *
 * React port of Automa's EditBlockSettings: a dialog over the canvas with
 * TABS — General / On error — instead of stacked sections. The block's
 * dedicated edit form stays in the edit sidebar; this modal is the settings
 * surface Automa exposes from the node toolbar.
 *
 * @module workflow-editor/blocks/shared/BlockSettingsModal
 */

import { useState } from 'react'
import Modal from '../../ui/Modal'
import type { BlockCatalogEntry } from '../../../lib/workflow/blocks/types'
import { useEditorLocale } from '../../locale-context'
import { GeneralFields, OnErrorFields } from './BlockSettingsFields'
import type { EditFormProps } from '../EditForms'

type SettingsTab = 'general' | 'on-error'

export default function BlockSettingsModal({
  open,
  onClose,
  block,
  data,
  onChange,
}: {
  open: boolean
  onClose: () => void
  block: BlockCatalogEntry | null
  data: Record<string, unknown>
  onChange: EditFormProps['onChange']
}) {
  const { blockName, t } = useEditorLocale()
  // Resets to "General" whenever the modal closes (children unmount), the
  // same default Automa uses for its settings dialog.
  const [tab, setTab] = useState<SettingsTab>('general')
  if (!block) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={block.icon}
      accent={`var(--cat-${block.category})`}
      title={
        <>
          {blockName(block.id, block.name)} <span className="wf-modal-title-sub">· settings</span>
        </>
      }
      size="md"
    >
      {/* Automa ui-tabs: underline tabs, accent border on the active one. */}
      <div className="wf-settings-tabs">
        <button
          type="button"
          className={`wf-settings-tab${tab === 'general' ? ' wf-settings-tab-active' : ''}`}
          onClick={() => setTab('general')}
        >
          {t('settingsGeneral')}
        </button>
        <button
          type="button"
          className={`wf-settings-tab${tab === 'on-error' ? ' wf-settings-tab-active' : ''}`}
          onClick={() => setTab('on-error')}
        >
          {t('settingsOnError')}
        </button>
      </div>
      <div className="wf-settings-panel">
        {tab === 'general' ? (
          <GeneralFields data={data} onChange={onChange} blockId={block.id} />
        ) : (
          <OnErrorFields data={data} onChange={onChange} blockId={block.id} />
        )}
      </div>
    </Modal>
  )
}
