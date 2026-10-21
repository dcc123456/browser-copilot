/**
 * Unit tests for the pure per-node AI-fix module: prompt builder, reply parser
 * and data sanitizer.
 */
import { describe, expect, it } from 'vitest'
import {
  buildNodeFixPrompt,
  nodeFixLogLinesOf,
  nodeFixParamsPayloadOf,
  nodeFixReplyPayloadOf,
  nodeFixRequestPayloadOf,
  nodeFixVerdictPayloadOf,
  parseNodeFixReply,
  sanitizeNodeData,
  temporaryCriterionOf,
} from '../src/lib/workflow/node-fix'
import type { WorkflowCondition } from '../src/lib/workflow/conditions'
import { WORKFLOW_AI_NAMESPACE } from '../src/lib/workflow/node-goal-contract'

const criteria: WorkflowCondition[] = [
  { kind: 'urlContains', value: '/dashboard' },
  { kind: 'variableExists', name: 'result' },
]

const currentData = {
  selector: '#submit',
  findBy: 'cssSelector',
  waitForSelector: false,
  description: 'click submit',
}

describe('buildNodeFixPrompt', () => {
  it('states the block, goal, success criteria and current parameters', () => {
    const prompt = buildNodeFixPrompt({
      blockId: 'event-click',
      goal: 'Submit the login form',
      successCriteria: criteria,
      userSuggestion: 'the selector is stale',
      currentData,
      unmetCriteria: ['URL contains "/dashboard"'],
    })
    expect(prompt).toContain('event-click')
    expect(prompt).toContain('Submit the login form')
    expect(prompt).toContain('/dashboard')
    expect(prompt).toContain('the selector is stale')
    expect(prompt).toContain('#submit')
    expect(prompt).toContain('URL contains "/dashboard"')
  })

  it('omits optional sections when there is no error, suggestion or page summary', () => {
    const prompt = buildNodeFixPrompt({
      blockId: 'event-click',
      goal: 'g',
      successCriteria: criteria,
      userSuggestion: '',
      currentData,
      unmetCriteria: [],
    })
    expect(prompt).not.toContain('## User repair guidance')
    expect(prompt).not.toContain('## Last execution error')
    expect(prompt).not.toContain('## Live page summary')
    expect(prompt).not.toContain('## Success criteria that did NOT hold')
  })
})

describe('buildNodeFixPrompt — without a stored contract', () => {
  const promptOnly = (over: Partial<Parameters<typeof buildNodeFixPrompt>[0]> = {}) =>
    buildNodeFixPrompt({
      blockId: 'forms',
      successCriteria: [],
      userSuggestion: 'the username must come from the workflow input',
      currentData,
      unmetCriteria: [],
      ...over,
    })

  it('makes the user prompt the goal and asks for a verify object', () => {
    const prompt = promptOnly({ errorLog: 'ElementNotFound: input[name="user"]' })
    expect(prompt).toContain('no stored contract')
    expect(prompt).toContain('the username must come from the workflow input')
    expect(prompt).not.toContain('## User repair guidance')
    expect(prompt).toContain('return a "verify" object')
    expect(prompt).toContain('"kind":"elementValue"')
    expect(prompt).toContain('"verify"')
  })

  it('carries the pasted error log as its own section', () => {
    const prompt = promptOnly({ errorLog: 'ElementNotFound: input[name="user"]' })
    expect(prompt).toContain('## Error log from the failed run (pasted by the user)')
    expect(prompt).toContain('ElementNotFound')
    expect(promptOnly()).not.toContain('## Error log from the failed run')
  })

  it('states the agreed criterion once one exists', () => {
    const prompt = promptOnly({
      successCriteria: [{ kind: 'variableExists', name: 'username' }],
    })
    expect(prompt).toContain('Success criterion agreed for this repair')
    // `describeCondition` is the repo-wide renderer and speaks Chinese.
    expect(prompt).toContain('变量 username 存在')
    expect(prompt).not.toContain('return a "verify" object')
  })
})

describe('buildNodeFixPrompt — the operator swap', () => {
  const swapTargets = [
    { id: 'forms', name: 'Fill form' },
    { id: 'get-text', name: 'Get text' },
  ]

  it('offers the listed ids as the only blockId the reply may name', () => {
    const prompt = buildNodeFixPrompt({
      blockId: 'event-click',
      goal: 'Submit the login form',
      successCriteria: criteria,
      userSuggestion: 'this operator cannot type into both fields',
      currentData,
      unmetCriteria: [],
      swapTargets,
    })
    expect(prompt).toContain('## Operators this step may be switched to')
    expect(prompt).toContain('- forms — Fill form')
    expect(prompt).toContain('"blockId":"<an operator id above, or leave it out>"')
    // The escape hatch stays the exception, in the rules as well as the format.
    expect(prompt).toContain('Keep this operator unless it cannot do the job at all')
    expect(prompt).not.toContain('- Do NOT change the block id.')
  })

  it('stays parameters-only when there is nothing to switch to', () => {
    const prompt = buildNodeFixPrompt({
      blockId: 'event-click',
      goal: 'g',
      successCriteria: criteria,
      userSuggestion: '',
      currentData,
      unmetCriteria: [],
      swapTargets: [],
    })
    expect(prompt).not.toContain('Operators this step may be switched to')
    expect(prompt).not.toContain('"blockId"')
    expect(prompt).toContain('- Do NOT change the block id.')
  })
})

describe('parseNodeFixReply', () => {
  it('parses a clean JSON object', () => {
    const reply = parseNodeFixReply(
      JSON.stringify({
        rationale: 'fixed selector',
        data: { selector: '#new' },
      }),
    )
    expect(reply).not.toBeNull()
    expect(reply!.rationale).toBe('fixed selector')
    expect(reply!.data).toEqual({ selector: '#new' })
  })

  it('tolerates think blocks and surrounding prose', () => {
    const text =
      '<think>let me reason about this at length</think>' +
      'Here is the fix: {"rationale":"r","data":{"a":1}}'
    const reply = parseNodeFixReply(text)
    expect(reply).not.toBeNull()
    expect(reply!.data).toEqual({ a: 1 })
  })

  it('tolerates a markdown fence wrapping the object', () => {
    const text = '```json\n{"rationale":"r","data":{"a":1}}\n```'
    // stripThinkBlocks does not remove fences, but brace extraction still works.
    const reply = parseNodeFixReply(text)
    expect(reply).not.toBeNull()
    expect(reply!.data).toEqual({ a: 1 })
  })

  it('returns null for broken JSON', () => {
    expect(parseNodeFixReply('{"rationale":"r","data":{ broken')).toBeNull()
  })

  it('returns null when data is not an object', () => {
    expect(parseNodeFixReply('{"rationale":"r","data":[1,2]}')).toBeNull()
    expect(parseNodeFixReply('{"rationale":"r"}')).toBeNull()
    expect(parseNodeFixReply('no json here')).toBeNull()
  })

  it('defaults a missing rationale to a placeholder', () => {
    const reply = parseNodeFixReply('{"data":{}}')
    expect(reply!.rationale).toBe('(no rationale provided)')
  })

  it('reads the temporary criterion a prompt-only reply proposes', () => {
    const reply = parseNodeFixReply(
      JSON.stringify({
        rationale: 'r',
        data: { selector: '#new' },
        verify: { kind: 'urlContains', value: '/home' },
      }),
    )
    expect(reply!.verify).toEqual({ kind: 'urlContains', value: '/home' })
  })

  it('drops an unusable verify without losing the repair', () => {
    for (const verify of [null, undefined, { kind: 'notACondition' }, 'url=/home', 7]) {
      const reply = parseNodeFixReply(JSON.stringify({ rationale: 'r', data: {}, verify }))
      expect(reply).not.toBeNull()
      expect(reply!.data).toEqual({})
      expect(reply!.verify).toBeUndefined()
    }
  })

  it('reads a proposed operator from the top level, never from the parameters', () => {
    const reply = parseNodeFixReply(
      JSON.stringify({ rationale: 'r', data: { selector: '#new' }, blockId: 'forms' }),
    )
    expect(reply!.blockId).toBe('forms')
    // `data` stays the reserved-key-free parameter object it always was: the swap
    // rides its own field, so the sanitizer's gate does not move.
    expect(reply!.data['blockId']).toBeUndefined()
    expect(sanitizeNodeData(reply!.data)!['blockId']).toBeUndefined()
  })

  it('ignores a blockId that is not a usable string', () => {
    for (const blockId of [null, undefined, 7, '   ', {}]) {
      const reply = parseNodeFixReply(JSON.stringify({ rationale: 'r', data: {}, blockId }))
      expect(reply).not.toBeNull()
      expect(reply!.blockId).toBeUndefined()
    }
  })
})

describe('temporaryCriterionOf', () => {
  it('lifts the flat locator shorthand the same way a stored contract does', () => {
    expect(temporaryCriterionOf({ kind: 'elementExists', target: '#save' })).toEqual({
      kind: 'elementExists',
      target: { selector: '#save' },
    })
  })

  it('yields undefined for anything that is not one well-formed row', () => {
    expect(temporaryCriterionOf(undefined)).toBeUndefined()
    expect(temporaryCriterionOf(null)).toBeUndefined()
    expect(temporaryCriterionOf([{ kind: 'urlContains', value: '/a' }])).toBeUndefined()
  })
})

describe('sanitizeNodeData', () => {
  it('strips reserved keys (blockId and goal-contract namespace)', () => {
    const out = sanitizeNodeData({
      blockId: 'event-click',
      [WORKFLOW_AI_NAMESPACE]: { goalContract: {} },
      selector: '#x',
    })
    expect(out).not.toBeNull()
    expect(out!['blockId']).toBeUndefined()
    expect(out![WORKFLOW_AI_NAMESPACE]).toBeUndefined()
    expect(out!['selector']).toBe('#x')
  })

  it('drops functions, symbols and non-plain objects, keeps primitives', () => {
    const out = sanitizeNodeData({
      s: 'text',
      n: 1,
      b: false,
      nil: null,
      fn: () => 1,
      date: new Date(0),
      arr: [1, 'a', null],
    })
    expect(out!['fn']).toBeUndefined()
    expect(out!['date']).toBeUndefined()
    expect(out!['s']).toBe('text')
    expect(out!['n']).toBe(1)
    expect(out!['b']).toBe(false)
    expect(out!['nil']).toBeNull()
    expect(out!['arr']).toEqual([1, 'a', null])
  })

  it('returns a deep copy with no shared references', () => {
    const source = { nested: { selector: '#a' }, arr: [{ x: 1 }] }
    const out = sanitizeNodeData(source)!
    ;(out['nested'] as Record<string, unknown>)['selector'] = '#b'
    expect(source.nested.selector).toBe('#a')
  })

  it('returns null for non-object top-level values', () => {
    expect(sanitizeNodeData([1, 2])).toBeNull()
    expect(sanitizeNodeData('x')).toBeNull()
    expect(sanitizeNodeData(null)).toBeNull()
  })
})

describe('the live fix log payload', () => {
  it('reports the model request from the same fields the prompt is built from', () => {
    const text = nodeFixRequestPayloadOf({
      blockId: 'event-click',
      goal: 'Submit the login form',
      successCriteria: criteria,
      userSuggestion: 'the selector is stale',
      currentData,
      execError: 'ElementNotFound',
      unmetCriteria: ['URL contains "/dashboard"'],
    })
    expect(text).toContain('block: event-click')
    expect(text).toContain('#submit')
    expect(text).toContain('goal: Submit the login form')
    expect(text).toContain('ElementNotFound')
    expect(text).toContain('the selector is stale')
  })

  it('reports what the AI returned: rationale, parameters and its agreed check', () => {
    const text = nodeFixReplyPayloadOf({
      rationale: 'the button moved behind a form id',
      data: { selector: '#login-submit' },
      verify: { kind: 'urlContains', value: '/home' },
    })
    expect(text).toContain('rationale: the button moved')
    expect(text).toContain('#login-submit')
    expect(text).toContain('check: ')
  })

  it('shows the operator it answered with, even one the loop will reject', () => {
    const text = nodeFixReplyPayloadOf({
      rationale: 'this operator cannot upload at all',
      data: { filePath: '/x' },
      blockId: 'not-a-real-operator',
    })
    expect(text).toContain('switch to: not-a-real-operator')
    expect(nodeFixReplyPayloadOf({ rationale: 'r', data: {} })).not.toContain('switch to')
  })

  it('reports the operator switch the request offered', () => {
    const text = nodeFixRequestPayloadOf({
      blockId: 'event-click',
      goal: 'g',
      successCriteria: criteria,
      userSuggestion: '',
      currentData,
      unmetCriteria: [],
      swapTargets: [{ id: 'forms', name: 'Fill form' }],
    })
    expect(text).toContain('may switch to: forms')
  })

  it('shows the node parameters a trial run used', () => {
    expect(nodeFixParamsPayloadOf({ selector: '#a' })).toContain('"selector":"#a"')
  })

  it('shows each criterion and whether the page agreed', () => {
    const text = nodeFixVerdictPayloadOf([
      { condition: criteria[0]!, satisfied: true },
      { condition: criteria[1]!, satisfied: false },
    ])
    expect(text).toContain('✓')
    expect(text).toContain('✗')
    expect(nodeFixVerdictPayloadOf([])).toContain('no criterion')
  })

  it('projects one event into plain log lines for a text-only consumer', () => {
    const lines = nodeFixLogLinesOf(
      {
        sessionId: 's',
        phase: 'diagnosing',
        round: 1,
        message: 'goal not held',
        payload: { request: 'block: forms\nparams: {"selector":"#a"}' },
      },
      { round: (round) => `R${round + 1}` },
    )
    expect(lines[0]).toBe('R2 · goal not held')
    // The payload's newline structure collapses so one step stays one line.
    expect(lines[1]).toBe('R2 · block: forms | params: {"selector":"#a"}')
  })
})
