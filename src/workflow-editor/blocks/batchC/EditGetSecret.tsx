/**
 * EditGetSecret — edit form for the local `get-secret` block.
 *
 * The block fetches a stored credential field at RUNTIME and stores its value
 * in a workflow variable. Unlike embedding the literal value, this approach:
 *   - Never stores the secret in the workflow definition
 *   - Picks up credential updates automatically on each run
 *   - Follows the same pattern as `ai-agent` and `ocr` blocks that produce
 *     variables for downstream blocks to consume
 *
 * The form lets the user pick a (credential · field) pair from their stored
 * secrets via a single dropdown, plus the output variable name. The selected
 * value is encoded as `"<secretId>::<fieldKey>"` so the executor can resolve
 * both halves without an extra data field.
 *
 * @module workflow-editor/blocks/batchC/EditGetSecret
 */

import { useEffect, useState } from 'react'
import { Field, Select, TextArea, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'
import { useEditorLocale } from '../../locale-context'
import { listPasswords } from '../../../lib/storage'
import type { PasswordEntry } from '../../../lib/types'
import type { EditFormProps } from '../EditForms'

/** A combined "<secretId>::<fieldKey>" reference into the user's stored
 *  secrets. Empty string means "no credential selected yet". The same encoding
 *  is parsed by the executor in src/background/workflow-engine/executors.ts. */
type CredentialRef = string

export default function EditGetSecret({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const [entries, setEntries] = useState<PasswordEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void listPasswords()
      .then((list) => {
        if (!cancelled) setEntries(list)
      })
      .catch(() => {
        if (!cancelled) setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Build dropdown options: one entry per (credential · field) pair. The label
  // shows the user-friendly credential name + field key so they can recognise
  // it without staring at ids.
  const options =
    entries?.flatMap((entry) =>
      (Array.isArray(entry.fields) ? entry.fields : [])
        .filter((f) => f && typeof f.key === 'string' && f.key.length > 0)
        .map((f) => ({
          value: `${entry.id}::${f.key}`,
          label: `${entry.label} · ${f.key}`,
        })),
    ) ?? []

  const credential = str(data, 'credential')

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Credential">
        {entries === null ? (
          <div className="text-xs text-muted">{bt('Loading credentials…')}</div>
        ) : options.length > 0 ? (
          <Select
            value={credential}
            onChange={(v) => onChange({ credential: v })}
            options={options}
          />
        ) : (
          <div className="text-xs text-muted">
            {bt('No credentials configured yet. Add one in Settings → Secrets.')}
          </div>
        )}
      </Field>

      <Field label="Output variable name">
        <TextInput
          value={str(data, 'variableName')}
          placeholder="Required — e.g. apiKey"
          onChange={(v) => onChange({ variableName: v })}
        />
      </Field>

      <div className="mt-2 text-xs text-muted">
        {bt(
          'The secret value is fetched at runtime and never stored in the workflow. Downstream blocks can reference it via {{variable name}}.',
        )}
      </div>
    </div>
  )
}

// Type re-export so the executor can import the same CredentialRef type if it
// wants to mirror the form's encoding.
export type { CredentialRef }