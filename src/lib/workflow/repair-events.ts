/**
 * Repair progress events (spec §19.2, Commit 14).
 *
 * The event vocabulary streamed by the autonomous repair orchestrator to the
 * sidepanel while a repair runs. Lives in `lib` (pure) so both the background
 * orchestrator and the shared message protocol reference one definition.
 *
 * @module lib/workflow/repair-events
 */

export type RepairProgressEvent =
  | { type: 'repair.started'; sessionId: string; workflowId: string; runId: string }
  | { type: 'repair.diagnosing'; sessionId: string; strategy: string; attempt: number }
  | { type: 'repair.applying'; sessionId: string; strategy: string; changedNodeIds: string[] }
  | { type: 'repair.resuming'; sessionId: string; nodeId: string }
  | { type: 'repair.verifying'; sessionId: string }
  | { type: 'repair.attempt-failed'; sessionId: string; attempt: number; reason: string }
  | { type: 'repair.success'; sessionId: string; revision?: number; note?: string }
  | { type: 'repair.exhausted'; sessionId: string; reason: string }
  | { type: 'repair.blocked'; sessionId: string; reason: string }

/** Terminal (settled) event types. */
export const REPAIR_TERMINAL_EVENTS: ReadonlySet<RepairProgressEvent['type']> = new Set<
  RepairProgressEvent['type']
>(['repair.success', 'repair.exhausted', 'repair.blocked'])

/** Whether an event settles the repair session. */
export function repairEventIsTerminal(type: RepairProgressEvent['type']): boolean {
  return REPAIR_TERMINAL_EVENTS.has(type)
}
