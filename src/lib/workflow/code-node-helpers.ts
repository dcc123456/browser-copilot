/**
 * The helper surface of a `javascript-code` block, as advertised in the editor.
 *
 * Kept in `src/lib` so the workflow editor (help bubbles and autocomplete) and
 * the harness contract tests read one list — the editor must never advertise a
 * helper that the execution paths do not define. English is the source copy;
 * `bt()` resolves the zh-CN rendering from the block-form dictionary.
 *
 * @module lib/workflow/code-node-helpers
 */

import { findSlashQuery, rankByTerm } from '../slash'

export interface CodeNodeHelper {
  /** Name the script calls (or the context object, for `variables`). */
  name: string
  /** Signature shown in the editor, matching what the harnesses accept. */
  signature: string
  /** Whether the name is a callable helper or a context object. */
  kind: 'function' | 'object'
  /** One-line CodeMirror autocomplete detail. */
  hint: string
  /** What the helper does. */
  what: string
  /** When a script author should reach for it. */
  when: string
}

export const CODE_NODE_HELPERS: readonly CodeNodeHelper[] = [
  {
    name: 'automaNextBlock',
    signature: 'automaNextBlock(data?)',
    kind: 'function',
    hint: 'Pass a result to the next block',
    what: 'Stops the script and sends a value to the next block. That block reads it as lastResult (also available as {{lastResult}}), and it overrides the value the script returns.',
    when: 'Use it when a later block needs a specific value from this script, or to finish early after an await.',
  },
  {
    name: 'automaSetVariable',
    signature: 'automaSetVariable(name, value)',
    kind: 'function',
    hint: 'Set a workflow variable',
    what: 'Writes value into the workflow variable name. The value is merged into the run, so later blocks can read it with {{name}} or through automaRefData("variables").',
    when: 'Use it to expose fetched data, an extracted value or a flag that later blocks must read.',
  },
  {
    name: 'automaRefData',
    signature: 'automaRefData(keyword, path?)',
    kind: 'function',
    hint: 'Read variables, table or loop data',
    what: 'Reads runtime data by keyword: variables, table, loopData, prevBlockData or globalData. An optional dot path such as "user.name" returns a nested value.',
    when: 'Use it inside loops or after a previous block when you need the current row or the previous result without hardcoding variable names.',
  },
  {
    name: 'automaResetTimeout',
    signature: 'automaResetTimeout()',
    kind: 'function',
    hint: 'Restart the execution timeout',
    what: 'Restarts the execution timeout from zero. A slow script keeps a full timeout window instead of being killed by the total elapsed time.',
    when: 'Use it in long polls, downloads or multi-step waits so a script that is still making progress is not terminated.',
  },
  {
    name: 'variables',
    signature: 'variables',
    kind: 'object',
    hint: 'Workflow variables (read/write)',
    what: "The run's variable object. Read variables.name and assign variables.name = value; assignments are merged after the script just like automaSetVariable.",
    when: 'Use it when a variable name is computed at runtime, or when plain JavaScript reads more clearly than automaRefData.',
  },
]

/** A workflow variable a script can read, with the block that produced it. */
export interface ScriptVariable {
  /** Variable name as the workflow knows it (without braces). */
  name: string
  /** Producer block id, shown as the completion's secondary label. */
  hint?: string
}

/** One completion row for the script editor's `/` menu. */
export interface ScriptVariableCompletion {
  /** Offset inside the line where the `/query` starts. */
  from: number
  options: { label: string; detail?: string; apply: string }[]
}

const IDENTIFIER_SAFE = /^[\p{L}_$][\p{L}\p{N}_$]*$/u

/**
 * How a script reads a workflow variable: dot access when the name is a valid
 * identifier, bracket access otherwise. The harness passes `variables` as a
 * parameter, so there is no global to reach for.
 */
export function scriptVariableReference(name: string): string {
  return IDENTIFIER_SAFE.test(name) ? `variables.${name}` : `variables[${JSON.stringify(name)}]`
}

/**
 * Match a `/query` at `caret` in `lineText` and rank the script-visible
 * variables against it.
 *
 * Shares {@link findSlashQuery} with the block-parameter fields, so a URL, a
 * path (`src/lib`), a date (`3/4`) or the second slash of `//` never opens the
 * menu. `from` is relative to the line; the CodeMirror adapter adds the
 * line's document offset.
 *
 * Returns null when there is no query or nothing matches, which lets the
 * editor close instead of showing an empty popup.
 */
export function scriptVariableCompletions(
  lineText: string,
  caret: number,
  variables: readonly ScriptVariable[],
): ScriptVariableCompletion | null {
  const query = findSlashQuery(lineText, caret)
  if (!query) return null
  const ranked = rankByTerm(
    variables,
    query.term,
    (variable) => variable.name,
    (variable) => variable.hint ?? '',
  )
  if (ranked.length === 0) return null
  return {
    from: query.start,
    options: ranked.map((variable) => ({
      label: variable.name,
      ...(variable.hint ? { detail: variable.hint } : {}),
      apply: scriptVariableReference(variable.name),
    })),
  }
}
