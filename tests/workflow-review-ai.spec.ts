import { beforeAll, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
  })
})

import {
  buildReviewPrompt,
  parseReview,
  reviewWorkflow,
} from '../src/background/workflow-engine/workflow-review'
import { reviewStepsOf } from '../src/lib/workflow/review-patch'
import { workflowFromHistory } from '../src/lib/storage'
import type { HistoryEntry } from '../src/lib/types'

type Args = Record<string, unknown>

let seq = 0
function entry(action: string, args?: Args): HistoryEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    at: seq,
    conversationId: 'conv-1',
    action,
    summary: action,
    approved: true,
    ok: true,
    ...(args ? { args } : {}),
  }
}

const fixture = () =>
  workflowFromHistory(
    [
      entry('open_url', { url: 'https://a.com' }),
      entry('click', { target: { primary: { how: 'css', value: '.go' } } }),
    ],
    'wf',
  )!

describe('buildReviewPrompt', () => {
  it('lists every primary step id, the guide and the JSON contract', () => {
    const wf = fixture()
    const prompt = buildReviewPrompt(wf)
    for (const step of reviewStepsOf(wf)) {
      expect(prompt).toContain(`id=${step.id}`)
    }
    expect(prompt).toContain('节点取舍')
    expect(prompt).toContain('"summary"')
    expect(prompt).toContain('keep')
  })

  it('truncates oversized param values', () => {
    const wf = workflowFromHistory(
      [entry('run_javascript', { code: `console.log("${'x'.repeat(500)}")`, timeout: 20000 })],
      'wf',
    )!
    const prompt = buildReviewPrompt(wf)
    // The long code ships capped (ellipsis) instead of verbatim.
    expect(prompt).toMatch(/x{100,}…/)
    expect(prompt).not.toContain('x'.repeat(500))
  })
})

describe('parseReview', () => {
  const ids = new Set(['step-a', 'step-b'])

  it('parses an explicit drop with its reason', () => {
    const review = parseReview(
      '{"summary":"打开了页面并点击。","steps":[{"id":"step-a","keep":false,"reason":"探索性点击"},{"id":"step-b","keep":true}]}',
      ids,
    )
    expect(review?.summary).toBe('打开了页面并点击。')
    expect(review?.steps).toEqual([
      { id: 'step-a', keep: false, reason: '探索性点击' },
      { id: 'step-b', keep: true },
    ])
  })

  it('treats a missing keep flag as keep (never drops by omission)', () => {
    const review = parseReview(
      '{"summary":"s","steps":[{"id":"step-a"},{"id":"step-b","keep":true}]}',
      ids,
    )
    expect(review?.steps[0]).toEqual({ id: 'step-a', keep: true })
  })

  it('ignores unknown step ids and returns null when nothing usable remains', () => {
    expect(parseReview('{"summary":"s","steps":[{"id":"nope","keep":false}]}', ids)).toBeNull()
    expect(
      parseReview(
        '{"summary":"s","steps":[{"id":"nope","keep":true},{"id":"step-a","keep":true}]}',
        ids,
      ),
    ).toEqual({
      summary: 's',
      steps: [{ id: 'step-a', keep: true }],
    })
  })

  it('accepts a markdown-fenced JSON body', () => {
    const review = parseReview(
      '```json\n{"summary":"s","steps":[{"id":"step-a","keep":false,"reason":"r"}]}\n```',
      ids,
    )
    expect(review?.steps[0]?.keep).toBe(false)
  })

  it('returns null for noise, empty verdicts or unparseable text', () => {
    expect(parseReview('模型走神了，没有 JSON', ids)).toBeNull()
    expect(parseReview('{"summary":"s","steps":[]}', ids)).toBeNull()
    expect(parseReview('{"summary":"s","steps":"not-an-array"}', ids)).toBeNull()
  })
})

describe('reviewWorkflow degradation', () => {
  it('returns null (keep-everything) when no provider is configured', async () => {
    const result = await reviewWorkflow(fixture())
    expect(result).toBeNull()
  })
})
