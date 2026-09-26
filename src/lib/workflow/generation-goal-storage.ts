/**
 * Durable storage for per-conversation workflow generation goal contracts.
 *
 * Like drafts, the goal contract is established once (via
 * `prepare_workflow_goal`) and read on every later operator call, while the
 * MV3 service worker can recycle between calls. Contracts are mirrored under
 * one `workflow-generation-goals` key in the same file/storage area and
 * rehydrated on demand.
 *
 * @module lib/workflow/generation-goal-storage
 */

import { fileStorageArea } from '../fs-store'
import { withKeyLock } from '../key-lock'
import {
  normalizeGenerationGoalContract,
  type WorkflowGenerationGoalContract,
} from './generation-goal'

const KEY_GENERATION_GOALS = 'workflow-generation-goals'

/** Cap on retained goal contracts; oldest conversations drop first. */
const MAX_STORED_GOALS = 32

const area = fileStorageArea()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function readAll(): Promise<Record<string, unknown>> {
  const raw = await area.get(KEY_GENERATION_GOALS)
  const value = raw?.[KEY_GENERATION_GOALS]
  return isRecord(value) ? value : {}
}

async function writeAll(record: Record<string, unknown>): Promise<void> {
  await area.set({ [KEY_GENERATION_GOALS]: record })
}

/** Persist a generation goal contract for a conversation. */
export async function saveGenerationGoal(
  conversationId: string,
  contract: WorkflowGenerationGoalContract,
): Promise<void> {
  await withKeyLock(KEY_GENERATION_GOALS, async () => {
    const all = await readAll()
    const next: Record<string, unknown> = { ...all, [conversationId]: contract }
    // Bound the size: drop conversation keys beyond the cap (insertion order).
    const keys = Object.keys(next)
    if (keys.length > MAX_STORED_GOALS) {
      for (const key of keys.slice(0, keys.length - MAX_STORED_GOALS)) delete next[key]
    }
    await writeAll(next)
  })
}

/** Load a generation goal contract for a conversation, or undefined. */
export async function loadGenerationGoal(
  conversationId: string,
): Promise<WorkflowGenerationGoalContract | undefined> {
  const all = await readAll()
  return normalizeGenerationGoalContract(all[conversationId])
}

/** Remove a generation goal contract (e.g. after the workflow is composed). */
export async function clearGenerationGoal(conversationId: string): Promise<void> {
  await withKeyLock(KEY_GENERATION_GOALS, async () => {
    const all = await readAll()
    if (!(conversationId in all)) return
    delete all[conversationId]
    await writeAll(all)
  })
}
