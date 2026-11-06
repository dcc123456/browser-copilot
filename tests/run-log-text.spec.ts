/**
 * "Copy logs" serializes the trace the user is looking at into plain text. The
 * formatter must keep the block boundaries, error markers, and captured
 * variables readable even when the clipboard path itself works (there is no
 * clipboard in a node test, so the formatting is the testable half).
 */
import { describe, expect, it } from 'vitest'
import { buildTrace, formatRunLogText, type RunView } from '../src/workflow-editor/sidebar/log-view'

const START = Date.UTC(2026, 10, 6, 1, 2, 3)

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: 'run-1',
    label: '抓取标题',
    source: 'manual',
    startedAt: START,
    finishedAt: START + 2_000,
    outcome: 'failed',
    steps: [],
    ...overrides,
  }
}

describe('formatRunLogText', () => {
  it('writes a header, each block, and its output lines', () => {
    const view = run({
      summary: '2 步完成',
      error: 'selector not found',
      steps: [
        { at: START, kind: 'status', text: '开始运行' },
        {
          at: START + 100,
          kind: 'tool',
          nodeId: 'n1',
          label: '打开页面',
          text: '打开页面',
          vars: { url: 'https://x.test', page: { id: 3 } },
        },
        { at: START + 150, kind: 'result', text: '已打开 https://x.test', nodeId: 'n1' },
        { at: START + 200, kind: 'error', text: '点击失败', nodeId: 'n1' },
      ],
    })

    const text = formatRunLogText(view, buildTrace(view))
    const lines = text.split('\n')

    expect(lines[0]).toBe('抓取标题 (run-1)')
    expect(lines[1]).toContain('failed')
    expect(text).toContain('2 步完成')
    expect(text).toContain('Error: selector not found')
    expect(text).toContain('开始运行')
    expect(text).toContain('打开页面')
    expect(text).toContain('  已打开 https://x.test')
    expect(text).toContain('! 点击失败')
    expect(text).toContain('vars: {"url":"https://x.test","page":{"id":3}}')
  })

  it('serializes only the entries it is given, so a filtered copy stays filtered', () => {
    const view = run({ steps: [] })
    const kept = buildTrace(
      run({
        steps: [
          { at: START, kind: 'tool', nodeId: 'n1', label: '保留', text: '保留' },
          { at: START + 10, kind: 'result', text: 'kept', nodeId: 'n1' },
          { at: START + 20, kind: 'tool', nodeId: 'n2', label: '过滤掉', text: '过滤掉' },
          { at: START + 30, kind: 'result', text: 'dropped', nodeId: 'n2' },
        ],
      }),
    ).filter((entry) => entry.label === '保留')

    const text = formatRunLogText(view, kept)
    expect(text).toContain('保留')
    expect(text).toContain('kept')
    expect(text).not.toContain('过滤掉')
    expect(text).not.toContain('dropped')
  })

  it('survives a cyclic variable instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic['self'] = cyclic
    const view = run({
      steps: [
        {
          at: START,
          kind: 'tool',
          nodeId: 'n1',
          label: '循环变量',
          text: '循环变量',
          vars: cyclic,
        },
        { at: START + 10, kind: 'result', text: '仍然写出这一行', nodeId: 'n1' },
      ],
    })

    const text = formatRunLogText(view, buildTrace(view))
    expect(text).toContain('循环变量')
    expect(text).toContain('仍然写出这一行')
  })
})
