/**
 * Persistence for workflows.
 *
 * Workflows live in `chrome.storage.local` under the single `'workflows'` key,
 * mirroring the rest of the codebase (see `task-store.ts`). Kept in
 * `lib/workflow/*` rather than shared `storage.ts` because workflows have their
 * own schema and their own normalization rules; lumping them in would widen
 * that already-busy module.
 *
 * @module lib/workflow/storage
 */

import { newId } from '../storage'
import type {
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowSettings,
} from './types'

const KEY_WORKFLOWS = 'workflows'

const DEFAULT_SETTINGS: WorkflowSettings = {
  saveLog: false,
  debugMode: false,
  notification: false,
  reuseLastState: false,
}

/**
 * Normalizes a stored workflow value into the current shape, or returns `null`
 * when the record is unusable (missing the id/name every workflow needs).
 *
 * Storage is shared with a user who may have downgraded or hit a half-written
 * record, so every field is validated rather than trusted. Exported as a pure
 * function so the rules are unit-testable without `chrome`.
 */
export function asWorkflow(value: unknown): Workflow | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<Workflow>
  if (typeof v.id !== 'string' || typeof v.name !== 'string') return null

  const rawDrawflow = (v.drawflow ?? {}) as {
    nodes?: unknown
    edges?: unknown
    position?: unknown
    zoom?: unknown
  }
  const nodes: WorkflowNode[] = Array.isArray(rawDrawflow.nodes)
    ? rawDrawflow.nodes.filter(
        (node): node is WorkflowNode =>
          !!node &&
          typeof node === 'object' &&
          typeof (node as WorkflowNode).id === 'string' &&
          typeof (node as WorkflowNode).label === 'string' &&
          !!node &&
          typeof (node as WorkflowNode).position === 'object' &&
          typeof (node as WorkflowNode).position?.x === 'number' &&
          typeof (node as WorkflowNode).position?.y === 'number',
      )
    : []
  const edges: WorkflowEdge[] = Array.isArray(rawDrawflow.edges)
    ? rawDrawflow.edges.filter(
        (edge): edge is WorkflowEdge =>
          !!edge &&
          typeof edge === 'object' &&
          typeof (edge as WorkflowEdge).id === 'string' &&
          typeof (edge as WorkflowEdge).source === 'string' &&
          typeof (edge as WorkflowEdge).target === 'string',
      )
    : []

  const rawPosition = rawDrawflow.position
  const position =
    rawPosition && typeof rawPosition === 'object'
      ? ((rawPosition as { x?: unknown; y?: unknown }).x === 'number' ||
          (rawPosition as { x?: unknown; y?: unknown }).y === 'number'
          ? (rawPosition as unknown as { x: number; y: number })
          : undefined)
      : undefined

  const rawSettings = (v.settings ?? {}) as Partial<WorkflowSettings>
  const settings: WorkflowSettings = {
    ...DEFAULT_SETTINGS,
    saveLog: rawSettings.saveLog === true,
    debugMode: rawSettings.debugMode === true,
    notification: rawSettings.notification === true,
    reuseLastState: rawSettings.reuseLastState === true,
    ...(typeof rawSettings.defaultColumnName === 'string'
      ? { defaultColumnName: rawSettings.defaultColumnName }
      : {}),
  }

  return {
    id: v.id,
    name: v.name || 'Workflow',
    ...(typeof v.description === 'string' ? { description: v.description } : {}),
    ...(typeof v.folderId === 'string' ? { folderId: v.folderId } : {}),
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(),
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : Date.now(),
    drawflow: {
      nodes,
      edges,
      ...(position ? { position } : {}),
      ...(typeof rawDrawflow.zoom === 'number' ? { zoom: rawDrawflow.zoom } : {}),
    },
    settings,
    ...(v.trigger && typeof v.trigger === 'object' && typeof v.trigger.type === 'string'
      ? { trigger: v.trigger }
      : {}),
    ...(v.table !== undefined ? { table: v.table } : {}),
  }
}

export async function listWorkflows(): Promise<Workflow[]> {
  const stored = await chrome.storage.local.get(KEY_WORKFLOWS)
  const list = stored[KEY_WORKFLOWS]
  if (!Array.isArray(list)) return []
  return list
    .map(asWorkflow)
    .filter((workflow): workflow is Workflow => workflow !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getWorkflow(id: string): Promise<Workflow | undefined> {
  return (await listWorkflows()).find((workflow) => workflow.id === id)
}

export async function saveWorkflow(workflow: Workflow): Promise<void> {
  const list = await listWorkflows()
  const normalized = asWorkflow({ ...workflow, updatedAt: Date.now() })
  if (!normalized) throw new Error('Invalid workflow')
  const index = list.findIndex((existing) => existing.id === workflow.id)
  if (index >= 0) list[index] = normalized
  else list.push(normalized)
  await chrome.storage.local.set({ [KEY_WORKFLOWS]: list })
}

export async function deleteWorkflow(id: string): Promise<void> {
  const list = await listWorkflows()
  await chrome.storage.local.set({
    [KEY_WORKFLOWS]: list.filter((workflow) => workflow.id !== id),
  })
}

/**
 * Creates a detached copy of an existing workflow under a fresh id.
 *
 * `newName` overrides the display name; otherwise `"<name> (copy)"` is used.
 * Returns `undefined` when no workflow with `id` exists.
 */
export async function duplicateWorkflow(
  id: string,
  newName?: string,
): Promise<Workflow | undefined> {
  const source = await getWorkflow(id)
  if (!source) return undefined
  const now = Date.now()
  const copy = asWorkflow({
    ...JSON.parse(JSON.stringify(source)),
    id: newId(),
    name: newName?.trim() || `${source.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  })
  if (!copy) return undefined
  await saveWorkflow(copy)
  return copy
}