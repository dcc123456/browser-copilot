/**
 * Persistence for pending AI-takeover fixes (AI 接管待确认修改).
 *
 * A takeover completes the failed node ON THE PAGE but never edits the
 * workflow by itself. The params fixes the AI proposes are stored here —
 * keyed by workflow id, latest session replaces earlier ones — until the user
 * explicitly APPLIES them to the workflow or DISCARDS them:
 *
 * - the panel shows a confirm dialog right after a takeover-assisted debug,
 * - a pending record that was never answered (panel closed, worker restart)
 *   resurfaces as a chip on the workflow card until it is answered.
 *
 * Records whose workflow was deleted are pruned on the next write.
 *
 * @module lib/workflow/takeover-pending
 */
import { fileStorageArea } from '../fs-store'
import { listWorkflows } from './storage'
import type { TakeoverFix } from './ai-takeover'
import type { Workflow } from './types'

const KEY_PENDING = 'aiTakeoverPending'

/** A whole-graph rewrite awaiting confirmation (the audit path's product). */
export interface PendingRewrite {
  workflow: Workflow
  changes: string[]
  diagnosis: string
}

/** A stored set of pending takeover fixes for one workflow. */
export interface PendingTakeoverRecord {
  workflowId: string
  /** Run id of the debug session that produced the fixes. */
  runId?: string
  fixes: TakeoverFix[]
  /**
   * Whole-workflow rewrite from the debug audit (复演+图审计). When present
   * the apply action replaces the workflow's GRAPH instead of patching
   * individual params. `fixes` may then be empty.
   */
  rewrite?: PendingRewrite
  createdAt: number
}

/** Panel-facing pending info (joins the workflow name for display). */
export interface PendingTakeoverInfo {
  workflowId: string
  name: string
  createdAt: number
  fixes: TakeoverFix[]
  rewrite?: { changes: string[]; diagnosis: string }
}

/** Structural guard so corrupted/foreign payloads degrade to "no pending". */
function isFix(value: unknown): value is TakeoverFix {
  if (!value || typeof value !== 'object') return false
  const fix = value as Partial<TakeoverFix>
  return (
    typeof fix.nodeId === 'string' &&
    typeof fix.nodeLabel === 'string' &&
    !!fix.paramsPatch &&
    typeof fix.paramsPatch === 'object' &&
    !Array.isArray(fix.paramsPatch) &&
    typeof fix.note === 'string'
  )
}

/** Loose shape check for a stored rewrite payload. */
function isRewrite(value: unknown): value is PendingRewrite {
  if (!value || typeof value !== 'object') return false
  const rewrite = value as Partial<PendingRewrite>
  return (
    !!rewrite.workflow &&
    typeof rewrite.workflow === 'object' &&
    !!rewrite.workflow.drawflow &&
    Array.isArray(rewrite.workflow.drawflow.nodes) &&
    Array.isArray(rewrite.changes) &&
    typeof rewrite.diagnosis === 'string'
  )
}

function isRecord(value: unknown): value is PendingTakeoverRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<PendingTakeoverRecord>
  return (
    typeof record.workflowId === 'string' &&
    typeof record.createdAt === 'number' &&
    Array.isArray(record.fixes) &&
    record.fixes.every(isFix) &&
    (record.rewrite === undefined || isRewrite(record.rewrite))
  )
}

async function loadAll(): Promise<Record<string, PendingTakeoverRecord>> {
  const stored = await fileStorageArea().get(KEY_PENDING)
  const raw = stored[KEY_PENDING]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const all: Record<string, PendingTakeoverRecord> = {}
  for (const [id, record] of Object.entries(raw as Record<string, unknown>)) {
    if (isRecord(record)) all[id] = record
  }
  return all
}

async function writeAll(all: Record<string, PendingTakeoverRecord>): Promise<void> {
  await fileStorageArea().set({ [KEY_PENDING]: all })
}

/**
 * Stores (replaces) the pending fixes for one workflow. A new debug session's
 * fixes replace earlier unanswered ones — they describe the same nodes.
 * Prunes records whose workflow was deleted meanwhile.
 */
export async function savePendingTakeover(record: PendingTakeoverRecord): Promise<void> {
  const all = await loadAll()
  // Prune orphans (workflow deleted since the record was written).
  const liveIds = new Set((await listWorkflows()).map((workflow) => workflow.id))
  const next: Record<string, PendingTakeoverRecord> = {}
  for (const [id, existing] of Object.entries(all)) {
    if (liveIds.has(id)) next[id] = existing
  }
  if (liveIds.has(record.workflowId) && (record.fixes.length > 0 || record.rewrite)) {
    next[record.workflowId] = {
      ...record,
      fixes: record.fixes.slice(0, 20),
    }
  }
  await writeAll(next)
}

/** Returns the pending fixes for a workflow, or undefined. */
export async function getPendingTakeover(workflowId: string): Promise<PendingTakeoverRecord | undefined> {
  return (await loadAll())[workflowId]
}

/** Panel-facing list of all pending records (newest first). */
export async function listPendingTakeovers(): Promise<PendingTakeoverInfo[]> {
  const all = await loadAll()
  const workflows = await listWorkflows()
  const nameById = new Map(workflows.map((workflow) => [workflow.id, workflow.name]))
  return Object.entries(all)
    .map(([workflowId, record]) => ({
      workflowId,
      name: nameById.get(workflowId) ?? record.workflowId,
      createdAt: record.createdAt,
      fixes: record.fixes,
      ...(record.rewrite
        ? { rewrite: { changes: record.rewrite.changes, diagnosis: record.rewrite.diagnosis } }
        : {}),
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Discards the pending fixes for a workflow (user rejected them). */
export async function clearPendingTakeover(workflowId: string): Promise<void> {
  const all = await loadAll()
  if (!all[workflowId]) return
  delete all[workflowId]
  await writeAll(all)
}
