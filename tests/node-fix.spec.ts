/**
 * Unit tests for the pure per-node AI-fix module: prompt builder, reply parser
 * and data sanitizer.
 */
import { describe, expect, it } from 'vitest'
import {
  buildNodeFixPrompt,
  parseNodeFixReply,
  sanitizeNodeData,
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
