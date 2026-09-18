import { describe, expect, it } from 'vitest'
import { isOperatorAuditAction, operatorAuditCall } from '../src/lib/workflow/operator-history'

/**
 * The History tab is what the workflow-generation warning tells the user to
 * review, and `workflowFromHistory` is the second way a conversation becomes a
 * workflow. Both read the raw action vocabulary, so an operator step has to be
 * recorded under the action it performed — with the args rewritten to the
 * field names that vocabulary uses.
 */
describe('operatorAuditCall', () => {
  it('maps a click and keeps the resolved selector', () => {
    const call = operatorAuditCall('event-click', {
      selector: '#submit',
      findBy: 'cssSelector',
      label: 'Submit',
    })
    expect(call.action).toBe('click')
    expect(call.args.selector).toBe('#submit')
    // The operator id survives so a reader can tell which block produced it.
    expect(call.args.wfBlockId).toBe('event-click')
  })

  it('splits forms into the sub-action its type means', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'text-field', value: 'Ada' }, 'fill'],
      [{ type: 'select', value: 'EU' }, 'select_option'],
      [{ type: 'checkbox', value: true }, 'set_checkbox'],
      [{ type: 'radio', value: false }, 'set_checkbox'],
      // No type at all is the catalog default, which is a text field.
      [{ value: 'Ada' }, 'fill'],
    ]
    for (const [args, action] of cases) {
      expect(operatorAuditCall('forms', args).action).toBe(action)
    }
  })

  it('records the forms READ mode as a read, never as a fill', () => {
    // A value-less `fill` in the history compiles into a node that clears the
    // field — the exact opposite of what the step did.
    const call = operatorAuditCall('forms', {
      selector: '#email',
      getValue: true,
      variableName: 'email',
    })
    expect(call.action).toBe('read_form')
    expect(call.args.getValue).toBe(true)
    expect(call.args.variableName).toBe('email')
  })

  it('maps navigation, secret and wait blocks to their action names', () => {
    expect(operatorAuditCall('new-tab', { url: 'https://x.test' }).action).toBe('open_url')
    expect(operatorAuditCall('get-secret', { variableName: 'pw' }).action).toBe('get_secret')
    expect(operatorAuditCall('delay', { time: 1500 }).action).toBe('wait_for')
  })

  it('translates switch-tab `tabIndex` to the action vocabulary `index`', () => {
    const call = operatorAuditCall('switch-tab', { tabIndex: 2, url: 'https://x.test' })
    expect(call.action).toBe('tab_switch')
    expect(call.args.index).toBe(2)
  })

  it('translates press-key `keys` / `keysToPress` to `key`', () => {
    expect(operatorAuditCall('press-key', { keys: 'Control+S' }).args.key).toBe('Control+S')
    expect(operatorAuditCall('press-key', { keysToPress: 'Enter' }).args.key).toBe('Enter')
    // The agent-history shape still wins when nothing else is set.
    expect(operatorAuditCall('press-key', { key: 'Escape' }).args.key).toBe('Escape')
  })

  it('translates delay `time` to the `wait_for` vocabulary `timeout`', () => {
    const call = operatorAuditCall('delay', { time: 2500 })
    expect(call.args.timeout).toBe(2500)
    // The block's own field survives too: the node data is unchanged.
    expect(call.args.time).toBe(2500)
  })

  it('translates an element scroll into the `scroll` action vocabulary', () => {
    const intoView = operatorAuditCall('element-scroll', {
      selector: '#row',
      scrollIntoView: true,
    })
    expect(intoView.action).toBe('scroll')
    expect(intoView.args.mode).toBe('into_view')

    const byWheel = operatorAuditCall('element-scroll', { incX: 0, incY: 400 })
    expect(byWheel.args.mode).toBe('by')
    expect(byWheel.args.y).toBe(400)

    // Absolute offsets are the fallback when no increment was given.
    const absolute = operatorAuditCall('element-scroll', { scrollY: 900 })
    expect(absolute.args.y).toBe(900)
  })

  it('keeps the operator name when there is no raw-action equivalent', () => {
    const call = operatorAuditCall('cookie', { type: 'get', name: 'sid' })
    expect(call.action).toBe('wf_op_cookie')
    expect(call.args.type).toBe('get')
    expect(isOperatorAuditAction(call.action)).toBe(true)
  })

  it('never mutates the args it was given', () => {
    const args = { selector: '#a' }
    operatorAuditCall('event-click', args)
    expect(args).toEqual({ selector: '#a' })
  })

  it('does not classify a mapped action as an operator action', () => {
    expect(isOperatorAuditAction(operatorAuditCall('event-click', {}).action)).toBe(false)
  })
})
