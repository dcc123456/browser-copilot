/**
 * Multi-trigger workflow model.
 *
 * The trigger block's flat fields (`type` + the selected kind's parameters) are
 * the LEGACY single-trigger shape; the top-level `workflow.trigger` is a
 * denormalized mirror of its first entry. Automa stores a list instead
 * (`data.triggers: { id, type, data }[]`), and this module is the one reader and
 * writer for both shapes:
 *
 * - `normalizeTriggers` folds a legacy flat block into a one-entry list, so old
 *   graphs, the editor and the background listeners all see the same specs.
 * - `writeTriggers` writes the list AND mirrors its FIRST entry onto the flat
 *   fields, which keeps `triggerFromNodes`, the workflows-list chip and the
 *   Runner scheduler working unchanged. The first entry is the primary trigger.
 * - `parseTriggerAlarmName` accepts both `wftrigger:<workflowId>` (pre-multi
 *   alarms) and `wftrigger:<workflowId>:<triggerId>`.
 *
 * Chrome-free: `background/workflow-triggers.ts`, validation and the Runner may
 * all import it.
 *
 * @module lib/workflow/triggers
 */

import type { OfferedTriggerType } from './trigger-options'
import type { Workflow, WorkflowNode, WorkflowTrigger } from './types'

/**
 * The trigger-block fields each kind owns. Switching kinds clears the other
 * kinds' fields so a node never carries two triggers' parameters at once.
 *
 * `time` is shared by the two time-of-day kinds. Fields that are not required
 * to fire (`delay`, `isUrlRegex`, `contextTypes`, `activeInInput`) are still
 * listed: they belong to exactly one kind, and leaving them behind would make a
 * reader (or Automa, on export) believe the wrong trigger is configured.
 */
export const TRIGGER_KIND_FIELDS: Readonly<Record<OfferedTriggerType, readonly string[]>> = {
  manual: [],
  'on-startup': [],
  'keyboard-shortcut': ['shortcut', 'activeInInput'],
  'context-menu': ['contextMenuName', 'contextTypes'],
  'visit-web': ['url', 'isUrlRegex'],
  interval: ['interval', 'delay'],
  'specific-day': ['days', 'time'],
  date: ['date', 'time'],
  // A nested object: the observer's element, URL scope and mutation options all
  // live under it, and the picker writes the whole payload at once.
  'element-change': ['observeElement'],
}

/** The stored id of the single-trigger shape; stable so alarm names do not churn. */
export const LEGACY_TRIGGER_SPEC_ID = 'primary'

/** One launch configuration of a workflow. */
export interface WorkflowTriggerSpec {
  /** Unique inside the workflow; the alarm-name suffix. Never contains ':'. */
  id: string
  /** `manual`, `interval`, … (`string` so imports keep kinds this build cannot arm). */
  type: string
  /** Defaults to true. A disabled spec is saved but never armed. */
  enabled?: boolean
  /** The kind's parameters, exactly the names in {@link TRIGGER_KIND_FIELDS}. */
  data: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every field any kind can own, used when clearing flat mirrors. */
function allTriggerFields(): Set<string> {
  return new Set(Object.values(TRIGGER_KIND_FIELDS).flat())
}

/** Whether this node is the graph's launch trigger. */
export function isTriggerNode(node: WorkflowNode): boolean {
  return (node.data?.['blockId'] as string) === 'trigger' || node.label === 'trigger'
}

function defaultObserveElement(): Record<string, unknown> {
  return {
    selector: '',
    baseSelector: '',
    matchPattern: '',
    targetOptions: {
      subtree: false,
      childList: true,
      attributes: false,
      attributeFilter: [],
      characterData: false,
    },
    baseElOptions: {
      subtree: false,
      childList: true,
      attributes: false,
      attributeFilter: [],
      characterData: false,
    },
  }
}

function defaultDataFor(type: string): Record<string, unknown> {
  switch (type) {
    case 'interval':
      return { interval: 60, delay: 5 }
    case 'date':
      return { date: '', time: '00:00' }
    case 'specific-day':
      return { days: [], time: '00:00' }
    case 'visit-web':
      return { url: '', isUrlRegex: false }
    case 'keyboard-shortcut':
      return { shortcut: '', activeInInput: false }
    case 'context-menu':
      return { contextMenuName: '', contextTypes: [] }
    case 'element-change':
      return { observeElement: defaultObserveElement() }
    default:
      return {}
  }
}

let specSeq = 0

/** A fresh spec with the kind's defaults, ready to be appended to the list. */
export function newTriggerSpec(type: string): WorkflowTriggerSpec {
  specSeq += 1
  return {
    id: `t${Date.now().toString(36)}${specSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    type,
    enabled: true,
    data: defaultDataFor(type),
  }
}

function normalizeSpec(value: unknown, index: number): WorkflowTriggerSpec | null {
  if (!isRecord(value)) return null
  const rawType = value['type']
  const type = typeof rawType === 'string' && rawType.trim() ? rawType.trim() : 'manual'
  const nested = isRecord(value['data']) ? value['data'] : {}
  const rawId = value['id']
  // A missing id gets an INDEX-based one rather than a random one: alarm names
  // are derived from it, and re-normalizing the same graph must not re-key them.
  const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : `spec-${index}`
  const enabled =
    typeof value['enabled'] === 'boolean'
      ? value['enabled']
      : typeof nested['enabled'] === 'boolean'
        ? nested['enabled']
        : true
  return { id: id.replace(/:/g, '-'), type, enabled, data: { ...nested } }
}

/**
 * Read a trigger block (and, for legacy graphs, the top-level mirror) as a
 * non-empty spec list. The first entry is the primary trigger.
 */
export function normalizeTriggers(
  nodeData: Record<string, unknown> | undefined,
  mirror?: WorkflowTrigger,
): WorkflowTriggerSpec[] {
  const raw = nodeData?.['triggers']
  if (Array.isArray(raw)) {
    const specs = raw
      .map((entry, index) => normalizeSpec(entry, index))
      .filter((spec): spec is WorkflowTriggerSpec => spec !== null)
    if (specs.length > 0) return specs
  }

  const rawType = nodeData?.['type'] ?? mirror?.type
  const type = typeof rawType === 'string' && rawType ? rawType : 'manual'
  const fields = TRIGGER_KIND_FIELDS[type as OfferedTriggerType] ?? []
  const data: Record<string, unknown> = {}
  for (const field of fields) {
    const fromNode = nodeData?.[field]
    if (fromNode !== undefined) {
      data[field] = fromNode
      continue
    }
    // The two kinds that carry a field on the top-level mirror.
    if (field === 'url' && mirror?.urlPattern) data[field] = mirror.urlPattern
    if (field === 'contextMenuName' && mirror?.menuItemId) data[field] = mirror.menuItemId
  }
  const enabled =
    typeof nodeData?.['enabled'] === 'boolean'
      ? (nodeData['enabled'] as boolean)
      : mirror?.enabled !== false
  return [{ id: LEGACY_TRIGGER_SPEC_ID, type, enabled, data }]
}

/** The mirror-driving first entry. */
export function primaryTrigger(specs: readonly WorkflowTriggerSpec[]): WorkflowTriggerSpec {
  return specs[0] ?? { id: LEGACY_TRIGGER_SPEC_ID, type: 'manual', enabled: true, data: {} }
}

/** Every enabled spec of a workflow (the primary mirror when the graph is bare). */
export function enabledTriggers(workflow: Workflow): WorkflowTriggerSpec[] {
  return effectiveTriggers(workflow).filter((spec) => spec.enabled !== false)
}

/** All specs of a workflow, reading the trigger block and falling back to the mirror. */
export function effectiveTriggers(workflow: Workflow): WorkflowTriggerSpec[] {
  const node = workflow.drawflow?.nodes?.find(isTriggerNode)
  return normalizeTriggers(node?.data, workflow.trigger)
}

/** The trigger node of a workflow, when the graph has one. */
export function triggerNodeOf(workflow: Workflow): WorkflowNode | undefined {
  return workflow.drawflow?.nodes?.find(isTriggerNode)
}

/**
 * Return a copy of the trigger node data carrying `specs`, with the primary
 * mirrored onto the legacy flat fields. `nodeData` is not mutated.
 *
 * `enabled` is only written when it was already present or is false, so a
 * legacy node that never had the flag does not suddenly grow one.
 */
export function writeTriggers(
  nodeData: Record<string, unknown> | undefined,
  specs: readonly WorkflowTriggerSpec[],
): Record<string, unknown> {
  const list = specs.length > 0 ? specs : [newTriggerSpec('manual')]
  const primary = list[0]!
  const next: Record<string, unknown> = { ...nodeData }

  for (const field of allTriggerFields()) delete next[field]
  const owned = TRIGGER_KIND_FIELDS[primary.type as OfferedTriggerType] ?? []
  for (const field of owned) {
    const value = primary.data[field]
    if (value !== undefined) next[field] = value
  }
  next['type'] = primary.type
  if (primary.enabled === false) next['enabled'] = false
  else if (nodeData && 'enabled' in nodeData) next['enabled'] = true

  next['triggers'] = list.map((spec) => ({
    id: spec.id,
    type: spec.type,
    ...(typeof spec.enabled === 'boolean' ? { enabled: spec.enabled } : {}),
    data: { ...spec.data },
  }))
  return next
}

// --- Alarm names ------------------------------------------------------------

export const WORKFLOW_TRIGGER_ALARM_PREFIX = 'wftrigger:'

/** `wftrigger:<workflowId>:<triggerId>`; omitting the id yields the legacy name. */
export function workflowTriggerAlarmName(workflowId: string, triggerId?: string): string {
  return triggerId
    ? `${WORKFLOW_TRIGGER_ALARM_PREFIX}${workflowId}:${triggerId}`
    : `${WORKFLOW_TRIGGER_ALARM_PREFIX}${workflowId}`
}

/** True when an alarm name belongs to a scheduled workflow trigger. */
export function isWorkflowTriggerAlarm(name: string): boolean {
  return name.startsWith(WORKFLOW_TRIGGER_ALARM_PREFIX)
}

/**
 * Split an alarm name. A name without a trigger id is the pre-multi shape and
 * resolves to the workflow's PRIMARY trigger — such an alarm must keep firing
 * until `rescheduleAllWorkflowTriggers` replaces it.
 */
export function parseTriggerAlarmName(
  name: string,
): { workflowId: string; triggerId?: string } | null {
  if (!isWorkflowTriggerAlarm(name)) return null
  const rest = name.slice(WORKFLOW_TRIGGER_ALARM_PREFIX.length)
  if (!rest) return null
  const colon = rest.indexOf(':')
  if (colon === -1) return { workflowId: rest }
  const workflowId = rest.slice(0, colon)
  const triggerId = rest.slice(colon + 1)
  if (!workflowId) return null
  return triggerId ? { workflowId, triggerId } : { workflowId }
}
