/**
 * Workflow groups: a user-facing folder for saved workflows.
 *
 * A group's membership lives on the workflow record itself (`folderId`), not
 * in a second list kept next to the groups: two copies of "who is in this
 * group" would need a tie-break rule for every write, and the workflow record
 * already carries the field. The group table therefore holds group metadata
 * only, and a workflow pointing at an unknown group simply reads as ungrouped.
 *
 * @module lib/workflow/groups
 */

import { newId } from '../storage'
import { fileStorageArea } from '../fs-store'
import { withKeyLock } from '../key-lock'
import type { Workflow } from './types'

/** A named collection of workflows. */
export interface WorkflowGroup {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

/** Storage key holding the group table (a file-backed content key). */
export const KEY_WORKFLOW_GROUPS = 'workflowGroups'

const area = fileStorageArea()

/**
 * Normalizes a stored group value, or returns `null` when the record is
 * unusable. Groups are user data that may have been written by an older build
 * or a half-written file, so every field is checked rather than trusted.
 */
export function asWorkflowGroup(value: unknown): WorkflowGroup | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<WorkflowGroup>
  if (typeof v.id !== 'string' || !v.id) return null
  if (typeof v.name !== 'string') return null
  const now = Date.now()
  return {
    id: v.id,
    name: v.name.trim() || 'Group',
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : now,
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : now,
  }
}

/** All groups, oldest first so the list order is stable across reloads. */
export async function listWorkflowGroups(): Promise<WorkflowGroup[]> {
  const stored = await area.get(KEY_WORKFLOW_GROUPS)
  const list = stored[KEY_WORKFLOW_GROUPS]
  if (!Array.isArray(list)) return []
  return list
    .map(asWorkflowGroup)
    .filter((group): group is WorkflowGroup => group !== null)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Creates or updates a group. A blank `id` creates a new one; the returned
 * record carries the id the caller must use from then on.
 */
export async function saveWorkflowGroup(group: {
  id?: string
  name: string
}): Promise<WorkflowGroup> {
  return withKeyLock(KEY_WORKFLOW_GROUPS, async () => {
    const list = await listWorkflowGroups()
    const now = Date.now()
    const existing = group.id ? list.find((entry) => entry.id === group.id) : undefined
    const record: WorkflowGroup = {
      id: existing?.id ?? newId(),
      name: group.name.trim() || existing?.name || 'Group',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const index = list.findIndex((entry) => entry.id === record.id)
    if (index >= 0) list[index] = record
    else list.push(record)
    await area.set({ [KEY_WORKFLOW_GROUPS]: list })
    return record
  })
}

/** Removes a group. The workflows that pointed at it keep their records; the
 *  caller clears their `folderId` so they fall back to the ungrouped section. */
export async function deleteWorkflowGroup(id: string): Promise<void> {
  await withKeyLock(KEY_WORKFLOW_GROUPS, async () => {
    const list = await listWorkflowGroups()
    await area.set({
      [KEY_WORKFLOW_GROUPS]: list.filter((group) => group.id !== id),
    })
  })
}

/** One list section: a group with its workflows, or the ungrouped bucket. */
export interface WorkflowGroupSection {
  group: WorkflowGroup | null
  workflows: Workflow[]
}

/**
 * Buckets workflows by group.
 *
 * A workflow whose `folderId` names a group that no longer exists lands in the
 * ungrouped bucket rather than disappearing: a stale pointer must not hide a
 * workflow from the list.
 */
export function groupWorkflows(
  workflows: Workflow[],
  groups: WorkflowGroup[],
): WorkflowGroupSection[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const buckets = new Map<string, Workflow[]>()
  const ungrouped: Workflow[] = []
  for (const workflow of workflows) {
    const folderId = workflow.folderId
    if (folderId && byId.has(folderId)) {
      const bucket = buckets.get(folderId)
      if (bucket) bucket.push(workflow)
      else buckets.set(folderId, [workflow])
    } else {
      ungrouped.push(workflow)
    }
  }
  const sections: WorkflowGroupSection[] = groups.map((group) => ({
    group,
    workflows: buckets.get(group.id) ?? [],
  }))
  if (ungrouped.length > 0 || groups.length === 0) {
    sections.push({ group: null, workflows: ungrouped })
  }
  return sections
}

// --- Export / import ---------------------------------------------------------

/** Marker of a group export file. */
export const WORKFLOW_GROUP_EXPORT_TYPE = 'workflow-group'

/** The on-disk shape of a group export. */
export interface WorkflowGroupExport {
  type: typeof WORKFLOW_GROUP_EXPORT_TYPE
  version: 1
  name: string
  exportedAt: number
  workflows: Workflow[]
}

/** Builds the file payload for a group export: the group plus its members. */
export function buildWorkflowGroupExport(name: string, workflows: Workflow[]): WorkflowGroupExport {
  return {
    type: WORKFLOW_GROUP_EXPORT_TYPE,
    version: 1,
    name: name.trim() || 'Group',
    exportedAt: Date.now(),
    workflows,
  }
}

/** Whether a parsed file is a group export rather than a workflow or a list. */
export function isWorkflowGroupExport(value: unknown): value is WorkflowGroupExport {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<WorkflowGroupExport>
  return v.type === WORKFLOW_GROUP_EXPORT_TYPE && Array.isArray(v.workflows)
}
