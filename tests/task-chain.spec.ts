import { describe, expect, it } from 'vitest'
import {
  MAX_OUTPUT_KEYS,
  MAX_OUTPUT_STRING,
  buildUpstream,
  clampHandoffBag,
  describeUnresolved,
  resolveTaskInputs,
} from '../src/lib/task-chain'
import type { TaskRunLog } from '../src/lib/scheduler-types'

/**
 * The cross-task handoff contract, tested on the pure layer: what a run is
 * allowed to publish, and what a chained task may read.
 */

function parentRun(over: Partial<TaskRunLog> = {}): TaskRunLog {
  return {
    id: 'run-1',
    taskId: 'task-parent',
    label: 'Publish note',
    source: 'schedule',
    at: 1,
    startedAt: 0,
    outcome: 'ok',
    ok: true,
    skipped: false,
    summary: 'Published.',
    steps: 3,
    ...over,
  } as TaskRunLog
}

describe('buildUpstream', () => {
  it('is empty when there is no parent run to read', () => {
    expect(buildUpstream(undefined)).toEqual({})
  })

  it('always carries the parent summary next to its declared outputs', () => {
    const bag = buildUpstream(parentRun({ outputs: { noteUrl: 'https://x/1' }, summary: 'done' }))
    expect(bag).toEqual({ noteUrl: 'https://x/1', summary: 'done' })
  })

  it('truncates a summary that was really a whole article', () => {
    const bag = buildUpstream(parentRun({ summary: 'x'.repeat(MAX_OUTPUT_STRING * 3) }))
    const summary = bag['summary'] as string
    expect(summary.length).toBeLessThan(MAX_OUTPUT_STRING * 2)
    expect(summary).toContain('not persisted')
  })
})

describe('clampHandoffBag', () => {
  it('keeps only the names the task declared', () => {
    const clamped = clampHandoffBag({ noteUrl: 'u', title: 't', body: 'b' }, ['noteUrl'])
    expect(clamped).toEqual({ noteUrl: 'u' })
  })

  it('keeps the whole bag when nothing was declared', () => {
    expect(clampHandoffBag({ noteUrl: 'u', title: 't' })).toEqual({ noteUrl: 'u', title: 't' })
  })

  it('never hands a credential to the next task', () => {
    const clamped = clampHandoffBag({ cookie: 'secret-value', noteUrl: 'u' })
    expect(clamped).toEqual({ noteUrl: 'u' })
  })

  it('caps the number of keys and the size of each value', () => {
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < MAX_OUTPUT_KEYS * 3; i += 1) wide[`k${i}`] = 'v'
    expect(Object.keys(clampHandoffBag(wide) as object)).toHaveLength(MAX_OUTPUT_KEYS)

    const clamped = clampHandoffBag({ noteUrl: 'y'.repeat(MAX_OUTPUT_STRING * 2) })
    expect((clamped?.['noteUrl'] as string).length).toBeLessThan(MAX_OUTPUT_STRING * 2)
  })

  it('drops whole keys past the byte budget instead of storing a fat record', () => {
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < MAX_OUTPUT_KEYS; i += 1) wide[`k${i}`] = 'z'.repeat(MAX_OUTPUT_STRING)
    const clamped = clampHandoffBag(wide) as Record<string, unknown>
    expect(Object.keys(clamped).length).toBeLessThan(MAX_OUTPUT_KEYS)
  })

  it('returns undefined rather than an empty object', () => {
    expect(clampHandoffBag(undefined)).toBeUndefined()
    expect(clampHandoffBag({ cookie: 'x' })).toBeUndefined()
    expect(clampHandoffBag({ missing: undefined })).toBeUndefined()
  })
})

describe('resolveTaskInputs', () => {
  const upstream = { noteUrl: 'https://xhs/1', summary: 'published' }

  it('replaces upstream references in variables and in the prompt', () => {
    const resolved = resolveTaskInputs(
      {
        variables: { note: '{{upstream.noteUrl}}', count: 3, list: ['{{upstream.summary}}'] },
        prompt: 'Comment on {{upstream.noteUrl}} and say {{upstream.summary}}.',
      },
      upstream,
    )
    expect(resolved.variables).toEqual({ note: 'https://xhs/1', count: 3, list: ['published'] })
    expect(resolved.prompt).toBe('Comment on https://xhs/1 and say published.')
    expect(resolved.unresolved.tokens).toEqual([])
  })

  it('counts ONLY unresolved upstream tokens as missing', () => {
    const resolved = resolveTaskInputs(
      {
        prompt: 'Reply on {{upstream.noteId}} with {"json": {{upstream.noteUrl}}} done {{refData}}',
      },
      upstream,
    )
    expect(resolved.unresolved.tokens).toEqual(['upstream.noteId'])
    // Other braces survive verbatim, exactly as the engine leaves them: tasks
    // written today embed literal JSON in their prompts.
    expect(resolved.prompt).toContain('{{refData}}')
    expect(resolved.unresolved.availableKeys).toEqual(['noteUrl', 'summary'])
  })

  it('leaves a task with no stored inputs untouched', () => {
    const resolved = resolveTaskInputs({}, upstream)
    expect(resolved.variables).toBeUndefined()
    expect(resolved.prompt).toBeUndefined()
    expect(resolved.unresolved.tokens).toEqual([])
  })
})

describe('describeUnresolved', () => {
  it('names the token, the parent and the keys the parent did produce', () => {
    const text = describeUnresolved(
      { tokens: ['upstream.noteUrl'], availableKeys: ['title'] },
      'Publish note',
      parentRun({ outputs: { title: 't' } }),
    )
    expect(text).toContain('{{upstream.noteUrl}}')
    expect(text).toContain('Publish note')
    expect(text).toContain('title')
    // Values are never quoted back — only their shape.
    expect(text).not.toContain('"t"')
  })

  it('says plainly when the parent recorded nothing at all', () => {
    const text = describeUnresolved({ tokens: ['upstream.x'], availableKeys: [] }, 'P')
    expect(text).toContain('no handoff keys')
  })
})
