/**
 * Durable storage for per-conversation workflow generation goal contracts.
 *
 * Like drafts, the goal contract is established once (via
 * `prepare_workflow_goal`) and read on every later operator call, while the
 * MV3 service worker can recycle between calls. Contracts are stored in
 * chrome.storage.local to avoid any file-system dependency in the service worker.
 *
 * @module lib/workflow/generation-goal-storage
 */

import { withKeyLock } from '../key-lock'
import {
  normalizeGenerationGoalContract,
  type WorkflowGenerationGoalContract,
} from './generation-goal'

const KEY_GENERATION_GOALS = 'workflow-generation-goals'
const KEY_CONFIRMED_NAMES = 'workflow-confirmed-names'

/** Cap on retained goal contracts; oldest conversations drop first. */
const MAX_STORED_GOALS = 32
/** Cap on retained user-confirmed names; same eviction policy. */
const MAX_STORED_NAMES = 32

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function readAll(): Promise<Record<string, unknown>> {
  const raw = await chrome.storage.local.get(KEY_GENERATION_GOALS)
  const value = raw?.[KEY_GENERATION_GOALS]
  return isRecord(value) ? value : {}
}

async function writeAll(record: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set({ [KEY_GENERATION_GOALS]: record })
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

// --- User-confirmed workflow names -------------------------------------------
//
// Workflow generation mode asks the user to confirm the workflow name BEFORE
// the task runs. The name must survive service-worker recycling until
// `prepare_workflow_goal` establishes the contract, so it is persisted in
// chrome.storage.local (not file storage) to avoid any page-context dependency.

async function readNames(): Promise<Record<string, unknown>> {
  const raw = await chrome.storage.local.get(KEY_CONFIRMED_NAMES)
  const value = raw?.[KEY_CONFIRMED_NAMES]
  return isRecord(value) ? value : {}
}

async function writeNames(record: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set({ [KEY_CONFIRMED_NAMES]: record })
}

/** Persist the workflow name the user confirmed at task start. */
export async function saveConfirmedWorkflowName(
  conversationId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) return
  await withKeyLock(KEY_CONFIRMED_NAMES, async () => {
    const all = await readNames()
    const next: Record<string, unknown> = { ...all, [conversationId]: trimmed }
    const keys = Object.keys(next)
    if (keys.length > MAX_STORED_NAMES) {
      for (const key of keys.slice(0, keys.length - MAX_STORED_NAMES)) delete next[key]
    }
    await writeNames(next)
  })
}

/** Load the user-confirmed workflow name for a conversation, if any. */
export async function loadConfirmedWorkflowName(
  conversationId: string,
): Promise<string | undefined> {
  const all = await readNames()
  const value = all[conversationId]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Drop the user-confirmed name once it has been adopted into a contract. */
export async function clearConfirmedWorkflowName(conversationId: string): Promise<void> {
  await withKeyLock(KEY_CONFIRMED_NAMES, async () => {
    const all = await readNames()
    if (!(conversationId in all)) return
    const next: Record<string, unknown> = { ...all }
    delete next[conversationId]
    await writeNames(next)
  })
}
