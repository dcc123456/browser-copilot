/**
 * Saved transcripts for the editor's floating AI operator assistant.
 *
 * One key per workflow (`operatorChat:<workflowId>`) holds every chat the user
 * kept for that workflow, newest first. Keeping the key workflow-scoped makes
 * the cascade trivial: `deleteWorkflows()` removes the key and every session in
 * it goes with the workflow, with no index to keep in sync.
 *
 * `turns` is deliberately `unknown[]`. A dock row is a rich UI value (proposals,
 * landing receipts, thinking, pending page offers) that this layer must not have
 * to understand — and must not drag React/editor types into. The dock validates
 * the snapshot at the UI boundary when it loads a session.
 *
 * All reads/writes go through the shared `fileStorageArea`; panel code reaches
 * them through `sendCommand`, so the file handle and outbox stay owned by the
 * service worker alone (see `lib/fs-store.ts`).
 *
 * @module lib/workflow/operator-chat-sessions
 */

import { fileStorageArea } from '../fs-store'
import { withKeyLock } from '../key-lock'

export interface OperatorChatSession {
  id: string
  workflowId: string
  title: string
  createdAt: number
  updatedAt: number
  /** JSON snapshot of the dock transcript; opaque to this layer. */
  turns: unknown[]
}

const KEY_PREFIX = 'operatorChat:'

/** Storage key for one workflow's saved chats. Exported for the cascade path. */
export function operatorChatSessionsKey(workflowId: string): string {
  return `${KEY_PREFIX}${workflowId}`
}

const area = fileStorageArea()

/** Drop unusable records rather than trusting a hand-edited / stale file. */
function asSession(value: unknown, workflowId: string): OperatorChatSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id) return null
  if (!Array.isArray(record.turns)) return null
  return {
    id: record.id,
    workflowId,
    title: typeof record.title === 'string' ? record.title : '',
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    turns: record.turns,
  }
}

async function readList(workflowId: string): Promise<OperatorChatSession[]> {
  const key = operatorChatSessionsKey(workflowId)
  const stored = await area.get(key)
  const list = stored[key]
  if (!Array.isArray(list)) return []
  return list
    .map((entry) => asSession(entry, workflowId))
    .filter((session): session is OperatorChatSession => session !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Every saved chat of a workflow, most recently active first. */
export async function listOperatorChatSessions(workflowId: string): Promise<OperatorChatSession[]> {
  if (!workflowId) return []
  return readList(workflowId)
}

/**
 * Insert or replace one chat. A stale snapshot never overwrites a newer one:
 * the dock saves on every transcript change, and two in-flight saves can be
 * settled by the worker out of order (see `lib/key-lock.ts`).
 */
export async function saveOperatorChatSession(
  workflowId: string,
  session: OperatorChatSession,
): Promise<void> {
  if (!workflowId || !session?.id) return
  const key = operatorChatSessionsKey(workflowId)
  await withKeyLock(key, async () => {
    const list = await readList(workflowId)
    const existing = list.find((entry) => entry.id === session.id)
    if (existing && existing.updatedAt > session.updatedAt) return
    const stored: OperatorChatSession = {
      ...session,
      workflowId,
      turns: Array.isArray(session.turns) ? session.turns : [],
    }
    await area.set({
      [key]: [stored, ...list.filter((entry) => entry.id !== stored.id)],
    })
  })
}

/** Forget one chat; the others and the workflow itself are untouched. */
export async function deleteOperatorChatSession(
  workflowId: string,
  sessionId: string,
): Promise<void> {
  if (!workflowId || !sessionId) return
  const key = operatorChatSessionsKey(workflowId)
  await withKeyLock(key, async () => {
    const list = await readList(workflowId)
    const next = list.filter((entry) => entry.id !== sessionId)
    if (next.length === list.length) return
    if (next.length === 0) {
      await area.remove(key)
      return
    }
    await area.set({ [key]: next })
  })
}

/**
 * Cascade: deleting a workflow takes its chats with it. Called from
 * `deleteWorkflows()` — the single funnel for single, bulk and group deletes.
 */
export async function deleteOperatorChatSessionsForWorkflow(workflowId: string): Promise<void> {
  if (!workflowId) return
  const key = operatorChatSessionsKey(workflowId)
  await withKeyLock(key, async () => {
    await area.remove(key)
  })
}
