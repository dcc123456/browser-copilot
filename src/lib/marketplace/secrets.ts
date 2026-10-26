/**
 * Credentials that travel with a published workflow.
 *
 * A `get-secret` step stores `<credentialId>::<fieldKey>` — the PUBLISHER's
 * local id, which resolves to nothing on the applying machine. Publishing
 * therefore exports the referenced fields (and only those), and applying
 * imports them into the local vault and rewrites the references, so neither
 * the parent workflow nor a bundled sub-workflow asks for a credential again.
 *
 * Value policy: a password-style field is published EMPTY (committing a live
 * password to public git would be irreversible); every other field carries the
 * publisher's value so the workflow runs on arrival. The dialog lets the user
 * edit both before publishing, and a non-empty password raises a warning.
 *
 * Pure and chrome-free: the panel supplies vault entries, the tests supply
 * fixtures, and both hosts read the same rules.
 *
 * @module lib/marketplace/secrets
 */

import { entryFields, type PasswordEntry, type SecretField } from '../types'
import { nodeBlockId, nodeParams } from '../workflow/node-params'
import {
  credentialRefOf,
  SECRET_PRODUCER_BLOCK,
  secretRequestsOf,
  secretRowsPatch,
  type SecretRow,
} from '../workflow/secret-params'
import type { Workflow, WorkflowNode } from '../workflow/types'
import {
  MAX_LISTING_SECRETS,
  MAX_LISTING_SECRET_FIELDS,
  MAX_SECRET_ID_CHARS,
  MAX_SECRET_KEY_CHARS,
  MAX_SECRET_LABEL_CHARS,
  MAX_SECRET_VALUE_CHARS,
  MarketplaceError,
  type MarketplaceSecret,
  type MarketplaceSecretField,
} from './types'

/** One credential the published graph references, with the fields it needs. */
export interface SecretReference {
  credentialId: string
  /** Field keys named by `get-secret` rows, in first-seen order. */
  fields: string[]
  /**
   * A row named the credential without a field. The executor then falls back to
   * `password` → first field, so every field has to travel.
   */
  anyField: boolean
}

/** Deterministic local id for a credential a listing brought along. */
export function marketplaceSecretId(slug: string, sourceId: string): string {
  return `mkt-${slug}-${sourceId}`
}

/** Every `get-secret` reference across the given graphs, in first-seen order. */
export function collectSecretRefs(workflows: readonly Workflow[]): SecretReference[] {
  const byId = new Map<string, { fields: string[]; anyField: boolean }>()
  for (const workflow of workflows) {
    for (const node of workflow.drawflow.nodes) {
      if (nodeBlockId(node) !== SECRET_PRODUCER_BLOCK) continue
      for (const request of secretRequestsOf(nodeParams(node))) {
        const entry = byId.get(request.credentialId) ?? { fields: [], anyField: false }
        if (request.fieldKey) {
          if (!entry.fields.includes(request.fieldKey)) entry.fields.push(request.fieldKey)
        } else {
          entry.anyField = true
        }
        byId.set(request.credentialId, entry)
      }
    }
  }
  return Array.from(byId, ([credentialId, entry]) => ({ credentialId, ...entry }))
}

/** The vault fields a reference needs, in the vault's order. */
export function referencedFields(
  reference: SecretReference,
  fields: readonly SecretField[],
): SecretField[] {
  return reference.anyField
    ? [...fields]
    : fields.filter((field) => reference.fields.includes(field.key))
}

export interface PublishedSecretsPlan {
  /** The records the dialog edits and `preparePublish` receives. */
  secrets: MarketplaceSecret[]
  /** Referenced credentials the local vault cannot satisfy. */
  missing: string[]
}

/**
 * Builds the default published records for a publish in progress.
 *
 * Password fields start empty, everything else starts at the local value. A
 * referenced credential that is absent locally (or lacks a named field) is
 * reported instead of published half-filled: apply would install a step that
 * fails at run time with no way for the consumer to guess the name.
 */
export function planPublishedSecrets(
  workflows: readonly Workflow[],
  entries: readonly PasswordEntry[],
): PublishedSecretsPlan {
  const secrets: MarketplaceSecret[] = []
  const missing: string[] = []
  for (const reference of collectSecretRefs(workflows)) {
    const entry = entries.find((candidate) => candidate.id === reference.credentialId)
    const fields = entry ? referencedFields(reference, entryFields(entry)) : []
    if (!entry || fields.length === 0) {
      missing.push(reference.credentialId)
      continue
    }
    secrets.push({
      id: entry.id,
      label: entry.label,
      ...(entry.url ? { url: entry.url } : {}),
      fields: fields.map((field) => ({
        key: field.key,
        value: field.secret ? '' : field.value,
        ...(field.secret ? { secret: true } : {}),
      })),
    })
  }
  return { secrets, missing }
}

/** Key an edited value is stored under between the dialog and its draft. */
export function secretValueKey(credentialId: string, fieldKey: string): string {
  return `${credentialId}::${fieldKey}`
}

/** Applies dialog edits on top of the planned defaults. */
export function applySecretOverrides(
  secrets: readonly MarketplaceSecret[],
  overrides: Readonly<Record<string, string>>,
): MarketplaceSecret[] {
  return secrets.map((secret) => ({
    ...secret,
    fields: secret.fields.map((field) => {
      const edited = overrides[secretValueKey(secret.id, field.key)]
      return edited === undefined ? field : { ...field, value: edited }
    }),
  }))
}

/**
 * The records `preparePublish` is allowed to commit.
 *
 * Only referenced credentials and referenced fields survive — a dialog cannot
 * smuggle an unrelated vault entry into a public repository — and a reference
 * the records do not cover blocks the publish with the missing ids named.
 */
export function normalizePublishedSecrets(
  references: readonly SecretReference[],
  provided: readonly MarketplaceSecret[],
): MarketplaceSecret[] {
  if (references.length === 0) return []
  if (references.length > MAX_LISTING_SECRETS) {
    throw new MarketplaceError(
      'invalid',
      `A listing can carry at most ${MAX_LISTING_SECRETS} credentials`,
    )
  }
  const out: MarketplaceSecret[] = []
  const missing: string[] = []
  let fieldCount = 0
  for (const reference of references) {
    const source = provided.find((secret) => secret.id === reference.credentialId)
    const fields = source ? fillFields(reference, source.fields) : []
    if (!source || fields.length === 0) {
      missing.push(reference.credentialId)
      continue
    }
    fieldCount += fields.length
    out.push({
      id: source.id.trim().slice(0, MAX_SECRET_ID_CHARS),
      label: source.label.trim().slice(0, MAX_SECRET_LABEL_CHARS) || source.id,
      ...(source.url?.trim() ? { url: source.url.trim() } : {}),
      fields,
    })
  }
  if (missing.length > 0) {
    throw new MarketplaceError('invalid', `Credentials are missing: ${missing.join(', ')}`)
  }
  if (fieldCount > MAX_LISTING_SECRET_FIELDS) {
    throw new MarketplaceError(
      'invalid',
      `A listing can carry at most ${MAX_LISTING_SECRET_FIELDS} credential fields`,
    )
  }
  return out
}

function fillFields(
  reference: SecretReference,
  fields: readonly MarketplaceSecretField[],
): MarketplaceSecretField[] {
  const wanted = reference.anyField
    ? [...fields]
    : fields.filter((field) => reference.fields.includes(field.key))
  return wanted.map((field) => ({
    key: field.key.trim().slice(0, MAX_SECRET_KEY_CHARS),
    value: field.value.slice(0, MAX_SECRET_VALUE_CHARS),
    ...(field.secret ? { secret: true } : {}),
  }))
}

/** Password fields the publisher actually filled — worth a confirmation. */
export function filledPasswordFields(
  secrets: readonly MarketplaceSecret[],
): MarketplaceSecretField[] {
  return secrets.flatMap((secret) =>
    secret.fields.filter((field) => field.secret && field.value !== ''),
  )
}

export interface SecretImportPlan {
  /** Vault records to save BEFORE any workflow. */
  entries: PasswordEntry[]
  /** Published credential id → local credential id. */
  idMap: Map<string, string>
}

/**
 * Merges the listing's credentials into the local vault.
 *
 * An existing record keeps its values, usage counters and creation time: the
 * user may have typed the real password after the first install, and a later
 * update must not replace it with the (empty) published default. Only fields
 * the vault does not have yet are added.
 */
export function planSecretImport(
  slug: string,
  secrets: readonly MarketplaceSecret[] | undefined,
  existing: readonly PasswordEntry[],
  now = Date.now(),
): SecretImportPlan {
  const entries: PasswordEntry[] = []
  const idMap = new Map<string, string>()
  for (const secret of secrets ?? []) {
    if (!secret.id || secret.fields.length === 0) continue
    const id = marketplaceSecretId(slug, secret.id)
    idMap.set(secret.id, id)
    const current = existing.find((candidate) => candidate.id === id)
    const published: SecretField[] = secret.fields.map((field) => ({
      key: field.key,
      value: field.value,
      ...(field.secret ? { secret: true } : {}),
    }))
    if (current) {
      const fields = entryFields(current).map((field) => ({ ...field }))
      for (const field of published) {
        const known = fields.some(
          (candidate) => candidate.key.trim().toLowerCase() === field.key.trim().toLowerCase(),
        )
        if (!known) fields.push(field)
      }
      entries.push({ ...current, fields, updatedAt: now })
    } else {
      entries.push({
        id,
        label: secret.label.trim() || 'Credential',
        ...(secret.url ? { url: secret.url } : {}),
        fields: published,
        createdAt: now,
        updatedAt: now,
        useCount: 0,
      })
    }
  }
  return { entries, idMap }
}

/** Points every `get-secret` row in the graph at the imported credential. */
export function rewriteWorkflowSecrets(
  workflow: Workflow,
  idMap: ReadonlyMap<string, string>,
): Workflow {
  if (idMap.size === 0) return workflow
  let changed = false
  const nodes = workflow.drawflow.nodes.map((node) => {
    if (nodeBlockId(node) !== SECRET_PRODUCER_BLOCK) return node
    const requests = secretRequestsOf(nodeParams(node))
    if (requests.length === 0) return node
    let nodeChanged = false
    const rows: SecretRow[] = requests.map((request) => {
      const mapped = idMap.get(request.credentialId) ?? request.credentialId
      if (mapped !== request.credentialId) nodeChanged = true
      return {
        credential: credentialRefOf({ credentialId: mapped, fieldKey: request.fieldKey }),
        variableName: request.variableName,
      }
    })
    if (!nodeChanged) return node
    changed = true
    return withSecretRows(node, rows)
  })
  return changed ? { ...workflow, drawflow: { ...workflow.drawflow, nodes } } : workflow
}

/**
 * Writes the rows where the RUN reads them: `data.values` when the node uses
 * that container, otherwise the node data root. The legacy `secretId` /
 * `fieldName` pair is cleared in both cases so a later reader cannot see two
 * versions of the same fact.
 */
function withSecretRows(node: WorkflowNode, rows: readonly SecretRow[]): WorkflowNode {
  const data = node.data ?? {}
  const patch = secretRowsPatch(rows)
  const values = data['values']
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    return {
      ...node,
      data: {
        ...data,
        secretId: undefined,
        fieldName: undefined,
        values: { ...(values as Record<string, unknown>), ...patch },
      },
    }
  }
  return { ...node, data: { ...data, ...patch } }
}
