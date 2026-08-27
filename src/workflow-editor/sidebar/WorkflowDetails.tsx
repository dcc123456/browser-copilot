/**
 * Workflow details card — React port of Automa's WorkflowDetailsCard + the
 * trigger/settings sections shown when no node is selected.
 *
 * @module workflow-editor/sidebar/WorkflowDetails
 */

import { BlockIcon } from '../../lib/workflow/blocks/icons'
import type { WorkflowSettings, WorkflowTrigger } from '../../lib/workflow/types'

export interface WorkflowMeta {
  name: string
  description: string
  icon: string
  trigger: WorkflowTrigger
  settings: WorkflowSettings
}

const TRIGGERS: { id: WorkflowTrigger['type']; label: string; icon: string }[] = [
  { id: 'manual', label: 'Manual', icon: 'ri-hand-click-line' },
  { id: 'scheduled', label: 'Interval / Cron', icon: 'ri-time-line' },
  { id: 'context-menu', label: 'Context menu', icon: 'ri-menu-line' },
  { id: 'visit-web', label: 'Visit web', icon: 'ri-global-line' },
]

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
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
}: {
  meta: WorkflowMeta
  onChange: (patch: Partial<WorkflowMeta>) => void
}) {
  const setSettings = (patch: Partial<WorkflowSettings>) =>
    onChange({ settings: { ...meta.settings, ...patch } })
  const setTrigger = (patch: Partial<WorkflowTrigger>) =>
    onChange({ trigger: { ...meta.trigger, ...patch } })

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
            placeholder="Workflow name"
          />
          <p className="wf-details-sub">Workflow</p>
        </div>
      </div>

      <Row label="Description">
        <textarea
          value={meta.description}
          rows={2}
          placeholder="What does this workflow do?"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Row>

      <div className="wf-section-title">Trigger</div>
      <Row label="Trigger type">
        <select
          value={meta.trigger.type}
          onChange={(e) => setTrigger({ type: e.target.value as WorkflowTrigger['type'] })}
        >
          {TRIGGERS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
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
        <span>Trigger enabled</span>
      </label>
      {meta.trigger.type === 'scheduled' && (
        <Row label="Cron / interval">
          <input
            value={meta.trigger.schedule ?? ''}
            placeholder="0 8 * * * (daily at 8:00)"
            onChange={(e) => setTrigger({ schedule: e.target.value })}
          />
        </Row>
      )}
      {meta.trigger.type === 'visit-web' && (
        <Row label="URL match">
          <input
            value={meta.trigger.urlPattern ?? ''}
            placeholder="https://example.com/*"
            onChange={(e) => setTrigger({ urlPattern: e.target.value })}
          />
        </Row>
      )}
      {meta.trigger.type === 'context-menu' && (
        <Row label="Menu title">
          <input
            value={meta.trigger.menuItemId ?? ''}
            placeholder="Run my workflow"
            onChange={(e) => setTrigger({ menuItemId: e.target.value })}
          />
        </Row>
      )}

      <div className="wf-section-title">Settings</div>
      <label className="wf-field wf-field-check">
        <input
          type="checkbox"
          checked={meta.settings.debugMode}
          onChange={(e) => setSettings({ debugMode: e.target.checked })}
        />
        <span>Debug mode</span>
      </label>
      <label className="wf-field wf-field-check">
        <input
          type="checkbox"
          checked={meta.settings.saveLog}
          onChange={(e) => setSettings({ saveLog: e.target.checked })}
        />
        <span>Save execution logs</span>
      </label>
      <label className="wf-field wf-field-check">
        <input
          type="checkbox"
          checked={meta.settings.notification}
          onChange={(e) => setSettings({ notification: e.target.checked })}
        />
        <span>Notify when finished</span>
      </label>
    </div>
  )
}
