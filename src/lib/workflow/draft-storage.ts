/**
 * Durable storage for workflow-generation drafts.
 *
 * A draft is assembled across many agent tool calls, and the MV3 service worker
 * can be evicted between any two of them. Keeping the draft only in a
 * module-level `Map` (as it originally was) therefore silently lost a session's
 * work whenever the worker recycled mid-run. Every draft is mirrored here on
 * write and rehydrated on demand.
 *
 * Drafts live under one `'workflow-drafts'` key as a conversation-id → draft
 * record, in the same area as workflows (real JSON files when a directory is
 * configured, else `chrome.storage.local` — see `lib/fs-store.ts`).
 *
 * @module lib/workflow/draft-storage
 */

import { fileStorageArea } from '../fs-store'
import type { DraftSource, PendingBranch, WorkflowDraft } from './draft-types'
import type { WorkflowEdge, WorkflowNode } from './types'

const KEY_WORKFLOW_DRAFTS = 'workflow-drafts'

/** Cap on retained drafts; the oldest conversations are dropped first. */
const MAX_STORED_DRAFTS = 32

const DRAFT_SOURCES: ReadonlySet<string> = new Set<DraftSource>(['chat-generate', 'chat-history'])

/**
 * The active storage area: files when a directory is configured and granted,
 * otherwise the `chrome.storage.local` mirror (see `lib/fs-store.ts`).
 */
const area = fileStorageArea()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nodesOf(value: unknown): WorkflowNode[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (node): node is WorkflowNode =>
      isRecord(node) &&
      typeof node.id === 'string' &&
      typeof node.label === 'string' &&
      isRecord(node.position) &&
      typeof node.position.x === 'number' &&
      typeof node.position.y === 'number' &&
      isRecord(node.data),
  )
}

function edgesOf(value: unknown): WorkflowEdge[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (edge): edge is WorkflowEdge =>
      isRecord(edge) &&
      typeof edge.id === 'string' &&
      typeof edge.source === 'string' &&
      typeof edge.target === 'string',
  )
}

function pendingBranchOf(value: unknown): PendingBranch | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.source !== 'string' ||
    typeof value.sourceBlockId !== 'string' ||
    typeof value.output !== 'string'
  ) {
    return undefined
  }
  return { source: value.source, sourceBlockId: value.sourceBlockId, output: value.output }
}

/**
 * Normalizes a stored draft, or returns `null` when the record is unusable.
 *
 * Storage is shared with a user who may have downgraded or hit a half-written
 * record, so every field is validated rather than trusted. Exported as a pure
 * function so the rules are unit-testable without `chrome`.
 */
export function asPersistedDraft(value: unknown): WorkflowDraft | null {
  if (!isRecord(value)) return null
  const { conversationId, name } = value
  if (typeof conversationId !== 'string' || !conversationId) return null
  if (typeof name !== 'string') return null

  const nodes = nodesOf(value.nodes)
  const edges = edgesOf(value.edges)
  const tail = typeof value.tail === 'string' ? value.tail : null
  const source: DraftSource =
    typeof value.source === 'string' && DRAFT_SOURCES.has(value.source)
      ? (value.source as DraftSource)
      : 'chat-generate'
  const pendingBranch = pendingBranchOf(value.pendingBranch)
  const variables = isRecord(value.variables) ? value.variables : undefined

  return {
    conversationId,
    name,
    nodes,
    edges,
    tail,
    source,
    ...(pendingBranch ? { pendingBranch } : {}),
    ...(variables ? { variables } : {}),
  }
}

async function readAll(): Promise<Record<string, unknown>> {
  const stored = await area.get(KEY_WORKFLOW_DRAFTS)
  const raw = stored[KEY_WORKFLOW_DRAFTS]
  return isRecord(raw) ? raw : {}
}

/** The persisted draft for a conversation, if one survived the worker restart. */
export async function loadDraft(conversationId: string): Promise<WorkflowDraft | undefined> {
  const all = await readAll()
  const draft = asPersistedDraft(all[conversationId])
  return draft ?? undefined
}

/**
 * Mirror a draft to durable storage, dropping the oldest conversations once the
 * cap is reached. Insertion order of the record is the eviction order.
 */
export async function saveDraft(draft: WorkflowDraft): Promise<void> {
  const all = await readAll()
  delete all[draft.conversationId]
  all[draft.conversationId] = draft
  const keys = Object.keys(all)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_STORED_DRAFTS))) {
    delete all[key]
  }
  await area.set({ [KEY_WORKFLOW_DRAFTS]: all })
}

export async function deleteDraft(conversationId: string): Promise<void> {
  const all = await readAll()
  if (!(conversationId in all)) return
  delete all[conversationId]
  await area.set({ [KEY_WORKFLOW_DRAFTS]: all })
}
