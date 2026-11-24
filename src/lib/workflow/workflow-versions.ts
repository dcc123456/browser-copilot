/**
 * Workflow save history (spec 2026-11-24-workflow-version-history-design.md).
 *
 * The revision counter (`revision` / `revisionHistory`) already answers "who
 * saved, when, in which order" — and it bumps on EVERY save, changed or not, so
 * it cannot be the version list the user browses. This module is the second
 * layer: content SNAPSHOTS, one per version, kept only when the graph actually
 * changed.
 *
 * Kept pure (no storage, no chrome) so the dedupe key, the eviction rules and
 * the delete rules are unit-testable. Storage lives in `workflow/storage.ts`.
 *
 * @module lib/workflow/workflow-versions
 */

import { shedBulkDataUrls } from '../persist-budget'
import type { Workflow } from './types'

/** How many versions one workflow keeps. */
export const WORKFLOW_VERSION_LIMIT = 20
/**
 * Soft byte budget per workflow. A safety net for write time and key size, NOT
 * a performance knob: a normal graph is ~800 B/node, so 20 versions sit far
 * below this. Injectable so the eviction branch can be tested at all.
 */
export const WORKFLOW_VERSIONS_BUDGET_BYTES = 4 * 1024 * 1024
/** A single node whose data is bigger than this never enters a snapshot. */
export const WORKFLOW_VERSION_NODE_PAYLOAD_LIMIT = 256 * 1024

/** One version line: metadata only; the graph itself lives in its own key. */
export interface WorkflowVersionEntry {
  version: number
  at: number
  /** A save of new content, or a rollback that re-applied an older version. */
  source: 'save' | 'rollback'
  /** Content hash of the snapshot (or, for a rollback, of what it applied). */
  fingerprint: string
  /** The revision counter at that moment — a different number on purpose. */
  revision: number
  nodes: number
  edges: number
  /** Snapshot size in bytes; used for the budget. */
  bytes: number
  /** Rollback only: the version it re-applied. */
  fromVersion?: number
  /** Human note recorded with the action ("回滚自 v3"). */
  note?: string
}

export interface WorkflowVersionIndex {
  workflowId: string
  /** Oldest first; the browse UI reverses it. */
  entries: WorkflowVersionEntry[]
  updatedAt: number
}

/** Why a snapshot was refused outright. */
export type VersionRefusal = 'node-payload' | 'too-large'

export interface AppendVersionResult {
  index: WorkflowVersionIndex
  /** Versions dropped to stay within the limit/budget (their keys go too). */
  evicted: number[]
  refused?: VersionRefusal
}

/** Canonical JSON: object keys sorted, `undefined` dropped, so equal graphs hash equal. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** FNV-1a (64-bit) as hex; deterministic across engines and cheap on long strings. */
function hashText(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = (1n << 64n) - 1n
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * The content identity of a workflow.
 *
 * `revision`, `revisionHistory` and `updatedAt` are excluded because they move
 * on EVERY save — comparing them would make every save look different, which is
 * the exact failure this layer exists to avoid. Viewport state is not part of
 * the record at all, so panning/zooming cannot create a version.
 */
export function workflowFingerprint(workflow: Workflow): string {
  const content = {
    name: workflow.name,
    description: workflow.description ?? '',
    folderId: workflow.folderId ?? '',
    settings: workflow.settings,
    table: workflow.table ?? null,
    plan: workflow.plan ?? null,
    // Viewport is deliberately absent: panning/zooming is not an edit.
    drawflow: { nodes: workflow.drawflow.nodes, edges: workflow.drawflow.edges },
  }
  return hashText(canonicalJson(content))
}

/** JSON size of one node's data, in bytes. */
function dataBytesOf(data: unknown): number {
  try {
    return JSON.stringify(data)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * The exact form a snapshot is written from.
 *
 * Shedding runs BEFORE the fingerprint and BEFORE the byte count, for two
 * reasons: `saveWorkflow` stores the shed copy, so a snapshot of the unshed
 * graph would apply a megabyte the stored workflow never had; and a fingerprint
 * over the unshed form would hash two different values for the same graph, which
 * silently disables de-duplication.
 */
export function prepareSnapshot(
  workflow: Workflow,
): { workflow: Workflow; fingerprint: string; bytes: number } | { refused: 'node-payload' } {
  const prepared = shedBulkDataUrls(workflow) as Workflow
  if (oversizedNodeOf(prepared)) return { refused: 'node-payload' }
  return {
    workflow: prepared,
    fingerprint: workflowFingerprint(prepared),
    bytes: snapshotBytesOf(prepared),
  }
}

/**
 * The first node whose data is too big to snapshot, if any.
 *
 * A screenshot/OCR block can start storing a base64 payload at any time; that is
 * the moment a version list silently multiplies into megabytes. The payload is
 * refused here rather than after twenty copies exist.
 */
export function oversizedNodeOf(
  workflow: Workflow,
  limit = WORKFLOW_VERSION_NODE_PAYLOAD_LIMIT,
): { nodeId: string; bytes: number } | null {
  for (const node of workflow.drawflow.nodes) {
    const bytes = dataBytesOf(node.data)
    if (bytes > limit) return { nodeId: node.id, bytes }
  }
  return null
}

/** Graph size a snapshot of this workflow would have, in bytes. */
export function snapshotBytesOf(workflow: Workflow): number {
  return dataBytesOf({
    name: workflow.name,
    settings: workflow.settings,
    drawflow: workflow.drawflow,
  })
}

function totalBytes(entries: readonly WorkflowVersionEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.bytes, 0)
}

/**
 * Appends one entry, then evicts from the OLDEST end until both the version
 * count and the byte budget hold. Only a snapshot that cannot fit the budget on
 * its own is refused — the user's save must never fail because of history.
 */
export function appendVersion(
  index: WorkflowVersionIndex,
  entry: WorkflowVersionEntry,
  options: { limit?: number; budgetBytes?: number; now?: number } = {},
): AppendVersionResult {
  const limit = options.limit ?? WORKFLOW_VERSION_LIMIT
  const budget = options.budgetBytes ?? WORKFLOW_VERSIONS_BUDGET_BYTES
  const previous = index.entries
  if (entry.bytes > budget) {
    return { index, evicted: [], refused: 'too-large' }
  }
  let entries = [...previous, entry]
  const evicted: number[] = []
  while (entries.length > limit || totalBytes(entries) > budget) {
    // Keep at least the entry we just wrote: evicting everything would leave the
    // list unable to say where the workflow currently is.
    if (entries.length <= 1) break
    const oldest = entries[0]!
    evicted.push(oldest.version)
    entries = entries.slice(1)
  }
  return {
    index: { workflowId: index.workflowId, entries, updatedAt: options.now ?? entry.at },
    evicted,
  }
}

/** Next version number: monotonic even after the oldest entries were evicted. */
export function nextVersionNumber(index: WorkflowVersionIndex): number {
  return index.entries.reduce((max, entry) => Math.max(max, entry.version), 0) + 1
}

/** The entry that matches the canvas as it stands (the last one written). */
export function currentVersionOf(
  index: WorkflowVersionIndex,
  fingerprint: string,
): WorkflowVersionEntry | undefined {
  for (let position = index.entries.length - 1; position >= 0; position -= 1) {
    const entry = index.entries[position]!
    if (entry.fingerprint === fingerprint) return entry
  }
  return undefined
}

/**
 * Deleting is allowed for any version EXCEPT the one that matches the canvas:
 * that entry is "where you are now", and losing it leaves the list unable to
 * name the current state.
 */
export function canDeleteVersion(
  index: WorkflowVersionIndex,
  version: number,
  currentFingerprint: string,
): { ok: true } | { ok: false; reason: 'current' | 'missing' } {
  const entry = index.entries.find((candidate) => candidate.version === version)
  if (!entry) return { ok: false, reason: 'missing' }
  const current = currentVersionOf(index, currentFingerprint)
  if (current && current.version === version) return { ok: false, reason: 'current' }
  return { ok: true }
}

/**
 * A rollback line: it names the version it re-applied and carries that
 * version's content hash, but NO snapshot of its own — twenty slots must not be
 * spent on the same bytes, and it is a trace, not an applicable version.
 */
export function rollbackEntryOf(
  index: WorkflowVersionIndex,
  fromVersion: number,
  input: {
    at: number
    revision: number
    fingerprint: string
    nodes: number
    edges: number
    bytes: number
  },
): WorkflowVersionEntry {
  return {
    version: nextVersionNumber(index),
    at: input.at,
    source: 'rollback',
    fingerprint: input.fingerprint,
    revision: input.revision,
    nodes: input.nodes,
    edges: input.edges,
    bytes: input.bytes,
    fromVersion,
    note: `回滚自 v${fromVersion}`,
  }
}

/** Whether a rollback entry's source version no longer exists. */
export function rollbackSourceDeleted(
  index: WorkflowVersionIndex,
  entry: WorkflowVersionEntry,
): boolean {
  if (entry.source !== 'rollback' || entry.fromVersion === undefined) return false
  return !index.entries.some((candidate) => candidate.version === entry.fromVersion)
}
