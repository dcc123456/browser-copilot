import { describe, expect, it } from 'vitest'

import { reviewStepsOf } from '../src/lib/workflow/review-patch'
import { workflowFromHistory } from '../src/lib/storage'
import type { HistoryEntry } from '../src/lib/types'

type Args = Record<string, unknown>

let seq = 0
function entry(action: string, args?: Args, host?: string): HistoryEntry {
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
    ...(host ? { host } : {}),
  }
}

const blockIds = (entries: HistoryEntry[]): (string | undefined)[] =>
  reviewStepsOf(workflowFromHistory(entries, 'wf')!).map((step) => step.blockId)

describe('reviewStepsOf grouping', () => {
  it('attaches the auto wait to the navigation step before it', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://a.com' }),
        entry('click', { target: { primary: { how: 'css', value: '.go' } } }),
      ],
      'wf',
    )!
    const steps = reviewStepsOf(wf)
    expect(steps.map((s) => s.blockId)).toEqual(['new-tab', 'event-click'])
    // The satellite is the wait-connections node the generator inserted.
    const waitNode = wf.drawflow.nodes.find((n) => n.data.blockId === 'wait-connections')!
    expect(steps[0]!.satelliteIds).toContain(waitNode.id)
    expect(steps[1]!.satelliteIds).toEqual([])
  })

  it('pairs the AI prefill agent with the forms step that consumes it', () => {
    const steps = reviewStepsOf(
      workflowFromHistory(
        [
          entry('fill', {
            target: { primary: { how: 'css', value: '#bio' } },
            value: '一段超过二十四个字符的自我介绍文本内容',
            generated: true,
          }),
        ],
        'wf',
      )!,
    )
    expect(steps).toHaveLength(1)
    expect(steps[0]!.blockId).toBe('forms')
    expect(steps[0]!.satelliteIds).toHaveLength(1)
    expect(steps[0]!.satelliteSummary[0]).toContain('AI 生成表单内容')
  })

  it('groups the whole OCR cluster (set-variable + ocr) onto the consuming forms step', () => {
    const steps = reviewStepsOf(
      workflowFromHistory(
        [
          entry('recognize_image', { image: 'https://x.com/c.png', prompt: '识别验证码' }),
          entry('fill', { target: { primary: { how: 'css', value: '#code' } }, value: 'ab12' }),
        ],
        'wf',
      )!,
    )
    expect(steps).toHaveLength(1)
    expect(steps[0]!.blockId).toBe('forms')
    expect(steps[0]!.satelliteIds).toHaveLength(2)
    expect(steps[0]!.satelliteSummary.join('；')).toContain('记录识别图片地址')
  })

  it('groups page-level OCR with its extraction agent onto the forms step', () => {
    const steps = reviewStepsOf(
      workflowFromHistory(
        [
          entry('recognize_image', { prompt: '页面上有什么数字' }),
          entry('fill', { target: { primary: { how: 'css', value: '#code' } }, value: 'ab12' }),
        ],
        'wf',
      )!,
    )
    expect(steps).toHaveLength(1)
    expect(steps[0]!.blockId).toBe('forms')
    expect(steps[0]!.satelliteIds).toHaveLength(2)
  })

  it('attaches a wait to the click even when a recognition cluster follows', () => {
    const steps = reviewStepsOf(
      workflowFromHistory(
        [
          entry(
            'click',
            { target: { primary: { how: 'css', value: '.submit' } } },
            'https://a.com',
          ),
          entry(
            'recognize_image',
            { image: 'https://x.com/c.png', prompt: '识别验证码' },
            'https://b.com',
          ),
          entry(
            'fill',
            { target: { primary: { how: 'css', value: '#code' } }, value: 'ab12' },
            'https://b.com',
          ),
        ],
        'wf',
      )!,
    )
    expect(steps.map((s) => s.blockId)).toEqual(['event-click', 'forms'])
    // The wait belongs to the CLICK (page change), never to the later OCR row.
    expect(steps[0]!.satelliteSummary.join('；')).toContain('等待页面加载')
    expect(steps[1]!.satelliteIds).toHaveLength(2)
  })

  it('keeps a consumer-less ocr as its own step and excludes the trigger', () => {
    expect(
      blockIds([
        entry('recognize_image', {
          target: { primary: { how: 'css', value: 'img.captcha' } },
          prompt: '读一下',
        }),
      ]),
    ).toEqual(['ocr'])
  })

  it('maps plain actions to one primary step each', () => {
    expect(
      blockIds([
        entry('open_url', { url: 'https://a.com' }),
        entry('scroll', { mode: 'bottom' }),
        entry('press_key', { key: 'Enter' }),
      ]),
    ).toEqual(['new-tab', 'element-scroll', 'press-key'])
  })
})
