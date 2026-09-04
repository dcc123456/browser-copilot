/**
 * Persistence for "AI 调试" backups.
 *
 * Before a debug session's first modification is saved, the pre-debug
 * workflow is snapshotted here so the user can REVIEW what the AI changed and
 * either KEEP it or REVERT to this snapshot. Backups live under their own key
 * in the same storage area workflows use, keyed by workflow id:
 *
 * - one backup per workflow (the EARLIEST modifying session wins — rolling
 *   back then means "undo everything the AI ever did", not just one round),
 * - records whose workflow was deleted are pruned on the next write,
 * - `info` rows (without the heavy workflow payload) feed the panel chip.
 *
 * @module lib/workflow/debug-backup
 */
import { fileStorageArea } from '../fs-store'
import { asWorkflow, listWorkflows } from './storage'
import type { Workflow } from './types'

const KEY_BACKUPS = 'aiDebugBackups'

/** A stored pre-debug snapshot for one workflow. */
export interface DebugBackupRecord {
  /** The full workflow exactly as it was before AI modifications. */
  workflow: Workflow
  /** One-line summary of the session that produced the changes. */
  summary: string
  /** Human-readable change notes (per applied round). */
  changes: string[]
  savedAt: number
}

/** Panel-facing backup info (no workflow payload). */
export interface DebugBackupInfo {
  workflowId: string
  name: string
  savedAt: number
  changes: string[]
}

/** Structural guard so corrupted/foreign payloads degrade to "no backup". */
function isBackupRecord(value: unknown): value is DebugBackupRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<DebugBackupRecord>
  const workflow = record.workflow
  return (
    !!workflow &&
    typeof workflow === 'object' &&
    typeof (workflow as Workflow).id === 'string' &&
    typeof record.savedAt === 'number'
  )
}

async function loadAll(): Promise<Record<string, DebugBackupRecord>> {
  const stored = await fileStorageArea().get(KEY_BACKUPS)
  const raw = stored[KEY_BACKUPS]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const all: Record<string, DebugBackupRecord> = {}
  for (const [id, record] of Object.entries(raw as Record<string, unknown>)) {
    if (isBackupRecord(record)) all[id] = record
  }
  return all
}

async function writeAll(all: Record<string, DebugBackupRecord>): Promise<void> {
  await fileStorageArea().set({ [KEY_BACKUPS]: all })
}

/**
 * Snapshots the pre-debug workflow. Called by the debug command AFTER a
 * session modified the workflow, passing the untouched pre-debug object.
 * Keeps the earliest snapshot per workflow id and prunes orphans (workflows
 * that no longer exist).
 */
export async function saveDebugBackup(
  preDebugWorkflow: Workflow,
  summary: string,
  changes: string[],
): Promise<void> {
  const normalized = asWorkflow(JSON.parse(JSON.stringify(preDebugWorkflow)))
  if (!normalized) return
  const all = await loadAll()
  const existing = all[normalized.id]
  if (existing) return // earliest pre-AI state wins
  // Prune backups whose workflow was deleted meanwhile.
  const liveIds = new Set((await listWorkflows()).map((workflow) => workflow.id))
  const next: Record<string, DebugBackupRecord> = {}
  for (const [id, record] of Object.entries(all)) {
    if (liveIds.has(id)) next[id] = record
  }
  next[normalized.id] = {
    workflow: normalized,
    summary,
    changes: changes.slice(0, 20),
    savedAt: Date.now(),
  }
  await writeAll(next)
}

/** Returns the stored backup for a workflow, or undefined. */
export async function getDebugBackup(workflowId: string): Promise<DebugBackupRecord | undefined> {
  return (await loadAll())[workflowId]
}

/**
 * Restores the stored snapshot over the current workflow (the AI's changes
 * are discarded) and clears the backup. Returns undefined when no backup
 * exists — the caller decides how to surface that.
 */
export async function revertDebugBackup(workflowId: string): Promise<Workflow | undefined> {
  const all = await loadAll()
  const record = all[workflowId]
  if (!record) return undefined
  const restored = asWorkflow(JSON.parse(JSON.stringify(record.workflow)))
  if (!restored) return undefined
  delete all[workflowId]
  await writeAll(all)
  return restored
}

/** Dismisses the review chip: the AI changes are kept, the snapshot dropped. */
export async function clearDebugBackup(workflowId: string): Promise<void> {
  const all = await loadAll()
  if (!all[workflowId]) return
  delete all[workflowId]
  await writeAll(all)
}

/** Panel-facing list of all stored backups (info rows only). */
export async function listDebugBackups(): Promise<DebugBackupInfo[]> {
  const all = await loadAll()
  return Object.entries(all)
    .map(([workflowId, record]) => ({
      workflowId,
      name: record.workflow.name,
      savedAt: record.savedAt,
      changes: record.changes,
    }))
    .sort((a, b) => b.savedAt - a.savedAt)
}
