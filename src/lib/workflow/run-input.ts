/**
 * The interactive half of the `parameter-prompt` block.
 *
 * Automa pauses a run and shows a popup asking for the block's declared
 * parameters. This module is the chrome-free contract between the executor, the
 * background request hub and the two dialogs (workflow editor / side panel):
 * what to ask, how an answer is shaped, and how a value becomes a variable.
 *
 * Only an attended run asks. The Runner and every scheduled / triggered run
 * have no UI to answer, so they keep the silent default-filling behavior — a
 * headless run must not hang on a question nobody can see.
 *
 * @module lib/workflow/run-input
 */

import { coerceInputValue, isRequiredInput } from './workflow-inputs'
import type { WorkflowParameter } from './types'

/** The field kinds the dialog can render; anything else is a text input. */
export type RunInputFieldType = 'string' | 'number' | 'json' | 'checkbox'

/** One parameter as the dialog needs it — already interpolated and ready. */
export interface RunInputField {
  name: string
  type: RunInputFieldType
  description?: string
  placeholder?: string
  /** Initial text the user sees; a secret's real value is never sent. */
  value: string
  required: boolean
  secret?: boolean
  /**
   * A secret field whose value already exists in the scope. The dialog may
   * accept a blank answer for it ("keep the saved value"); a blank answer on a
   * secret with NOTHING stored is a missing required value, so the dialog can
   * say so instead of letting the run fail.
   */
  secretStored?: boolean
}

/** What the executor asks for, before the hub adds run identity. */
export interface RunInputPrompt {
  description?: string
  fields: RunInputField[]
  /** Effective wait, after {@link runInputTimeoutOf}; milliseconds. */
  timeoutMs: number
}

/** The request broadcast to extension pages, and the same shape on the wire. */
export interface RunInputRequest extends RunInputPrompt {
  requestId: string
  /** The initiating page's token — only that page shows the dialog. */
  promptToken: string
  runId: string
  workflowId: string
  workflowName: string
  at: number
}

/** What the dialog answers. Values are raw form text; the executor coerces. */
export interface RunInputAnswer {
  values: Record<string, string>
  /** The user stopped the run instead of filling the form. */
  cancelled?: boolean
  /** The wait expired: continue with defaults / the scope's existing values. */
  timedOut?: boolean
}

/** Mirrors the block form's default (`EditParameterPrompt`). */
export const RUN_INPUT_DEFAULT_TIMEOUT_MS = 60_000

/**
 * Bound on an "unlimited" wait (block timeout 0).
 *
 * An MV3 worker cannot be pinned forever — the keepalive cap is ten minutes —
 * so zero means "as long as this worker can stay up", not infinity. The
 * deadline is set just under that cap so the block times out cleanly instead
 * of dying with the worker.
 */
export const RUN_INPUT_MAX_WAIT_MS = 9 * 60 * 1000

/** Read the block's `timeout` field into the wait the hub applies. */
export function runInputTimeoutOf(value: unknown): number {
  // `Number('')` is 0, which would silently mean "wait nine minutes" for a
  // field that was left blank in an imported graph. Treat it as absent.
  const raw =
    typeof value === 'number' ? value : value === '' || value == null ? NaN : Number(value)
  if (!Number.isFinite(raw) || raw < 0) return RUN_INPUT_DEFAULT_TIMEOUT_MS
  if (raw === 0) return RUN_INPUT_MAX_WAIT_MS
  return Math.min(raw, RUN_INPUT_MAX_WAIT_MS)
}

/** A fresh id for one prompt request or one initiating page. */
export function newRunInputToken(prefix: 'input' | 'prompt'): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}-${random}`
}

/**
 * Turn a value already in the scope into the text the dialog edits.
 *
 * Objects are JSON so a JSON field round-trips instead of showing
 * `[object Object]`; secrets are deliberately NOT sent back (the dialog starts
 * blank and an empty answer keeps the stored value).
 */
function editableText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return ''
    }
  }
  return String(value)
}

/** The dialog fields for a block's declared parameters. */
export function runInputFieldsOf(
  parameters: readonly WorkflowParameter[],
  variables: Readonly<Record<string, unknown>>,
  resolveDefault: (defaultValue: string) => string,
): RunInputField[] {
  return parameters.map((param) => {
    const secret = param.secret === true
    const current = variables[param.name]
    const value = secret
      ? ''
      : current !== undefined
        ? editableText(current)
        : resolveDefault(param.defaultValue ?? '')
    return {
      name: param.name,
      type: (['string', 'number', 'json', 'checkbox'].includes(param.type)
        ? param.type
        : 'string') as RunInputFieldType,
      ...(param.description ? { description: param.description } : {}),
      ...(param.placeholder ? { placeholder: param.placeholder } : {}),
      value,
      required: isRequiredInput(param),
      ...(secret ? { secret: true } : {}),
      ...(secret && current !== undefined && current !== null && current !== ''
        ? { secretStored: true }
        : {}),
    }
  })
}

/**
 * Write the dialog's raw text back into the run scope with each parameter's
 * type applied.
 *
 * An empty SECRET answer is "keep the stored value": the dialog never showed
 * it, so clearing the field cannot mean "erase the credential". A cleared
 * non-secret field writes `''`, which the required check then catches.
 */
export function applyRunInputValues(
  parameters: readonly WorkflowParameter[],
  values: Readonly<Record<string, string>>,
  variables: Record<string, unknown>,
): void {
  for (const param of parameters) {
    const raw = values[param.name]
    if (raw === undefined) continue
    if (param.secret === true && raw === '' && variables[param.name] !== undefined) continue
    variables[param.name] = coerceInputValue(param as WorkflowParameter, raw)
  }
}
