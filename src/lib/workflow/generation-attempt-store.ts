/**
 * Capped local log of generation attempts.
 *
 * The store exists so the panel and the local-agent bridge leave the same
 * trace: one record per generation attempt, updated as replay and repair add
 * facts. It follows the repair-metrics / takeover-stats pattern — the same
 * `fileStorageArea`, a bounded window, and best-effort writes.
 *
 * A write failure must never change what generation returned. The merged
 * record is built in memory first and returned regardless, so a full disk or a
 * disconnected folder costs telemetry, not a workflow.
 *
 * @module lib/workflow/generation-attempt-store
 */

import { fileStorageArea } from '../fs-store'
import {
  mergeGenerationAttempt,
  normalizeGenerationAttempt,
  type GenerationAttemptPatch,
  type GenerationAttemptRecord,
} from './generation-attempt'

const KEY = 'bc_generation_attempts'
const MAX_RECORDS = 500
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30

async function loadStoredAttempts(): Promise<GenerationAttemptRecord[]> {
  const stored = await fileStorageArea().get(KEY)
  const raw = stored[KEY]
  if (!Array.isArray(raw)) return []
  const records: GenerationAttemptRecord[] = []
  for (const entry of raw) {
    const record = normalizeGenerationAttempt(entry)
    if (record) records.push(record)
  }
  return records
}

/**
 * Upsert one attempt by `attemptId` and return the merged record.
 *
 * Always resolves: a read or write failure degrades to the in-memory merge.
 */
export async function recordGenerationAttempt(
  patch: GenerationAttemptPatch,
): Promise<GenerationAttemptRecord> {
  let attempts: GenerationAttemptRecord[] = []
  try {
    attempts = await loadStoredAttempts()
  } catch {
    // Telemetry must never break generation.
  }
  const previous = attempts.find((record) => record.attemptId === patch.attemptId)
  const merged = mergeGenerationAttempt(previous, patch)
  try {
    const cutoff = Date.now() - MAX_AGE_MS
    const kept = attempts.filter(
      (record) => record.attemptId !== merged.attemptId && record.at >= cutoff,
    )
    await fileStorageArea().set({ [KEY]: [...kept, merged].slice(-MAX_RECORDS) })
  } catch {
    // Same rule: a failed write loses one record, not the attempt.
  }
  return merged
}

/** Drops every record (used by tests and a future "clear stats" action). */
export async function clearGenerationAttempts(): Promise<void> {
  try {
    await fileStorageArea().set({ [KEY]: [] })
  } catch {
    // Best-effort by design.
  }
}
