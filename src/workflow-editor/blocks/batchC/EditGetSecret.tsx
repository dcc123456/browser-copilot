/**
 * EditGetSecret — edit form for the local `get-secret` block.
 *
 * The block fetches stored credential fields at RUNTIME and stores each value
 * in its own workflow variable. Unlike embedding the literal value, this
 * approach:
 *   - Never stores the secret in the workflow definition
 *   - Picks up credential updates automatically on each run
 *   - Follows the same pattern as `ai-agent` and `ocr` blocks that produce
 *     variables for downstream blocks to consume
 *
 * One node fetches ONE OR SEVERAL credentials: the form is a row list, each row
 * a (credential · output variable) pair. The rows round-trip through
 * `lib/workflow/secret-params` (`secretRowsOf` / `secretRowsPatch`), which owns
 * the stored shape — including the first row's mirror into `credential` /
 * `variableName` that the rest of the graph analysis reads.
 *
 * The dropdown only ever lists METADATA (`label · fieldKey`); a secret value
 * never enters this form, the editor state, or the workflow.
 *
 * @module workflow-editor/blocks/batchC/EditGetSecret
 */

import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Field, Select, TextArea, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'
import { useEditorLocale } from '../../locale-context'
import {
  credentialVariableNameOf,
  parseCredentialRef,
  secretRowsOf,
  secretRowsPatch,
  type SecretRow,
} from '../../../lib/workflow/secret-params'
import { listPasswords } from '../../../lib/storage'
import { onStoreChanged } from '../../../lib/store-events'
import type { PasswordEntry } from '../../../lib/types'
import type { EditFormProps } from '../EditForms'

/** A blank row: what "add a credential" starts with, and what an empty node shows. */
const EMPTY_ROW: SecretRow = { credential: '', variableName: '' }

/** The dropdown's "no choice yet" entry, so an unset row does not display another credential. */
const UNSET_OPTION = { value: '', label: 'Pick a credential…' }

/** A row the node can store and the run can execute: it names a credential. */
function isFilledRow(row: SecretRow): boolean {
  return row.credential.trim() !== ''
}

/** Rows are equal in the two fields the node keeps. */
function sameRows(a: SecretRow[], b: SecretRow[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (row, i) => row.credential === b[i]?.credential && row.variableName === b[i]?.variableName,
    )
  )
}

/**
 * The rows to render. A blank row is not a credential request, so the stored
 * shape drops it and the node hands back fewer rows than the operator sees —
 * which made "add a credential" look dead. The draft keeps the working rows (an
 * empty one, a name typed before the credential is picked) and is discarded as
 * soon as it no longer stores what the node holds, so a patch from outside this
 * form (an AI fix, the `/` menu) replaces it instead of losing to it.
 */
function workingRowsOf(
  draft: SecretRow[] | null,
  stored: SecretRow[],
  legacyName: string,
): SecretRow[] {
  if (
    draft !== null &&
    sameRows(secretRowsOf(secretRowsPatch(draft.filter(isFilledRow))), stored)
  ) {
    return draft
  }
  return stored.length > 0 ? stored : [{ credential: '', variableName: legacyName }]
}

export default function EditGetSecret({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const [entries, setEntries] = useState<PasswordEntry[] | null>(null)
  // A marketplace apply imports credentials while this editor may already be
  // open in another tab; the dropdown has to pick them up without a reload.
  const [vaultVersion, setVaultVersion] = useState(0)

  useEffect(() => onStoreChanged('passwords', () => setVaultVersion((version) => version + 1)), [])

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
  }, [vaultVersion])

  // One option per (credential · field) pair. The label shows the friendly
  // credential name + field key so they can recognise it without staring at ids.
  const options =
    entries?.flatMap((entry) =>
      (Array.isArray(entry.fields) ? entry.fields : [])
        .filter((f) => f && typeof f.key === 'string' && f.key.length > 0)
        .map((f) => ({
          value: `${entry.id}::${f.key}`,
          label: `${entry.label} · ${f.key}`,
        })),
    ) ?? []

  // A row the operator named but has not picked a credential for parses to
  // nothing, so `secretRowsOf` drops it — the draft in `workingRowsOf` is what
  // keeps such a row (and a freshly added empty one) on screen.
  const stored = secretRowsOf(data)
  const [draft, setDraft] = useState<SecretRow[] | null>(null)
  const rows = workingRowsOf(draft, stored, str(data, 'variableName'))

  const commit = (next: SecretRow[]): void => {
    // Dropping the last row leaves the form on one blank row: that is what an
    // unset node shows, and it is what "add" appends to.
    setDraft(next.length > 0 ? next : [EMPTY_ROW])
    onChange(secretRowsPatch(next.filter(isFilledRow)))
  }
  const addRow = (): void => commit([...rows, EMPTY_ROW])
  const removeRow = (index: number): void => commit(rows.filter((_, i) => i !== index))
  const setName = (index: number, variableName: string): void =>
    commit(rows.map((row, i) => (i === index ? { ...row, variableName } : row)))

  /**
   * Picking a credential names that row's output after the field. A name the
   * operator typed by hand is left alone; a name this form generated for the
   * row's PREVIOUS credential follows the new choice.
   */
  const pickCredential = (index: number, value: string): void => {
    const row = rows[index] ?? EMPTY_ROW
    const previous = parseCredentialRef(row.credential)
    const next = parseCredentialRef(value)
    const generated = previous ? credentialVariableNameOf(previous) : ''
    const variableName =
      next && (row.variableName === '' || row.variableName === generated)
        ? credentialVariableNameOf(next)
        : row.variableName
    commit(
      rows.map((item, i) => (i === index ? { ...item, credential: value, variableName } : item)),
    )
  }

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label={bt('Credentials this node fetches')}>
        {entries === null ? (
          <div className="text-xs text-muted">{bt('Loading credentials…')}</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows.map((row, index) => (
              <div
                className="flex flex-col gap-1 rounded-md border border-border bg-panel p-2"
                key={`${row.credential}-${index}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1">
                    <Select
                      value={row.credential}
                      onChange={(value) => pickCredential(index, value)}
                      options={[UNSET_OPTION, ...options]}
                    />
                  </span>
                  <button
                    type="button"
                    className="ml-auto rounded-md p-1 text-muted hover:bg-hover hover:text-err"
                    onClick={() => removeRow(index)}
                    title={bt('Remove credential')}
                    aria-label={bt('Remove credential')}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <TextInput
                  value={row.variableName}
                  placeholder={bt('Variable name — e.g. apiKey')}
                  onChange={(v) => setName(index, v)}
                  noSlash
                />
              </div>
            ))}
            <button type="button" className="wf-params-add" onClick={addRow}>
              <Plus size={14} />
              <span>{bt('Add credential')}</span>
            </button>
            {/* The rows stay reachable with no credential stored. Hiding them took
                the add button with them, so an operator without a credential saw
                a panel where "add a credential" simply did nothing. */}
            {options.length === 0 && (
              <div className="text-xs text-muted">
                {bt('No credentials configured yet. Add one in Settings → Secrets.')}
              </div>
            )}
          </div>
        )}
      </Field>

      <div className="mt-2 text-xs text-muted">
        {bt(
          'Each credential is fetched at runtime and never stored in the workflow. Downstream blocks reference it by its variable name.',
        )}
      </div>
    </div>
  )
}
