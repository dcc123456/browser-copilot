/**
 * Tests for the structured tool-failure context (`lib/tool-error`):
 * classification across Chinese/English messages, the recovery suggestions per
 * class, and extraction of recent failed attempts from a transcript.
 */
import { describe, expect, it } from 'vitest'

import {
  buildToolErrorContext,
  classifyToolError,
  recentFailedAttempts,
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

  it('prefers STALE_REF over a generic not-found', () => {
    // A stale ref message often also says "not found"; the stale fix must win.
    expect(classifyToolError('Unknown ref "e3" — element not found')).toBe('STALE_REF')
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
