/**
 * The `get-secret` block's credential data model.
 *
 * One node fetches one or MORE stored credential fields at run time and writes
 * each into its own session variable, so a workflow that needs three keys is one
 * node instead of three. Values never enter the workflow definition — only the
 * `<credentialId>::<fieldKey>` reference and the output name do.
 *
 * Two shapes are stored, and every consumer must read through
 * {@link secretRequestsOf} rather than poking `data.credential`:
 *
 *   - `{ credential, variableName }`                     — one row (also what the
 *     AI operator and the history→workflow path still write);
 *   - `{ credential, variableName, credentials: [...] }` — several rows, where the
 *     flat pair MIRRORS the first one (see specs/2026-10-16-get-secret-multi-credential-design.md §2).
 *
 * The mirror is not a compatibility shim: `variableName` is the cross-block name
 * for "what this node writes", so keeping row 1 there is what lets the save-time
 * reference checks, the provenance index and the tool schema work without a
 * migration pass over workflows that already live in storage.
 *
 * `integrity`, `producer-completeness`, `generated-validation` and both hosts'
 * executors read this module, so it stays chrome-free AND host-free: no
 * `chrome.*`, no `process.env` (the Runner reads the environment itself).
 *
 * @module lib/workflow/secret-params
 */

import { sanitizeName } from './dynamic-data'

/** One half-pair of a stored credential: which credential, which field. */
export interface SecretFieldRef {
  credentialId: string
  fieldKey: string
}

/** One row of a `get-secret` node: a credential reference and where to store it. */
export interface SecretRequest extends SecretFieldRef {
  /** Empty when the row has no output name yet — kept, never silently dropped. */
  variableName: string
}

/** Block that writes credentials into variables. */
export const SECRET_PRODUCER_BLOCK = 'get-secret'

/** Separator the `get-secret` block uses to encode a credential reference. */
export const CREDENTIAL_SEPARATOR = '::'

/** `get-secret` stores `<credentialId>::<fieldKey>` in its `credential` param. */
export function credentialRefOf(ref: SecretFieldRef): string {
  return `${ref.credentialId}${CREDENTIAL_SEPARATOR}${ref.fieldKey}`
}

/** Parse a `credential` param back, or `null` when it is not a credential ref. */
export function parseCredentialRef(value: unknown): SecretFieldRef | null {
  if (typeof value !== 'string') return null
  const at = value.indexOf(CREDENTIAL_SEPARATOR)
  if (at <= 0 || at === value.length - CREDENTIAL_SEPARATOR.length) return null
  const credentialId = value.slice(0, at)
  const fieldKey = value.slice(at + CREDENTIAL_SEPARATOR.length)
  return credentialId && fieldKey ? { credentialId, fieldKey } : null
}

/**
 * The variable name given to a freshly created `get-secret` producer.
 *
 * Matches the name the history→workflow conversion already mints
 * (`lib/storage`, `secret_<id>_<field>`) so a secret referenced from the picker
 * and one recorded from a live run look the same downstream. Both halves go
 * through {@link sanitizeName}: a credential id is user-supplied text, and a
 * name containing `.` or braces would silently become a path — or no token at all.
 */
export function secretVariableNameOf(ref: SecretFieldRef): string {
  return `secret_${sanitizeName(ref.credentialId)}_${sanitizeName(ref.fieldKey)}`
}

/**
 * The name the `get-secret` form pre-fills when a human picks a credential: the
 * field key itself, sanitized into a reference-safe variable name. The operator's
 * output name must never be left empty by an explicit choice, and the field stays
 * editable. {@link secretVariableNameOf} remains the collision-safe default for a
 * producer the `/` menu inserts on the user's behalf, where no human has picked a
 * name and `token` could silently shadow an existing variable.
 */
export function credentialVariableNameOf(ref: SecretFieldRef): string {
  return sanitizeName(ref.fieldKey)
}

/**
 * Split a stored `credential` param the way the RUN does: `id::field`, or a bare
 * `id` whose field falls down the executor's chain (`password`, then the first
 * field). Deliberately more lenient than {@link parseCredentialRef}, which needs
 * both halves to mint a collision-safe name; tightening this one would make a
 * "credential id only" node unparseable in the editor while it still runs.
 */
function splitCredentialParam(value: unknown): SecretFieldRef | null {
  if (typeof value !== 'string') return null
  const at = value.indexOf(CREDENTIAL_SEPARATOR)
  if (at === 0) return null
  if (at < 0) {
    const credentialId = value.trim()
    return credentialId ? { credentialId, fieldKey: '' } : null
  }
  const credentialId = value.slice(0, at).trim()
  if (!credentialId) return null
  return { credentialId, fieldKey: value.slice(at + CREDENTIAL_SEPARATOR.length).trim() }
}

/** The pre-dropdown shape: separate `secretId` + `fieldName` params. */
function legacyRefOf(data: Record<string, unknown>): SecretFieldRef | null {
  const credentialId = typeof data['secretId'] === 'string' ? data['secretId'].trim() : ''
  if (!credentialId) return null
  const fieldKey = typeof data['fieldName'] === 'string' ? data['fieldName'].trim() : ''
  return { credentialId, fieldKey }
}

function nameOf(data: Record<string, unknown>): string {
  return typeof data['variableName'] === 'string' ? data['variableName'].trim() : ''
}

/** One stored row (the flat pair, or one entry of `credentials`) read as a request. */
function requestOf(data: Record<string, unknown>): SecretRequest | null {
  const ref = splitCredentialParam(data['credential']) ?? legacyRefOf(data)
  if (!ref) return null
  return { credentialId: ref.credentialId, fieldKey: ref.fieldKey, variableName: nameOf(data) }
}

/**
 * Every credential row one `get-secret` node fetches, in run order, from
 * whichever shape it is stored in: the `credentials` list when it has rows,
 * otherwise the flat pair (falling back to the legacy `secretId`/`fieldName`).
 *
 * A row with no reference is dropped — it can only be an empty form row. A row
 * with no output name is KEPT with `variableName: ''`, because executing it must
 * fail loudly rather than skip a credential the workflow then references as empty.
 */
export function secretRequestsOf(data: Record<string, unknown> | undefined): SecretRequest[] {
  if (!data) return []
  const listed = data['credentials']
  const rows: Record<string, unknown>[] =
    Array.isArray(listed) && listed.length > 0
      ? listed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      : [data]
  const out: SecretRequest[] = []
  for (const row of rows) {
    const request = requestOf(row)
    if (request) out.push(request)
  }
  return out
}

/** One stored credential row in the shape a form edits and a patch writes. */
export interface SecretRow {
  credential: string
  variableName: string
}

/**
 * The node's rows in editable shape — normalised, so a form never has to know
 * which of the stored shapes it inherited. A bare-id reference (no `::field`,
 * resolved at run time by the executor's fallback chain) round-trips as
 * `<id>::`, which {@link secretRequestsOf} reads back the same way.
 */
export function secretRowsOf(data: Record<string, unknown> | undefined): SecretRow[] {
  return secretRequestsOf(data).map((request) => ({
    credential: credentialRefOf(request),
    variableName: request.variableName,
  }))
}

/**
 * The node's data patch for a full set of rows — the ONE writer of the shape.
 *
 * One row: flat pair only. Several rows: the list holds ALL of them and the flat
 * pair mirrors row 1, so a consumer that still reads `variableName` sees a real
 * producer instead of a node that writes nothing.
 *
 * The pre-dropdown `secretId` / `fieldName` params are cleared on every write:
 * the rows are the truth after this patch, and leaving a second source of the
 * same fact behind is how a later reader ends up disagreeing with the editor.
 */
export function secretRowsPatch(rows: readonly SecretRow[]): Record<string, unknown> {
  const [first] = rows
  const credential = first?.credential ?? ''
  const variableName = first?.variableName ?? ''
  const cleared: Record<string, unknown> = { secretId: undefined, fieldName: undefined }
  return rows.length > 1
    ? {
        ...cleared,
        credential,
        variableName,
        credentials: rows.map((row) => ({ ...row })),
      }
    : { ...cleared, credential, variableName, credentials: undefined }
}

/** Names a node of rows publishes, blank ones excluded — what references resolve to. */
export function secretVariableNamesOf(data: Record<string, unknown> | undefined): string[] {
  return secretRequestsOf(data)
    .map((request) => request.variableName)
    .filter((name) => name !== '')
}

/**
 * The environment variable a headless Runner reads one credential row from:
 * `BC_SECRET_<CREDENTIAL_ID>[_<FIELD_KEY>]`, upper-cased with every non
 * alphanumeric byte replaced by `_`. Punctuation-only differences between two
 * credential ids collide here (accepted: the extension's ids are slugs, and the
 * failure mode is "same value", not "no value").
 */
export function secretEnvNameOf(ref: { credentialId: string; fieldKey?: string }): string {
  const segments = [ref.credentialId, ...(ref.fieldKey ? [ref.fieldKey] : [])]
  return `BC_SECRET_${segments.map(envSegment).join('_')}`
}

function envSegment(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
}
