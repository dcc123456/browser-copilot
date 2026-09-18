/**
 * Operator → action-history mapping.
 *
 * A `wf_op_*` call is recorded in the action history under the *browser action
 * it performed* rather than its tool name. Two things fall out of that:
 *
 *   - the History tab — which is exactly what the workflow-generation warning
 *     tells the user to review — reads as `click #submit` instead of
 *     `wf_op_event-click {"ref":"e12"}`;
 *   - `workflowFromHistory` can compile a workflow-generation conversation the
 *     same way it compiles any other, because it only understands the raw
 *     action vocabulary (see `ACTION_TO_BLOCK` in `lib/storage`).
 *
 * The args are rewritten to the shape `blockDataFromArgs` expects, so the
 * history path reads the same field names the raw tools would have written.
 * The operator id is preserved in `wfBlockId`, so a reader can always tell
 * which operator produced the step.
 *
 * Blocks with no raw-action equivalent (most data / browser blocks) keep their
 * `wf_op_<id>` name and pass their args through untouched — the history entry
 * is still a faithful record, it just has no other vocabulary to map onto.
 *
 * @module lib/workflow/operator-history
 */

/** The history entry one operator call becomes. */
export interface OperatorAuditCall {
  /** The action name recorded in history. */
  action: string
  /** The args, translated to that action's vocabulary. */
  args: Record<string, unknown>
}

/**
 * Operators whose mapping needs no argument translation: the block's own field
 * names already match what `blockDataFromArgs` reads.
 */
const DIRECT_ACTION: Readonly<Record<string, string>> = {
  'event-click': 'click',
  'new-tab': 'open_url',
  'get-secret': 'get_secret',
}

/** Which `forms` sub-action a `type` value means. */
function formsAction(type: unknown): string {
  switch (String(type ?? '').trim()) {
    case 'select':
      return 'select_option'
    case 'checkbox':
    case 'radio':
      return 'set_checkbox'
    default:
      return 'fill'
  }
}

/**
 * `press-key` writes `keys` (the recorder's combo) or `keysToPress` (the
 * free-text field); the action vocabulary uses `key`.
 */
function pressKeyArgs(args: Record<string, unknown>): Record<string, unknown> {
  const key = args['keys'] ?? args['keysToPress'] ?? args['key'] ?? ''
  return { ...args, key }
}

/** `switch-tab` writes `tabIndex`; the action vocabulary uses `index`. */
function switchTabArgs(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args, index: args['tabIndex'] ?? args['index'] ?? 0 }
}

/** `delay` writes `time`; the `wait_for` action reads `timeout`. */
function delayArgs(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args, timeout: args['time'] ?? args['timeout'] ?? 0 }
}

/**
 * `element-scroll` models an element scroll (`scrollIntoView`) or a wheel
 * scroll (`incX`/`incY`, falling back to the absolute `scrollX`/`scrollY`);
 * the `scroll` action reads `mode` + `x`/`y`.
 */
function scrollArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args['scrollIntoView']) return { ...args, mode: 'into_view' }
  const x = args['incX'] ?? args['scrollX'] ?? 0
  const y = args['incY'] ?? args['scrollY'] ?? 600
  return { ...args, mode: 'by', x, y }
}

/**
 * The history entry for one operator call. `args` must be the RESOLVED
 * parameters (selector / target filled in), not the model's raw `ref` — a
 * history step carrying only a stale ref is useless to the history compiler.
 */
export function operatorAuditCall(
  blockId: string,
  args: Record<string, unknown>,
): OperatorAuditCall {
  const withId = { ...args, wfBlockId: blockId }

  const direct = DIRECT_ACTION[blockId]
  if (direct) return { action: direct, args: withId }

  switch (blockId) {
    case 'forms':
      // Read mode is not a write: recording it as `fill` would put a
      // value-less fill into the history, and compiling that history would
      // produce a node that CLEARS the field it was supposed to read.
      return args['getValue'] === true
        ? { action: 'read_form', args: withId }
        : { action: formsAction(args['type']), args: withId }
    case 'press-key':
      return { action: 'press_key', args: pressKeyArgs(withId) }
    case 'switch-tab':
      return { action: 'tab_switch', args: switchTabArgs(withId) }
    case 'delay':
      return { action: 'wait_for', args: delayArgs(withId) }
    case 'element-scroll':
      return { action: 'scroll', args: scrollArgs(withId) }
    default:
      // No raw-action equivalent: record the operator verbatim.
      return { action: `wf_op_${blockId}`, args: withId }
  }
}

/** Is this history action one the operator mapping produced? */
export function isOperatorAuditAction(action: string): boolean {
  return action.startsWith('wf_op_')
}
