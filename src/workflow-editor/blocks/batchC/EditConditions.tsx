/**
 * EditConditions — React port of Automa's EditConditions.vue.
 *
 * The conditions block has a list of named output "paths"; each path has its
 * own condition tree (OR groups of AND rows) and the canvas draws one output
 * handle per path plus the "no path matched" port. This form lists the paths
 * (rename / reorder / delete) and opens a per-path ConditionBuilder in a modal,
 * so a path's conditions get the full canvas rather than a cramped inline
 * strip inside the narrow edit sidebar.
 *
 * @module workflow-editor/blocks/batchC/EditConditions
 */

import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, Waypoints } from 'lucide-react'
import { useState } from 'react'
import type { EditFormProps } from '../EditForms'
import { useEditorLocale } from '../../locale-context'
import Modal from '../../ui/Modal'
import { Checkbox, Expand, Field, NumberInput, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'
import ConditionBuilder, { readGroups } from './ConditionBuilder'
import { id } from './shared'
import { conditionPathsOf, type ConditionPath } from '../../../lib/workflow/condition-tree'
import { confirmDialog } from '../../../ui/confirm'

/** A path with at least one OR group is configured; the rest are placeholders. */
function groupCount(path: ConditionPath): number {
  return path.conditions.length
}

export default function EditConditions({ data, onChange }: EditFormProps) {
  const { bt, t } = useEditorLocale()
  const paths = conditionPathsOf(data.paths)
  const [editing, setEditing] = useState<number | null>(null)

  const commit = (next: ConditionPath[]) => onChange({ paths: next })

  const addPath = () => {
    if (paths.length >= 20) return
    commit([...paths, { id: id(8), name: `Path ${paths.length + 1}`, conditions: [] }])
  }
  const removePath = async (index: number) => {
    const path = paths[index]!
    const ok = await confirmDialog({
      title: t('conditionPathDeleteTitle'),
      message: t('conditionPathDeleteMessage').replace('{name}', path.name || 'Path'),
      confirmText: t('delete'),
      cancelText: t('cancel'),
      danger: true,
    })
    if (!ok) return
    commit(paths.filter((_, i) => i !== index))
    setEditing((current) => (current === index ? null : current))
  }
  const renamePath = (index: number, name: string) => {
    commit(paths.map((path, i) => (i === index ? { ...path, name } : path)))
  }
  const setPathConditions = (index: number, conditions: ConditionPath['conditions']) => {
    commit(paths.map((path, i) => (i === index ? { ...path, conditions } : path)))
  }
  const movePath = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= paths.length) return
    const next = paths.slice()
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved!)
    commit(next)
    setEditing((current) => (current === index ? target : current === target ? index : current))
  }

  const editingPath = editing === null ? null : (paths[editing] ?? null)

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <div className="mt-3 rounded-lg border border-border bg-panel-2 p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-ink">{t('conditionPathsTitle')}</p>
          <button
            type="button"
            className="wf-btn-accent"
            disabled={paths.length >= 20}
            onClick={addPath}
          >
            <Plus size={14} /> {t('conditionPathAdd')}
          </button>
        </div>
        <p className="mb-2 text-[11px] leading-snug text-muted">{t('conditionPathsHint')}</p>

        {paths.length === 0 && (
          <p className="rounded-md border border-dashed border-border px-2 py-3 text-center text-[11px] text-muted">
            {t('conditionPathEmpty')}
          </p>
        )}

        <ul className="flex flex-col gap-1.5">
          {paths.map((path, index) => {
            const groups = groupCount(path)
            return (
              <li
                key={path.id}
                className="flex items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-1.5"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-medium text-accent">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <TextInput
                    value={path.name}
                    placeholder={`Path ${index + 1}`}
                    onChange={(v) => renamePath(index, v)}
                  />
                  <p className="mt-0.5 truncate px-0.5 text-[10px] leading-tight text-muted">
                    {groups > 0
                      ? t('conditionPathGroups').replace('{count}', String(groups))
                      : t('conditionPathNotConfigured')}
                  </p>
                </div>
                <button
                  type="button"
                  className="wf-icon-btn"
                  title={t('conditionPathMoveUp')}
                  disabled={index === 0}
                  onClick={() => movePath(index, -1)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className="wf-icon-btn"
                  title={t('conditionPathMoveDown')}
                  disabled={index === paths.length - 1}
                  onClick={() => movePath(index, 1)}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  type="button"
                  className="wf-icon-btn"
                  title={t('conditionPathEdit')}
                  onClick={() => setEditing(index)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="wf-icon-btn text-err"
                  title={t('conditionPathDelete')}
                  onClick={() => void removePath(index)}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            )
          })}
        </ul>

        {/* The port every "no path matched" run lands on. Shown so the list
            above reads as the full set of outputs, not a partial one. */}
        <p className="mt-2 flex items-center gap-1.5 rounded-md bg-panel px-2 py-1.5 text-[11px] text-muted">
          <Waypoints size={12} className="text-muted" />
          <span className="font-medium text-ink">{t('conditionPathFallbackLabel')}</span>
          {t('conditionPathFallbackHint')}
        </p>
      </div>

      <Modal
        open={editingPath !== null}
        onClose={() => setEditing(null)}
        title={t('conditionConditionsTitle').replace('{name}', editingPath?.name || 'Path')}
        icon="workflow"
        size="lg"
      >
        {editingPath && editing !== null && (
          <ConditionBuilder
            value={readGroups(editingPath.conditions)}
            onChange={(groups) => setPathConditions(editing, groups as ConditionPath['conditions'])}
          />
        )}
      </Modal>

      <Expand title="Settings" defaultOpen={false}>
        <Checkbox
          checked={bool(data, 'retryConditions')}
          onChange={(v) => onChange({ retryConditions: v })}
          label={bt('Retry if no conditions are met')}
        />
        {bool(data, 'retryConditions') && (
          <>
            <Field label="Times">
              <NumberInput
                value={num(data, 'retryCount', 10)}
                min={0}
                fallback={10}
                onChange={(n) => onChange({ retryCount: n })}
              />
            </Field>
            <Field label="Timeout (ms)">
              <NumberInput
                value={num(data, 'retryTimeout', 1000)}
                min={0}
                fallback={1000}
                onChange={(n) => onChange({ retryTimeout: n })}
              />
            </Field>
          </>
        )}
      </Expand>
    </div>
  )
}
