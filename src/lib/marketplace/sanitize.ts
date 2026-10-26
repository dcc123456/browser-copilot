/**
 * Turns a local workflow into the bytes that will be committed publicly.
 *
 * Publishing is one-way: once a PR is merged the JSON is in public git history
 * forever. Every local-only field (ids, timestamps, folders, revision history)
 * and every runtime artifact (run logs, page anchors, trial records, embedded
 * screenshots) is removed here — not in the dialog, so the rule is testable and
 * cannot drift from the UI.
 *
 * @module lib/marketplace/sanitize
 */

import type { Workflow, WorkflowSettings, WorkflowTrigger } from '../workflow/types'
import { nodeBlockId } from '../workflow/node-params'
import { SECRET_PRODUCER_BLOCK } from '../workflow/secret-params'
import { MarketplaceError, MAX_DESCRIPTION_CHARS, MAX_WORKFLOW_JSON_BYTES } from './types'

/** One thing the user must look at before the publish is allowed through. */
export interface PublishWarning {
  kind: 'credential-literal' | 'embedded-data' | 'secret-value'
  nodeLabel: string
  /** Dotted path inside the node's `data`, e.g. `secret.password`. */
  param: string
  /**
   * Display name of the bundled workflow the node belongs to. Unset for the
   * workflow being published, which the dialog already names.
   */
  workflow?: string
}

/** The exact shape written to `workflow.json`. */
export interface PublishableWorkflow {
  id: string
  name: string
  description?: string
  drawflow: Workflow['drawflow']
  trigger?: WorkflowTrigger
  settings: WorkflowSettings
}

export interface SanitizeResult {
  workflow: PublishableWorkflow
  warnings: PublishWarning[]
}

const PUBLISHED_SETTINGS: WorkflowSettings = {
  saveLog: false,
  debugMode: false,
  notification: false,
  reuseLastState: false,
}

/** Runtime fields that have no meaning to another machine. */
const DROPPED_NODE_KEYS = new Set([
  'runLog',
  'lastRun',
  'lastResult',
  'lastOutput',
  'lastError',
  'logs',
  'trace',
  'executionTrace',
  'checkpoint',
  'debugInfo',
])

const EMBEDDED_DATA_RE = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i
const CREDENTIAL_KEY_RE = /(pass(word)?|secret|token|api[-_]?key|cookie|credential)/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Warnings are deduplicated so one bad param cannot fill the dialog. */
class WarningSet {
  private readonly seen = new Set<string>()
  private readonly items: PublishWarning[] = []

  add(warning: PublishWarning): void {
    const key = `${warning.kind}|${warning.nodeLabel}|${warning.param}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.items.push(warning)
  }

  list(): PublishWarning[] {
    return this.items
  }
}

/**
 * Recursively cleans one node's `data`. Embedded data URLs become empty
 * strings (the step keeps its shape; the payload does not leave the machine).
 *
 * `referencesCredentials` is set for `get-secret` nodes: their `credential`
 * param is a `<id>::<field>` REFERENCE, not a typed-in literal, so warning
 * about it would train the publisher to click through real warnings. The
 * values those steps fetch travel separately, through `meta.secrets`.
 */
function cleanValue(
  value: unknown,
  path: string,
  nodeLabel: string,
  warnings: WarningSet,
  referencesCredentials = false,
): unknown {
  if (typeof value === 'string') {
    if (EMBEDDED_DATA_RE.test(value.trim())) {
      warnings.add({ kind: 'embedded-data', nodeLabel, param: path })
      return ''
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      cleanValue(item, `${path}[${index}]`, nodeLabel, warnings, referencesCredentials),
    )
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (DROPPED_NODE_KEYS.has(key)) continue
      const childPath = path ? `${path}.${key}` : key
      // A literal password typed into a form block is the one thing a reviewer
      // cannot see in a diff review of JSON. Credential REFERENCES
      // (`{{password}}`) are safe and stay quiet.
      if (
        !referencesCredentials &&
        typeof child === 'string' &&
        child.trim() &&
        !child.includes('{{') &&
        CREDENTIAL_KEY_RE.test(key)
      ) {
        warnings.add({ kind: 'credential-literal', nodeLabel, param: childPath })
      }
      out[key] = cleanValue(child, childPath, nodeLabel, warnings, referencesCredentials)
    }
    return out
  }
  return value
}

/** Keeps only trigger fields that describe behaviour, never local state. */
function cleanTrigger(trigger: WorkflowTrigger): WorkflowTrigger {
  const cleaned: WorkflowTrigger = { type: trigger.type, enabled: false }
  if (trigger.schedule) cleaned.schedule = trigger.schedule
  if (trigger.urlPattern) cleaned.urlPattern = trigger.urlPattern
  if (trigger.parameters) cleaned.parameters = structuredClone(trigger.parameters)
  return cleaned
}

/**
 * Builds the publish payload. Throws when the result is too large to live in a
 * repo file; the caller shows that as a normal validation error.
 */
export function toPublishableWorkflow(workflow: Workflow, slug: string): SanitizeResult {
  const warnings = new WarningSet()
  const nodes = workflow.drawflow.nodes.map((node) => {
    const nodeLabel = node.label || node.id
    const referencesCredentials = nodeBlockId(node) === SECRET_PRODUCER_BLOCK
    return {
      ...node,
      data: cleanValue(node.data, '', nodeLabel, warnings, referencesCredentials) as Record<
        string,
        unknown
      >,
    }
  })
  const description = workflow.description?.trim().slice(0, MAX_DESCRIPTION_CHARS)
  const publishable: PublishableWorkflow = {
    id: slug,
    name: workflow.name || 'Workflow',
    ...(description ? { description } : {}),
    drawflow: {
      nodes,
      edges: structuredClone(workflow.drawflow.edges),
    },
    ...(workflow.trigger ? { trigger: cleanTrigger(workflow.trigger) } : {}),
    settings: PUBLISHED_SETTINGS,
  }
  const bytes = new TextEncoder().encode(JSON.stringify(publishable, null, 2)).length
  if (bytes > MAX_WORKFLOW_JSON_BYTES) {
    throw new MarketplaceError(
      'invalid',
      `Workflow is too large to publish (${Math.ceil(bytes / 1024)} KB)`,
    )
  }
  return { workflow: publishable, warnings: warnings.list() }
}
