/**
 * The re-record boundary of a generated chain.
 *
 * A generated chain was recorded by really operating the page, so every step
 * already happened once. What decides whether a step may happen again is what
 * it COMMITTED — and the commit test must be the same one the trial uses to
 * decide where to stop, or the two would disagree about which steps are safe.
 *
 * @module tests/rerun-policy
 */
import { describe, expect, it } from 'vitest'
import { safeRerunBoundaryOf } from '../src/lib/workflow/rerun-policy'
import type { WorkflowNode } from '../src/lib/workflow/types'

function node(
  blockId: string,
  data: Record<string, unknown> = {},
  id = `${blockId}-${Math.random().toString(36).slice(2, 8)}`,
): WorkflowNode {
  return {
    id,
    label: blockId,
    position: { x: 0, y: 0 },
    data: { blockId, ...data },
  }
}

/** A step whose prose says what it does — how a generated step records itself. */
function step(
  blockId: string,
  description: string,
  data: Record<string, unknown> = {},
  id?: string,
) {
  return node(blockId, { description, ...data }, id)
}

const TRIGGER = node('trigger', { type: 'manual' }, 'trigger-1')

describe('safeRerunBoundaryOf', () => {
  it("returns the last step before the chain's first commit", () => {
    const open = step('click', '打开草稿箱', {}, 'open')
    const fill = step('forms', '填写正文', { action: 'fill' }, 'fill')
    const save = step('click', '点击保存草稿', {}, 'save')

    const boundary = safeRerunBoundaryOf([TRIGGER, open, fill, save])

    expect(boundary?.nodeId).toBe('fill')
    expect(boundary?.label).toBe('forms')
    expect(boundary?.firstCommitNodeId).toBe('save')
  })

  it('treats a draft save as a commit even though the verb is not a submit', () => {
    const fill = step('forms', '填写正文', { action: 'fill' }, 'fill')
    const save = step('click', '点击暂存草稿', {}, 'save')

    const boundary = safeRerunBoundaryOf([fill, save])

    expect(boundary?.nodeId).toBe('fill')
    expect(boundary?.firstCommitNodeId).toBe('save')
  })

  it('treats a script that writes to a server as a commit', () => {
    const read = step('read-page', '读取当前页面', {}, 'read')
    const post = step(
      'javascript-code',
      '把结果提交到接口',
      { code: "await fetch('https://example.com/api', { method: 'POST' })" },
      'post',
    )

    const boundary = safeRerunBoundaryOf([read, post])

    expect(boundary?.nodeId).toBe('read')
    expect(boundary?.firstCommitNodeId).toBe('post')
  })

  it('leaves a script that only edits the page re-runnable', () => {
    const draw = step(
      'javascript-code',
      '在画布上画一张图',
      { code: "const c = document.createElement('canvas'); document.body.append(c)" },
      'draw',
    )
    const after = step('read-page', '确认画布已生成', {}, 'after')

    const boundary = safeRerunBoundaryOf([draw, after])

    expect(boundary?.nodeId).toBe('after')
    expect(boundary?.firstCommitNodeId).toBeUndefined()
  })

  it('has no boundary when the first action already commits', () => {
    const post = step('webhook', '发送通知', { url: 'https://example.com' }, 'post')
    expect(safeRerunBoundaryOf([TRIGGER, post])).toBeUndefined()
  })

  it('has no boundary for an empty chain or a chain of triggers only', () => {
    expect(safeRerunBoundaryOf([])).toBeUndefined()
    expect(safeRerunBoundaryOf([TRIGGER])).toBeUndefined()
  })

  it('returns the last node when nothing in the chain commits', () => {
    const read = step('read-page', '读取标题', {}, 'read')
    const scroll = step('element-scroll', '滚动到列表底部', {}, 'scroll')
    const boundary = safeRerunBoundaryOf([TRIGGER, read, scroll])
    expect(boundary?.nodeId).toBe('scroll')
  })

  it('never names the trigger as the boundary', () => {
    const save = step('click', '点击保存草稿', {}, 'save')
    expect(safeRerunBoundaryOf([TRIGGER, save])).toBeUndefined()
  })

  it("carries the step's intent so a prompt can name it", () => {
    const fill = step('forms', '填写标题', { action: 'fill' }, 'fill')
    const save = step('click', '点击保存草稿', {}, 'save')
    expect(safeRerunBoundaryOf([fill, save])?.intent).toBe('填写标题')
  })

  it('respects an explicit idempotency contract over the block default', () => {
    const before = step('read-page', '读取当前正文', {}, 'before')
    const contracted = node(
      'forms',
      { description: '填写正文', action: 'fill', __reliability: { idempotency: 'unsafe' } },
      'contracted',
    )
    const after = step('read-page', '确认已填好', {}, 'after')
    const boundary = safeRerunBoundaryOf([before, contracted, after])
    expect(boundary?.nodeId).toBe('before')
    expect(boundary?.firstCommitNodeId).toBe('contracted')
  })
})
