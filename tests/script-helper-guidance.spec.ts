/**
 * What the workflow generator is told about `javascript-code`.
 *
 * The guide used to say business data inside a script goes through `vars.xxx`
 * / `refData`, which do not exist: both harnesses pass the helpers and
 * `variables` as PARAMETERS. A model following the old line wrote scripts that
 * threw on the first reference. These assertions pin the corrected surface in
 * both places the model reads it: the always-loaded operator guide and the
 * escape-hatch tool schema.
 */
import { describe, expect, it } from 'vitest'
import { CODE_NODE_HELPERS } from '../src/lib/workflow/code-node-helpers'
import { OPERATOR_GUIDE } from '../src/lib/workflow/operator-guide'
import { buildWorkflowEscapeTools } from '../src/lib/workflow/operator-tools'

describe('script guidance for the generator', () => {
  it('does not teach a vars / refData global', () => {
    expect(OPERATOR_GUIDE).not.toContain('vars.xxx')
    expect(OPERATOR_GUIDE).not.toMatch(/`vars`、`refData`\s*作为参数/)
  })

  it('names the real helper surface in the guide', () => {
    expect(OPERATOR_GUIDE).toContain('`variables`')
    expect(OPERATOR_GUIDE).toContain('`automa*`')
    expect(OPERATOR_GUIDE).toContain('automaSetVariable')
    expect(OPERATOR_GUIDE).toContain('automaNextBlock')
  })

  it('spells out every built-in in the javascript-code tool schema', () => {
    const tool = buildWorkflowEscapeTools().find(
      (candidate) => candidate.function.name === 'wf_op_javascript-code',
    )
    expect(tool).toBeDefined()
    const parameters = tool!.function.parameters as {
      properties: Record<string, { description?: string }>
    }
    const description = parameters.properties['code']?.description ?? ''
    for (const helper of CODE_NODE_HELPERS) {
      expect(description, helper.name).toContain(helper.name)
    }
    expect(description).toContain('NO `vars`/`refData`')
  })
})
