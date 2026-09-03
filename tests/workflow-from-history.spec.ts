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
  aiPrefillSteps,
  applyAiPrefillOptions,
  fillLikeJsFromCode,
  looksTextExtractionPrompt,
  workflowFromHistory,
} from '../src/lib/storage'
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

/** Flat catalog data of every action node (trigger excluded), in workflow order. */
const actionData = (entries: HistoryEntry[], name = 'wf') =>
  (workflowFromHistory(entries, name)?.drawflow.nodes ?? [])
    .filter((n) => n.data.blockId !== 'trigger')
    .map((n) => n.data)

describe('selectorFromArgs target synthesis', () => {
  it("how:'css' keeps the trimmed selector", () => {
    expect(actionData([entry('click', { target: { primary: { how: 'css', value: ' .btn ' } } })])).toEqual([
      {
        blockId: 'event-click',
        description: '',
        selector: '.btn',
        findBy: 'cssSelector',
        target: { primary: { how: 'css', value: ' .btn ' } },
      },
    ])
  })

  it("how:'id' yields a #id selector", () => {
    expect(actionData([entry('click', { target: { primary: { how: 'id', value: 'submit' } } })])).toEqual([
      {
        blockId: 'event-click',
        description: '',
        selector: '#submit',
        findBy: 'cssSelector',
        target: { primary: { how: 'id', value: 'submit' } },
      },
    ])
  })

  it("how:'name' yields a [name=...] selector", () => {
    expect(actionData([entry('click', { target: { primary: { how: 'name', value: 'q' } } })])).toEqual([
      {
        blockId: 'event-click',
        description: '',
        selector: '[name="q"]',
        findBy: 'cssSelector',
        target: { primary: { how: 'name', value: 'q' } },
      },
    ])
  })

  it("how:'testid' yields a [data-testid=...] selector", () => {
    expect(actionData([entry('click', { target: { primary: { how: 'testid', value: 'x' } } })])).toEqual([
      {
        blockId: 'event-click',
        description: '',
        selector: '[data-testid="x"]',
        findBy: 'cssSelector',
        target: { primary: { how: 'testid', value: 'x' } },
      },
    ])
  })
})

describe('args fall through to flat block data', () => {
  it('fill combines a synthesized selector with a literal value (no legacy values bag)', () => {
    const wf = workflowFromHistory(
      [entry('fill', { target: { primary: { how: 'id', value: 'n' } }, value: 'abc' })],
      'wf',
    )
    // 1 trigger + 1 action
    expect(wf?.drawflow.nodes).toHaveLength(2)
    const data = wf!.drawflow.nodes[1]!.data
    expect(data).toEqual({
      blockId: 'forms',
      description: '',
      selector: '#n',
      findBy: 'cssSelector',
      type: 'text-field',
      value: 'abc',
      clearValue: true,
      target: { primary: { how: 'id', value: 'n' } },
    })
    // The editor reads `selector`/`findBy` — the legacy `values` bag must stay gone.
    expect(data).not.toHaveProperty('values')
  })

  it('press_key carries through the key', () => {
    expect(actionData([entry('press_key', { key: 'Enter' })])).toEqual([
      { blockId: 'press-key', description: 'press_key', key: 'Enter' },
    ])
  })

  it('scroll maps mode/y to scrollX/scrollY (a target, if any, is not attached)', () => {
    expect(
      actionData([
        entry('scroll', { mode: 'by', y: 100, target: { primary: { how: 'css', value: '.x' } } }),
      ]),
    ).toEqual([{ blockId: 'element-scroll', description: '', scrollX: 0, scrollY: 100 }])
  })

  it('wait_for becomes a delay block carrying the timeout as delay time', () => {
    expect(
      actionData([
        entry('wait_for', { target: { primary: { how: 'css', value: '.a' } }, timeout: 3000 }),
      ]),
    ).toEqual([{ blockId: 'delay', description: '', time: 3000 }])
  })

  it('tab_switch carries the index', () => {
    expect(actionData([entry('tab_switch', { index: 2 })])).toEqual([
      { blockId: 'switch-tab', description: 'tab_switch', index: 2 },
    ])
  })

  it('open_url becomes new-tab plus a trailing page-load wait', () => {
    expect(actionData([entry('open_url', { url: 'https://e.com' })])).toEqual([
      { blockId: 'new-tab', description: 'open_url', url: 'https://e.com', waitTabLoaded: true },
      { blockId: 'wait-connections', description: '等待页面加载', timeout: 10000 },
    ])
  })
})

describe('trigger node', () => {
  it('prepends a manual trigger node connected to the first action', () => {
    const wf = workflowFromHistory(
      [entry('click', { target: { primary: { how: 'css', value: '.btn' } } })],
      'wf',
    )
    expect(wf).not.toBeNull()
    // trigger + 1 action
    expect(wf!.drawflow.nodes).toHaveLength(2)
    expect(wf!.drawflow.edges).toHaveLength(1)
    expect(wf!.drawflow.nodes[0]!.data.blockId).toBe('trigger')
    expect(wf!.drawflow.nodes[0]!.data.type).toBe('manual')
    expect(wf!.drawflow.edges[0]!.source).toBe(wf!.drawflow.nodes[0]!.id)
    expect(wf!.drawflow.edges[0]!.target).toBe(wf!.drawflow.nodes[1]!.id)
  })
})

describe('page-load wait insertion', () => {
  it('always appends the wait after navigation; a same-host click adds no second wait', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://a.com' }),
        entry('click', { target: { primary: { how: 'css', value: '.btn' } } }, 'a.com'),
      ],
      'wf',
    )
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'new-tab',
      'wait-connections',
      'event-click',
    ])
  })

  it('clicks add the wait only when the host changes mid-flow', () => {
    const wf = workflowFromHistory(
      [
        entry('click', { target: { primary: { how: 'css', value: '.a' } } }, 'a.com'),
        entry('click', { target: { primary: { how: 'css', value: '.b' } } }, 'b.com'),
      ],
      'wf',
    )
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'event-click',
      'wait-connections',
      'event-click',
    ])
    expect(wf!.drawflow.nodes[2]!.data).toEqual({
      blockId: 'wait-connections',
      description: '等待页面加载',
      timeout: 10000,
    })
  })

  it('clicks on the same host stay wait-free', () => {
    const wf = workflowFromHistory(
      [
        entry('click', { target: { primary: { how: 'css', value: '.a' } } }, 'a.com'),
        entry('click', { target: { primary: { how: 'css', value: '.b' } } }, 'a.com'),
      ],
      'wf',
    )
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual(['trigger', 'event-click', 'event-click'])
  })
})

describe('unmapped actions', () => {
  it('returns null when nothing is mappable', () => {
    expect(workflowFromHistory([entry('read_current_page', {})], 'wf')).toBeNull()
  })

  it('skips unmapped actions and links the mapped ones in order', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://e.com' }),
        entry('read_current_page', {}),
        entry('click', { target: { primary: { how: 'testid', value: 'x' } } }),
      ],
      'wf',
    )
    expect(wf).not.toBeNull()
    // trigger + new-tab + wait + click = 4
    expect(wf!.drawflow.nodes).toHaveLength(4)
    // trigger→new-tab→wait→click = 3
    expect(wf!.drawflow.edges).toHaveLength(3)
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'new-tab',
      'wait-connections',
      'event-click',
    ])
    // Edges chain every node in order
    wf!.drawflow.edges.forEach((edge, i) => {
      expect(edge.source).toBe(wf!.drawflow.nodes[i]!.id)
      expect(edge.target).toBe(wf!.drawflow.nodes[i + 1]!.id)
    })
  })
})

describe('duplicate collapsing', () => {
  it('collapses consecutive open_url calls to the same URL into one block (with its wait)', () => {
    // Reproduces the saved workflow where the model opened the same URL twice
    // (e.g. once to navigate and again after a re-read). A replayable workflow
    // only needs the navigation once.
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://github.com/pulls/review-requested' }),
        entry('read_current_page', {}),
        entry('open_url', { url: 'https://github.com/pulls/review-requested' }),
      ],
      'prs',
    )
    expect(wf).not.toBeNull()
    const actionNodes = wf!.drawflow.nodes.filter((n) => n.data.blockId !== 'trigger')
    expect(actionNodes).toHaveLength(2)
    expect(actionNodes[0]!.data).toEqual({
      blockId: 'new-tab',
      description: 'open_url',
      url: 'https://github.com/pulls/review-requested',
      waitTabLoaded: true,
    })
    expect(actionNodes[1]!.data).toEqual({
      blockId: 'wait-connections',
      description: '等待页面加载',
      timeout: 10000,
    })
  })

  it('keeps two open_url calls when the URLs differ (each with its own wait)', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://a.com' }),
        entry('open_url', { url: 'https://b.com' }),
      ],
      'wf',
    )
    // trigger + 2 × (new-tab + wait)
    expect(wf!.drawflow.nodes).toHaveLength(5)
    expect(
      wf!.drawflow.nodes.filter((n) => n.data.blockId === 'new-tab').map((n) => n.data.url),
    ).toEqual(['https://a.com', 'https://b.com'])
  })

  it('collapses two clicks on the same selector but keeps clicks on different ones', () => {
    const wf = workflowFromHistory(
      [
        entry('click', { target: { primary: { how: 'css', value: '.a' } } }),
        entry('click', { target: { primary: { how: 'css', value: '.a' } } }),
        entry('click', { target: { primary: { how: 'css', value: '.b' } } }),
      ],
      'wf',
    )
    expect(
      wf!.drawflow.nodes
        .filter((n) => n.data.blockId !== 'trigger')
        .map((n) => n.data.selector),
    ).toEqual(['.a', '.b'])
  })

  it('keeps only the last value when the same field is filled twice', () => {
    const wf = workflowFromHistory(
      [
        entry('fill', { target: { primary: { how: 'id', value: 'q' } }, value: 'one' }),
        entry('fill', { target: { primary: { how: 'id', value: 'q' } }, value: 'two' }),
      ],
      'wf',
    )
    // trigger + 1 forms node (the last fill wins)
    expect(wf!.drawflow.nodes).toHaveLength(2)
    expect(wf!.drawflow.nodes[1]!.data).toEqual({
      blockId: 'forms',
      description: '',
      selector: '#q',
      findBy: 'cssSelector',
      type: 'text-field',
      value: 'two',
      clearValue: true,
      target: { primary: { how: 'id', value: 'q' } },
    })
  })
})

describe('run_javascript maps to the javascript-code block', () => {
  it('carries the code and the catalog timeout', () => {
    expect(actionData([entry('run_javascript', { code: 'return document.title' })])).toEqual([
      {
        blockId: 'javascript-code',
        description: 'run_javascript',
        code: 'return document.title',
        timeout: 20000,
      },
    ])
  })

  it('keeps its place in the flow between mapped steps', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://e.com' }),
        entry('run_javascript', { code: 'return document.title' }),
      ],
      'wf',
    )
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'new-tab',
      'wait-connections',
      'javascript-code',
    ])
  })
})

describe('fill-shaped run_javascript becomes the forms operator', () => {
  it('a plain querySelector + value assignment converts', () => {
    const code =
      "document.querySelector('#email').value = 'a@b.com';\n" +
      "document.querySelector('#email').dispatchEvent(new Event('change', { bubbles: true }))"
    expect(fillLikeJsFromCode(code)).toEqual({ selector: '#email', value: 'a@b.com' })
    expect(actionData([entry('run_javascript', { code })])).toEqual([
      {
        blockId: 'forms',
        description: '',
        selector: '#email',
        findBy: 'cssSelector',
        type: 'text-field',
        value: 'a@b.com',
        clearValue: true,
      },
    ])
  })

  it('the React native setter pattern converts', () => {
    const code = [
      "const el = document.querySelector('#phone')",
      "const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set",
      "setter.call(el, '13800000000')",
      "el.dispatchEvent(new Event('input', { bubbles: true }))",
    ].join('\n')
    expect(fillLikeJsFromCode(code)).toEqual({ selector: '#phone', value: '13800000000' })
  })

  it('getElementById maps to an #id selector', () => {
    expect(fillLikeJsFromCode("document.getElementById('pw').value = 's3cret'")).toEqual({
      selector: '#pw',
      value: 's3cret',
    })
  })

  it('guards keep ambiguous snippets as javascript-code', () => {
    // a click makes it more than a fill
    expect(
      fillLikeJsFromCode("const el = document.querySelector('#a'); el.click(); el.value = 'x'"),
    ).toBeNull()
    // two fields in one snippet
    const twoFields =
      "document.querySelector('#a').value = '1'; document.querySelector('#b').value = '2'"
    expect(fillLikeJsFromCode(twoFields)).toBeNull()
    // variable value — not a literal
    expect(fillLikeJsFromCode("document.querySelector('#a').value = txt")).toBeNull()
    // template interpolation — not a literal
    expect(fillLikeJsFromCode("document.querySelector('#a').value = `${v}`")).toBeNull()
    // form.submit guard
    expect(fillLikeJsFromCode("document.querySelector('#f').submit()")).toBeNull()
    // the workflow keeps the verbatim JS block for guarded snippets
    expect(actionData([entry('run_javascript', { code: twoFields })])).toEqual([
      {
        blockId: 'javascript-code',
        description: 'run_javascript',
        code: twoFields,
        timeout: 20000,
      },
    ])
  })
})

describe('recognize_image maps to the ocr block', () => {
  it('a selector becomes an element capture carrying the selector', () => {
    expect(actionData([entry('recognize_image', { selector: '#captcha' })])).toEqual([
      {
        blockId: 'ocr',
        description: '',
        source: 'element',
        selector: '#captcha',
        findBy: 'cssSelector',
        preprocess: true,
        variableName: 'lastOcrText',
      },
    ])
  })

  it('no selector falls back to the page snapshot plus an AI extraction step', () => {
    expect(actionData([entry('recognize_image', { prompt: '读出图中的验证码' })])).toEqual([
      {
        blockId: 'ocr',
        description: 'recognize_image',
        source: 'page',
        selector: '',
        findBy: 'cssSelector',
        // Whole-page shots skip the captcha preprocess: it is tuned for small
        // images and binarizing a full page washes the text out.
        preprocess: false,
        variableName: 'lastOcrText',
      },
      {
        blockId: 'ai-agent',
        description: '提取 OCR 中的关键信息',
        purpose: 'ocr-extract',
        prompt: expect.stringContaining('读出图中的验证码'),
        findBy: 'cssSelector',
        selector: '',
        actOnPage: false,
        useSnapshot: false,
        maxToolRounds: 8,
        variableName: 'ocrExtract1',
      },
    ])
    // The extraction prompt feeds the raw OCR dump to the agent.
    const prompt = actionData([entry('recognize_image', { prompt: '读出图中的验证码' })])[1]!
      .prompt as string
    expect(prompt).toContain('{{lastOcrText}}')
    expect(prompt).toContain('只输出结果本身')
  })

  it('a transient data-URL image arg is not persisted into the workflow', () => {
    const data = actionData([
      entry('recognize_image', { image: 'data:image/png;base64,AAAA', selector: '#captcha' }),
    ])[0]!
    expect(data).not.toHaveProperty('image')
    expect(data['source']).toBe('element')
  })

  it('keeps its place in the flow between mapped steps', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://e.com' }),
        entry('recognize_image', { selector: '#captcha' }),
        entry('fill', { target: { primary: { how: 'id', value: 'code' } }, value: 'AB12' }),
      ],
      'wf',
    )
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'new-tab',
      'wait-connections',
      'ocr',
      'forms',
    ])
  })
})

describe('rich conversation targets', () => {
  it('role-targeted clicks keep an empty selector plus the verbatim target', () => {
    const target = {
      primary: { how: 'role', value: '提交', role: 'button' },
      fallbacks: [{ how: 'text', value: '提交' }],
    }
    expect(actionData([entry('click', { target })])).toEqual([
      // selector is empty (role/text) — the description falls back to the
      // action summary so the canvas card still says something useful.
      { blockId: 'event-click', description: 'click', selector: '', findBy: 'cssSelector', target },
    ])
  })

  it('an into_view scroll keeps its element target even without a CSS selector', () => {
    const target = { primary: { how: 'role', value: '列表', role: 'region' }, fallbacks: [] }
    expect(actionData([entry('scroll', { mode: 'into_view', target })])).toEqual([
      {
        blockId: 'element-scroll',
        description: 'scroll',
        selector: '',
        findBy: 'cssSelector',
        scrollIntoView: true,
        target,
      },
    ])
  })
})

describe('a fill after recognize_image references the OCR variable', () => {
  it('a short captcha token links {{lastOcrText}}', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://e.com' }),
        entry('recognize_image', { selector: '#captcha' }),
        entry('fill', { target: { primary: { how: 'id', value: 'code' } }, value: 'AB12' }),
      ],
      'wf',
    )
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'new-tab',
      'wait-connections',
      'ocr',
      'forms',
    ])
    const nodes = wf!.drawflow.nodes
    expect(nodes[nodes.length - 1]!.data.value).toBe('{{lastOcrText}}')
  })

  it('a JS-filled captcha token links the OCR variable too', () => {
    const wf = workflowFromHistory(
      [
        entry('recognize_image', { selector: '#captcha' }),
        entry('run_javascript', { code: "document.querySelector('#code').value = 'AB12'" }),
      ],
      'wf',
    )
    const nodes = wf!.drawflow.nodes
    expect(nodes.map((n) => n.data.blockId)).toEqual(['trigger', 'ocr', 'forms'])
    expect(nodes[nodes.length - 1]!.data.value).toBe('{{lastOcrText}}')
    expect(nodes[nodes.length - 1]!.data.selector).toBe('#code')
  })

  it('long composed content keeps the AI prefill path', () => {
    const value = '这是一段由模型自行撰写的、超过短 token 限制的长文本回复内容。'
    const wf = workflowFromHistory(
      [
        entry('recognize_image', { selector: '#img' }),
        entry('fill', { target: { primary: { how: 'id', value: 'msg' } }, value }),
      ],
      'wf',
    )
    const nodes = wf!.drawflow.nodes
    expect(nodes.map((n) => n.data.blockId)).toEqual(['trigger', 'ocr', 'ai-agent', 'forms'])
    expect(nodes[nodes.length - 1]!.data.value).toBe('{{aiFill1}}')
  })
})

describe('text-extraction screenshots replay as the ocr operator', () => {
  it('a captcha-reading screenshot becomes an element-capture ocr node', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://e.com' }),
        entry('screenshot', { target: '#captchaImg', prompt: 'Read the captcha code in the image' }),
      ],
      'wf',
    )
    expect(wf!.drawflow.nodes.map((n) => n.data.blockId)).toEqual([
      'trigger',
      'new-tab',
      'wait-connections',
      'ocr',
    ])
    const nodes = wf!.drawflow.nodes
    const data = nodes[nodes.length - 1]!.data
    expect(data.source).toBe('element')
    expect(data.selector).toBe('#captchaImg')
    expect(data.variableName).toBe('lastOcrText')
  })

  it('visual-inspection screenshots stay unmapped', () => {
    expect(
      workflowFromHistory(
        [entry('screenshot', { target: '#btn', prompt: 'Is the submit button disabled?' })],
        'wf',
      ),
    ).toBeNull()
  })

  it('looksTextExtractionPrompt separates extraction from inspection', () => {
    expect(looksTextExtractionPrompt('读出图中的验证码')).toBe(true)
    expect(looksTextExtractionPrompt('What are the digits shown?')).toBe(true)
    expect(looksTextExtractionPrompt('这个按钮是什么颜色')).toBe(false)
    expect(looksTextExtractionPrompt('Is the layout correct?')).toBe(false)
  })
})

describe('generated edges carry block-keyed handles', () => {
  it('each edge references the rendered handle ids of its endpoints', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://e.com' }),
        entry('recognize_image', { selector: '#captcha' }),
        entry('fill', { target: { primary: { how: 'id', value: 'code' } }, value: 'AB12' }),
      ],
      'wf',
    )!
    const edges = wf.drawflow.edges
    // trigger→new-tab→wait-connections→ocr→forms
    expect(edges).toHaveLength(4)
    expect(edges[0]).toMatchObject({
      sourceHandle: 'trigger-output-1',
      targetHandle: 'new-tab-input-1',
    })
    expect(edges[1]).toMatchObject({
      sourceHandle: 'new-tab-output-1',
      targetHandle: 'wait-connections-input-1',
    })
    expect(edges[2]).toMatchObject({
      sourceHandle: 'wait-connections-output-1',
      targetHandle: 'ocr-input-1',
    })
    expect(edges[edges.length - 1]).toMatchObject({
      sourceHandle: 'ocr-output-1',
      targetHandle: 'forms-input-1',
    })
  })

  it('an ai-agent pre-node is also wired with explicit handles', () => {
    const wf = workflowFromHistory(
      [
        entry('fill', {
          target: { primary: { how: 'id', value: 'msg' } },
          value: '这是一段由模型自行撰写的、超过短 token 限制的长文本回复内容。',
        }),
      ],
      'wf',
    )!
    expect(wf.drawflow.edges).toHaveLength(2)
    expect(wf.drawflow.edges[0]).toMatchObject({
      sourceHandle: 'trigger-output-1',
      targetHandle: 'ai-agent-input-1',
    })
    expect(wf.drawflow.edges[1]).toMatchObject({
      sourceHandle: 'ai-agent-output-1',
      targetHandle: 'forms-input-1',
    })
  })
})

describe('a recognition through an http image URL replays via a variable', () => {
  it('stores the URL first, then reads it with the variable source', () => {
    expect(
      actionData([
        entry('recognize_image', { image: 'https://e.com/captcha.png?id=1', selector: '#captcha' }),
      ]),
    ).toEqual([
      {
        blockId: 'set-variable',
        description: '记录识别图片地址',
        variableName: 'lastOcrImage',
        value: 'https://e.com/captcha.png?id=1',
      },
      {
        blockId: 'ocr',
        description: '',
        source: 'variable',
        imageVariable: 'lastOcrImage',
        preprocess: true,
        variableName: 'lastOcrText',
      },
    ])
  })

  it('a data-URL image arg keeps the transient rule (no variable chain)', () => {
    const data = actionData([
      entry('recognize_image', { image: 'data:image/png;base64,AAAA', selector: '#captcha' }),
    ])
    expect(data).toHaveLength(1)
    expect(data[0]).not.toHaveProperty('imageVariable')
    expect(data[0]!.source).toBe('element')
  })
})

describe('the OCR hand-off survives pacing steps and mislabeled fills', () => {
  it('links across a wait_for between recognition and fill', () => {
    const wf = workflowFromHistory(
      [
        entry('recognize_image', { selector: '#captcha' }),
        entry('wait_for', { timeout: 2000 }),
        entry('fill', { target: { primary: { how: 'id', value: 'code' } }, value: 'X7k2' }),
      ],
      'wf',
    )!
    const nodes = wf.drawflow.nodes
    expect(nodes.map((n) => n.data.blockId)).toEqual(['trigger', 'ocr', 'delay', 'forms'])
    const forms = nodes[nodes.length - 1]!
    expect(forms.data.value).toBe('{{lastOcrText}}')
  })

  it('a short fill the model mislabeled generated:true still links the OCR variable', () => {
    const wf = workflowFromHistory(
      [
        entry('recognize_image', { selector: '#captcha' }),
        entry('fill', {
          target: { primary: { how: 'id', value: 'code' } },
          value: 'X7k2',
          generated: true,
        }),
      ],
      'wf',
    )!
    const nodes = wf.drawflow.nodes
    expect(nodes.map((n) => n.data.blockId)).toEqual(['trigger', 'ocr', 'forms'])
    expect(nodes[nodes.length - 1]!.data.value).toBe('{{lastOcrText}}')
  })
})

describe('a whole-page recognition routes its answer through AI extraction', () => {
  const entries = () => [
    entry('recognize_image', { prompt: '识别图中的验证码' }),
    entry('fill', { target: { primary: { how: 'id', value: 'code' } }, value: 'X7k2' }),
  ]

  it('the fill references the extraction variable, not the raw page dump', () => {
    const wf = workflowFromHistory(entries(), 'wf')!
    const nodes = wf.drawflow.nodes
    expect(nodes.map((n) => n.data.blockId)).toEqual(['trigger', 'ocr', 'ai-agent', 'forms'])
    expect(nodes[nodes.length - 1]!.data.value).toBe('{{ocrExtract1}}')
  })

  it('the extraction agent is not a save-card row and cannot be toggled off', () => {
    const wf = workflowFromHistory(entries(), 'wf')!
    expect(aiPrefillSteps(wf)).toEqual([])
    const formsId = wf.drawflow.nodes[wf.drawflow.nodes.length - 1]!.id
    const applied = applyAiPrefillOptions(wf, { [formsId]: false })
    const forms = applied.drawflow.nodes.find((n) => n.id === formsId)!
    expect(forms.data.value).toBe('{{ocrExtract1}}')
  })

  it('an element-scoped recognition needs no extraction step', () => {
    const wf = workflowFromHistory(
      [
        entry('recognize_image', { selector: '#captcha' }),
        entry('fill', { target: { primary: { how: 'id', value: 'code' } }, value: 'X7k2' }),
      ],
      'wf',
    )!
    expect(wf.drawflow.nodes.map((n) => n.data.blockId)).toEqual(['trigger', 'ocr', 'forms'])
    expect(wf.drawflow.nodes[wf.drawflow.nodes.length - 1]!.data.value).toBe('{{lastOcrText}}')
  })
})
