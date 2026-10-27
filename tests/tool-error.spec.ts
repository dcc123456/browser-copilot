/**
 * Tests for the structured tool-failure context (`lib/tool-error`):
 * classification across Chinese/English messages, the recovery suggestions per
 * class, and extraction of recent failed attempts from a transcript.
 */
import { describe, expect, it } from 'vitest'

import {
  buildToolErrorContext,
  classifyToolError,
  failureSignature,
  isUnchangeableFailure,
  nextFailureStreak,
  recentFailedAttempts,
  REPEAT_FAILURE_LIMIT,
} from '../src/lib/tool-error'

describe('classifyToolError', () => {
  it('classifies the common failure classes', () => {
    expect(classifyToolError('Unknown ref "e9". Take a fresh snapshot')).toBe('STALE_REF')
    expect(classifyToolError('Element not found for selector .x')).toBe('ELEMENT_NOT_FOUND')
    expect(classifyToolError('未找到目标元素')).toBe('ELEMENT_NOT_FOUND')
    expect(classifyToolError('操作超时 timeout')).toBe('TIMEOUT')
    expect(classifyToolError('net::ERR_NAME_NOT_RESOLVED')).toBe('NAVIGATION_FAILED')
    expect(classifyToolError('The "click" tool is disabled in settings.')).toBe('PERMISSION')
    expect(classifyToolError('Failed to fetch')).toBe('NETWORK')
    expect(classifyToolError('something odd happened')).toBe('UNKNOWN')
  })

  it('recognises a page that forbids injected JavaScript', () => {
    expect(
      classifyToolError(
        'Evaluating a string as JavaScript violates the following Content Security Policy',
      ),
    ).toBe('JS_BLOCKED')
    expect(
      classifyToolError(
        '该页面的内容安全策略（CSP）禁止执行自定义 JavaScript（未允许 unsafe-eval），无法在此页面运行 JS 代码。',
      ),
    ).toBe('JS_BLOCKED')
  })

  it('prefers STALE_REF over a generic not-found', () => {
    // A stale ref message often also says "not found"; the stale fix must win.
    expect(classifyToolError('Unknown ref "e3" — element not found')).toBe('STALE_REF')
  })
})

describe('isUnchangeableFailure', () => {
  it('treats page-policy and permission blocks as unchangeable', () => {
    expect(isUnchangeableFailure('Content Security Policy blocks eval')).toBe(true)
    expect(isUnchangeableFailure('The "click" tool is disabled in settings.')).toBe(true)
  })

  it('leaves retry-with-fresh-state failures retryable', () => {
    expect(isUnchangeableFailure('Unknown ref "e9"')).toBe(false)
    expect(isUnchangeableFailure('timeout after 30000ms')).toBe(false)
    expect(isUnchangeableFailure('Failed to fetch')).toBe(false)
  })
})

describe('failure streaks', () => {
  it('counts only byte-identical failures', () => {
    const first = nextFailureStreak(undefined, failureSignature('run_javascript', 'boom'))
    expect(first.count).toBe(1)
    const same = nextFailureStreak(first, failureSignature('run_javascript', 'boom'))
    expect(same.count).toBe(2)
    const changed = nextFailureStreak(same, failureSignature('run_javascript', 'other boom'))
    expect(changed.count).toBe(1)
  })

  it('separates the same message across different tools', () => {
    expect(failureSignature('click', 'boom')).not.toBe(failureSignature('fill', 'boom'))
    expect(REPEAT_FAILURE_LIMIT).toBe(3)
  })
})

describe('buildToolErrorContext', () => {
  it('attaches concrete recovery steps', () => {
    const context = buildToolErrorContext('Element not found')
    expect(context.errorType).toBe('ELEMENT_NOT_FOUND')
    expect(context.suggestedRecovery.length).toBeGreaterThan(0)
    expect(context.suggestedRecovery.join(' ')).toMatch(/snapshot/i)
  })

  it('always provides at least one suggestion', () => {
    for (const message of ['', 'weird', '超时', 'captcha wall']) {
      expect(buildToolErrorContext(message).suggestedRecovery.length).toBeGreaterThan(0)
    }
  })
})

describe('recentFailedAttempts', () => {
  const history = [
    { role: 'tool', name: 'click', content: JSON.stringify({ error: 'boom 1' }) },
    { role: 'tool', name: 'click', content: JSON.stringify({ ok: true }) },
    { role: 'tool', name: 'fill', content: JSON.stringify({ error: 'other tool' }) },
    { role: 'tool', name: 'click', content: JSON.stringify({ error: 'boom 2' }) },
    { role: 'tool', name: 'click', content: 'not json' },
  ]

  it('returns only failed results for the same tool, oldest first', () => {
    const attempts = recentFailedAttempts(history, 'click')
    expect(attempts.map((a) => a.result)).toEqual(['boom 1', 'boom 2'])
  })

  it('caps the number of attempts returned', () => {
    const many = Array.from({ length: 6 }, (_v, i) => ({
      role: 'tool',
      name: 'click',
      content: JSON.stringify({ error: `e${i}` }),
    }))
    expect(recentFailedAttempts(many, 'click', 3)).toHaveLength(3)
    expect(recentFailedAttempts(many, 'click', 3).at(-1)?.result).toBe('e5')
  })
})
