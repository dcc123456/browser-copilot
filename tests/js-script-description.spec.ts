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

import { describeJsScript, workflowFromHistory } from '../src/lib/storage'
import type { HistoryEntry } from '../src/lib/types'

/**
 * A generated `javascript-code` node must say in plain language what the script
 * does — the user reviewing a conversation-built workflow decides from that
 * description whether the node is worth keeping.
 */
describe('describeJsScript', () => {
  it('describes a click, including the element it targets', () => {
    const text = describeJsScript(`document.querySelector('#sign-in').click()`)
    expect(text).toContain('点击页面元素')
    expect(text).toContain('#sign-in')
  })

  it('describes a form fill including the written value', () => {
    expect(describeJsScript(`document.querySelector('#phone').value = '13800138000'`)).toBe(
      '把「13800138000」填进输入框（#phone）',
    )
  })

  it('describes a React-compatible write as such', () => {
    const code = [
      "const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set",
      "setter.call(document.querySelector('#code'), '1234')",
    ].join('\n')
    const text = describeJsScript(code)
    expect(text).toContain('填进输入框')
    expect(text).toContain('兼容 React')
  })

  it('describes navigation, storage, network and event effects', () => {
    expect(describeJsScript(`location.href = 'https://example.com/checkin'`)).toContain(
      '跳转到指定网址',
    )
    expect(describeJsScript(`localStorage.setItem('done', '1')`)).toContain('读写浏览器本地存储')
    expect(describeJsScript(`await fetch('/api/checkin', { method: 'POST' })`)).toContain(
      '请求后端接口',
    )
    expect(
      describeJsScript(`el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`),
    ).toContain('模拟用户操作')
  })

  it('combines several effects but stays bounded', () => {
    const code = [
      "document.querySelector('#a').value = 'x'",
      "document.querySelector('#b').click()",
      'location.reload()',
      "localStorage.setItem('k', 'v')",
    ].join('\n')
    const text = describeJsScript(code)
    expect(text).toContain('填进输入框')
    expect(text).toContain('点击页面元素')
    // At most three effects are spelled out.
    expect(text.split('，')).toHaveLength(3)
  })

  it('summarises a multi-field write as a batch', () => {
    const code = `document.querySelector('#a').value = '1'; document.querySelector('#b').value = '2'`
    expect(describeJsScript(code)).toBe('批量填写多个输入框')
  })

  it('returns an empty string when nothing recognizable is found', () => {
    expect(describeJsScript(`const a = 1 + 1`)).toBe('')
    expect(describeJsScript('   ')).toBe('')
  })
})

describe('workflowFromHistory javascript-code descriptions', () => {
  function entry(action: string, args: Record<string, unknown>): HistoryEntry {
    return {
      id: `e-${action}`,
      at: 1,
      conversationId: 'conv-1',
      action,
      summary: 'Run JavaScript in the page',
      approved: true,
      ok: true,
      args,
    }
  }

  function jsNodeOf(entries: HistoryEntry[]) {
    const wf = workflowFromHistory(entries, '豆奶签到')
    expect(wf).not.toBeNull()
    return wf!.drawflow.nodes.find((node) => node.data?.['blockId'] === 'javascript-code')
  }

  it('uses the plain-language description instead of the raw code', () => {
    const node = jsNodeOf([
      entry('run_javascript', { code: `document.querySelector('#checkin').click()` }),
    ])
    expect(node?.data?.['description']).toContain('点击页面元素')
  })

  it('keeps an author comment that already explains the script', () => {
    const node = jsNodeOf([
      entry('run_javascript', {
        code: `// 点击每日签到按钮\nawait fetch('/checkin')`,
      }),
    ])
    expect(node?.data?.['description']).toBe('点击每日签到按钮')
  })

  it('ignores a content-free step marker and falls back to the behaviour', () => {
    const node = jsNodeOf([entry('run_javascript', { code: `// step 2\ndocument.querySelector('#x').click()` })])
    expect(node?.data?.['description']).toContain('点击页面元素')
  })

  it('falls back to the first statement when no effect is recognizable', () => {
    const node = jsNodeOf([entry('run_javascript', { code: `const answer = 40 + 2` })])
    expect(node?.data?.['description']).toBe('const answer = 40 + 2')
  })
})
