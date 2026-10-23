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
