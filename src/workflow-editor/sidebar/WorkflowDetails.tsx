/**
 * Workflow details card — workflow name/description, trigger and settings shown
 * in the right sidebar when no node is selected.
 *
 * @module workflow-editor/sidebar/WorkflowDetails
 */

import { BlockIcon } from '../../lib/workflow/blocks/icons'
import type { WorkflowSettings, WorkflowTrigger } from '../../lib/workflow/types'
import type { TranslateFn } from '../i18n'

export interface WorkflowMeta {
  name: string
  description: string
  icon: string
  trigger: WorkflowTrigger
  settings: WorkflowSettings
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="wf-field">
      <label>{label}</label>
      {children}
    </div>
  )
}

export default function WorkflowDetails({
  meta,
  onChange,
  t,
}: {
  meta: WorkflowMeta
  onChange: (patch: Partial<WorkflowMeta>) => void
  t: TranslateFn
}) {
  const setSettings = (patch: Partial<WorkflowSettings>) =>
    onChange({ settings: { ...meta.settings, ...patch } })
  const setTrigger = (patch: Partial<WorkflowTrigger>) =>
    onChange({ trigger: { ...meta.trigger, ...patch } })

  const triggers = [
    { id: 'manual', label: t('manual') },
    { id: 'scheduled', label: t('scheduled') },
    { id: 'context-menu', label: t('contextMenu') },
    { id: 'visit-web', label: t('visitWeb') },
  ]

  return (
    <div className="wf-sidebar-scroll">
      <div className="wf-details-head">
        <span className="wf-details-icon">
          <BlockIcon icon={meta.icon || 'ri-flow-chart'} size={26} />
        </span>
        <div className="wf-details-headtext">
          <input
            className="wf-details-name"
            value={meta.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder={t('untitled')}
          />
          <p className="wf-details-sub">{t('details')}</p>
        </div>
      </div>

      <Row label={t('description')}>
        <textarea
          value={meta.description}
          rows={2}
          placeholder={t('descriptionPlaceholder')}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Row>

      <div className="wf-section-title">{t('trigger')}</div>
      <Row label={t('triggerType')}>
        <select
          value={meta.trigger.type}
          onChange={(e) => setTrigger({ type: e.target.value as WorkflowTrigger['type'] })}
        >
          {triggers.map((tr) => (
            <option key={tr.id} value={tr.id}>
              {tr.label}
            </option>
          ))}
        </select>
      </Row>
      <label className="wf-field wf-field-check">
        <input
          type="checkbox"
          checked={meta.trigger.enabled ?? true}
          onChange={(e) => setTrigger({ enabled: e.target.checked })}
        />
        <span>{t('triggerEnabled')}</span>
      </label>
      {meta.trigger.type === 'scheduled' && (
        <Row label={t('scheduled')}>
          <input
            value={meta.trigger.schedule ?? ''}
            placeholder={t('cronHint')}
            onChange={(e) => setTrigger({ schedule: e.target.value })}
          />
        </Row>
      )}
      {meta.trigger.type === 'visit-web' && (
        <Row label="URL">
          <input
            value={meta.trigger.urlPattern ?? ''}
            placeholder={t('urlHint')}
            onChange={(e) => setTrigger({ urlPattern: e.target.value })}
          />
        </Row>
      )}
      {meta.trigger.type === 'context-menu' && (
        <Row label={t('menuTitle')}>
          <input
            value={meta.trigger.menuItemId ?? ''}
            placeholder="Run my workflow"
            onChange={(e) => setTrigger({ menuItemId: e.target.value })}
          />
        </Row>
      )}

      <div className="wf-section-title">{t('settings')}</div>
      <label className="wf-field wf-field-check">
        <input
          type="checkbox"
          checked={meta.settings.debugMode}
          onChange={(e) => setSettings({ debugMode: e.target.checked })}
        />
        <span>{t('debugMode')}</span>
      </label>
      <label className="wf-field wf-field-check">
        <input
          type="checkbox"
          checked={meta.settings.saveLog}
          onChange={(e) => setSettings({ saveLog: e.target.checked })}
        />
        <span>{t('saveLog')}</span>
      </label>
      <label className="wf-field wf-field-check">
        <input
          type="checkbox"
          checked={meta.settings.notification}
          onChange={(e) => setSettings({ notification: e.target.checked })}
        />
        <span>{t('notifyOnFinish')}</span>
      </label>
    </div>
  )
}
