/**
 * Which workflow triggers a user may actually pick.
 *
 * The `WorkflowTrigger` union is wider than the set of triggers this build
 * wires up: `scheduled` (cron) is documented as not auto-armed, and the
 * integration kinds (`github` / `feishu`) are created by their own paths.
 * Offering those in the "save as workflow" card would hand the user a workflow
 * that silently never fires, so the UI is restricted to
 * {@link OFFERED_TRIGGER_TYPES} and the rest are reported as a warning by
 * {@link validateWorkflowForRun}.
 *
 * Kept separate from `types.ts` so the engine/storage layers (which must accept
 * every historical trigger kind) never import a UI restriction.
 *
 * @module lib/workflow/trigger-options
 */

import type { WorkflowTrigger } from './types'

/** Trigger kinds that this build actually arms. */
export const OFFERED_TRIGGER_TYPES = [
  'manual',
  'on-startup',
  'keyboard-shortcut',
  'context-menu',
  'visit-web',
  'interval',
  'specific-day',
  'date',
  // Armed by the injected MutationObserver in `background/workflow-triggers`.
  'element-change',
] as const

export type OfferedTriggerType = (typeof OFFERED_TRIGGER_TYPES)[number]

const OFFERED = new Set<string>(OFFERED_TRIGGER_TYPES)

/** Is this trigger kind one the build can actually fire? */
export function isOfferedTriggerType(type: string): type is OfferedTriggerType {
  return OFFERED.has(type)
}

/**
 * The trigger-block field each kind cannot work without. `null` means the kind
 * needs no extra input (`manual`, `on-startup`).
 */
export const TRIGGER_REQUIRED_FIELD: Readonly<Record<OfferedTriggerType, string | null>> = {
  manual: null,
  'on-startup': null,
  'keyboard-shortcut': 'shortcut',
  'context-menu': 'contextMenuName',
  'visit-web': 'url',
  interval: 'interval',
  'specific-day': 'days',
  date: 'date',
  // Nested under `observeElement`; see `missingTriggerParam`.
  'element-change': 'observeElement.selector',
}

/** Is the trigger (top-level mirror or graph node) switched on? */
export function triggerIsEnabled(trigger: WorkflowTrigger | undefined): boolean {
  return trigger?.enabled !== false
}
